// ---------------------------------------------------------------------------
// analysis.ts — Workflow structural analysis (sections, error handlers, body nodes)
// ---------------------------------------------------------------------------

import {
  isSticky,
  DEFAULT_HEIGHT,
  STICKY_DEFAULT_WIDTH,
  STICKY_DEFAULT_HEIGHT,
  nodeWidth,
} from './nodes.js';
import type {
  N8nNode,
  N8nConnections,
  N8nWorkflow,
  Edge,
  Section,
} from '../types.js';
import type { WorkflowGraph } from './graph.js';

// ---------------------------------------------------------------------------
// WorkflowAnalysis — aggregated structural analysis result
// ---------------------------------------------------------------------------

export interface WorkflowAnalysis {
  /** Sticky-note sections with their member nodes (global handlers removed) */
  sections:              Section[];
  /** Names of nodes acting as global error handlers (span ≥2 sections) */
  globalHandlerNames:    Set<string>;
  /** Body nodes of SplitInBatches loops (placed at row≥1) */
  bodyNodes:             Set<string>;
  /** Section indices that are crossed by a cross-section edge (R10 indent) */
  crossIndentedSections: Set<number>;
  /** Orphan node names that are targets of cross-section backward edges (R12) */
  bypassNodeNames:       Set<string>;
  /** Layout nodes not assigned to any sticky section */
  orphans:               N8nNode[];
  /** Layout nodes that are global error handlers */
  globalHandlers:        N8nNode[];
}

// ---------------------------------------------------------------------------
// R4 — Sticky note group detection (pre-layout)
// ---------------------------------------------------------------------------

/**
 * For each sticky note, record which regular nodes currently sit inside its
 * bounding box.  Returns Map<stickyName, Set<nodeName>>.
 */
export function computeStickyGroups(nodes: N8nNode[]): Map<string, Set<string>> {
  const stickies = nodes.filter(isSticky);
  const regular  = nodes.filter(n => !isSticky(n));
  const groups   = new Map<string, Set<string>>();

  for (const s of stickies) {
    const sx = s.position[0];
    const sy = s.position[1];
    const sw = s.parameters?.width  ?? STICKY_DEFAULT_WIDTH;
    const sh = s.parameters?.height ?? STICKY_DEFAULT_HEIGHT;

    const members = new Set<string>();
    for (const r of regular) {
      const cx = r.position[0] + nodeWidth(r) / 2;
      const cy = r.position[1] + DEFAULT_HEIGHT / 2;
      if (cx >= sx && cx < sx + sw && cy >= sy && cy < sy + sh) {
        members.add(r.name);
      }
    }
    groups.set(s.name, members);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// R11 — Global error handler detection
// ---------------------------------------------------------------------------

/**
 * Returns the names of nodes that act as global error handlers: they receive
 * error-channel connections (non-main, non-ai_*) from source nodes that span
 * ≥ 2 different sections.  These nodes will be placed outside all sticky
 * notes by the relayout engine.
 */
export function detectGlobalErrorHandlers(
  connections: N8nConnections | undefined,
  sections:    Section[],
): Set<string> {
  const errorSources = new Map<string, string[]>();
  for (const [sourceName, channels] of Object.entries(connections ?? {})) {
    for (const [channelName, branches] of Object.entries(channels)) {
      if (channelName === 'main' || channelName.startsWith('ai_')) continue;
      for (const branch of (branches ?? [])) {
        for (const conn of (branch ?? [])) {
          if (conn?.node) {
            const list = errorSources.get(conn.node) ?? [];
            list.push(sourceName);
            errorSources.set(conn.node, list);
          }
        }
      }
    }
  }

  const nodeToSection = new Map<string, number>();
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;
    for (const node of section.members) {
      nodeToSection.set(node.name, i);
    }
  }

  const globalHandlers = new Set<string>();
  for (const [target, sources] of errorSources.entries()) {
    const sectionSet = new Set(
      sources
        .map(s => nodeToSection.get(s))
        .filter((s): s is number => s !== undefined),
    );
    if (sectionSet.size >= 2) globalHandlers.add(target);
  }
  return globalHandlers;
}

// ---------------------------------------------------------------------------
// Loop body detection — nodes reachable from SplitInBatches port-1 within section
// ---------------------------------------------------------------------------

/**
 * For each section containing a SplitInBatches loop node, identify the
 * "body" nodes: those reachable by following port-1 (loop body branch) output
 * forward from the loop node, staying within the same section and stopping
 * when the loop node is reached again (back edge).
 *
 * These nodes must be placed at row=1 (y=208) instead of row=0 (y=80) so
 * the loop body visually sits below the routing lane.
 *
 * Returns a Set<string> of ALL body node names across all sections.
 */
export function findBodyNodes(wf: N8nWorkflow, sections: Section[]): Set<string> {
  const allBodyNodes = new Set<string>();

  // All layout node names across all sections (for BFS boundary)
  const allSectionNodeNames = new Set(sections.flatMap(s => s.members.map(n => n.name)));

  for (const { members } of sections) {
    // Find SplitInBatches loop nodes in this section
    const loopNodes = members.filter(n => n.type === 'n8n-nodes-base.splitInBatches');
    if (loopNodes.length === 0) continue;

    for (const loopNode of loopNodes) {
      // splitInBatches port mapping:
      //   port-0 (mainBranches[0]) = "done"   — exit path after all items processed
      //   port-1 (mainBranches[1]) = "loop body" — executed for each item
      const mainBranches = wf.connections[loopNode.name]?.['main'] ?? [];
      const bodyTargets = (mainBranches[1] ?? [])
        .map(c => c?.node)
        .filter((n): n is string => !!n && n !== loopNode.name);

      if (bodyTargets.length === 0) continue;

      // BFS forward from body targets — cross-section AND through AI sub-nodes.
      // AI sub-nodes (e.g. LLM: Extract Events) appear in wf.connections but are
      // NOT part of any section. We must traverse THROUGH them to reach downstream
      // section nodes (e.g. Code: Flatten Events). We only ADD a node to allBodyNodes
      // when it is a section node; we still traverse non-section nodes freely.
      // Stop when the loop node itself is reached (back edge).
      const visited = new Set<string>(bodyTargets);
      const queue   = [...bodyTargets];

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (allSectionNodeNames.has(cur)) allBodyNodes.add(cur);

        const mainOut = wf.connections[cur]?.['main'] ?? [];
        for (const branch of mainOut) {
          for (const conn of (branch ?? [])) {
            if (
              conn?.node &&
              !visited.has(conn.node) &&
              conn.node !== loopNode.name
            ) {
              visited.add(conn.node);
              queue.push(conn.node);
            }
          }
        }
      }
    }
  }

  return allBodyNodes;
}

// ---------------------------------------------------------------------------
// analyzeWorkflow — single entry point for all structural analysis
// ---------------------------------------------------------------------------

/**
 * Performs structural analysis of a workflow: builds sections, detects global
 * error handlers, finds loop body nodes, cross-indented sections, and bypass
 * nodes.  Must be called after buildWorkflowGraph and computeStickyGroups,
 * but before ELK layout positions are needed.
 */
export function analyzeWorkflow(
  wf:          N8nWorkflow,
  graph:       WorkflowGraph,
  stickyGroups: Map<string, Set<string>>,
): WorkflowAnalysis {
  const { layoutNodes, safeEdges, cyclicEdges } = graph;

  // Sort stickies by original position (X primary, Y tiebreaker)
  const stickies = wf.nodes
    .filter(isSticky)
    .sort((a, b) => a.position[0] !== b.position[0]
      ? a.position[0] - b.position[0]
      : a.position[1] - b.position[1]);

  // Build section list: [{sticky, members}]
  const sections: Section[] = stickies.map(sticky => {
    const memberSet = stickyGroups.get(sticky.name) ?? new Set<string>();
    const members   = layoutNodes.filter(n => memberSet.has(n.name));
    return { sticky, members };
  });

  // R11: detect global error handlers (sources span ≥2 sections) before grids are computed
  const globalHandlerNames = detectGlobalErrorHandlers(wf.connections, sections);
  for (const section of sections) {
    section.members = section.members.filter(n => !globalHandlerNames.has(n.name));
  }

  // Orphan nodes: layout nodes not assigned to any sticky section
  const allSectionNodeNames = new Set(sections.flatMap(s => s.members.map(n => n.name)));
  const orphans        = layoutNodes.filter(n => !allSectionNodeNames.has(n.name) && !globalHandlerNames.has(n.name));
  const globalHandlers = layoutNodes.filter(n => globalHandlerNames.has(n.name));

  // Loop body nodes (R3/R5)
  const bodyNodes = findBodyNodes(wf, sections);

  // R10: detect which sections are intermediate for cross-section edges
  const nodeToSection = new Map<string, number>();
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;
    for (const node of section.members) nodeToSection.set(node.name, i);
  }
  const crossIndentedSections = new Set<number>();
  for (const [from, to] of [...safeEdges, ...cyclicEdges]) {
    const secFrom = nodeToSection.get(from);
    const secTo   = nodeToSection.get(to);
    if (secFrom === undefined || secTo === undefined || secFrom === secTo) continue;
    const lo = Math.min(secFrom, secTo);
    const hi = Math.max(secFrom, secTo);
    for (let s = lo + 1; s < hi; s++) crossIndentedSections.add(s);
  }

  // R12: cross-section backward edges by section position (safe + cyclic)
  // Orphan nodes (not in any section) get a virtual section index of sections.length
  // so they compare as "after all sections" for the secFrom > secTo test.
  const bypassNodeNames = new Set<string>();
  const sectionOrMax = (name: string): number | undefined => {
    const s = nodeToSection.get(name);
    if (s !== undefined) return s;
    if (orphans.some(n => n.name === name)) return sections.length;
    return undefined;
  };
  for (const [from, to] of [...safeEdges, ...cyclicEdges]) {
    const secFrom = sectionOrMax(from);
    const secTo   = sectionOrMax(to);
    if (secFrom === undefined || secTo === undefined) continue;
    if (secFrom <= secTo) continue;
    if (nodeToSection.has(to)) continue;
    bypassNodeNames.add(to);
  }

  return {
    sections,
    globalHandlerNames,
    bodyNodes,
    crossIndentedSections,
    bypassNodeNames,
    orphans,
    globalHandlers,
  };
}
