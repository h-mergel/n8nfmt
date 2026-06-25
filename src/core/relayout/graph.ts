// ---------------------------------------------------------------------------
// graph.ts — Edge extraction and workflow graph construction
// ---------------------------------------------------------------------------

import { isSticky } from './nodes.js';
import type {
  N8nNode,
  N8nConnections,
  N8nWorkflow,
  Edge,
} from '../types.js';

// ---------------------------------------------------------------------------
// WorkflowGraph — aggregated graph data for the relayout pipeline
// ---------------------------------------------------------------------------

export interface WorkflowGraph {
  /** Regular nodes for dagre/ELK (no stickies, no AI sub-nodes) */
  layoutNodes:       N8nNode[];
  /** Sticky note nodes */
  stickyNodes:       N8nNode[];
  /** AI sub-node → parent name (from ai_* channel connections) */
  aiChildToParent:   Map<string, string>;
  /** Set of AI sub-node names */
  aiChildren:        Set<string>;
  /** Main-channel edges with AI children filtered out */
  mainEdges:         Edge[];
  /** Non-main, non-ai_* edges with AI children filtered out */
  auxEdges:          Edge[];
  /** Synthetic bridge edges bypassing excluded AI nodes */
  bridgeEdges:       Edge[];
  /** Acyclic (forward) edges from cycle detection */
  safeEdges:         Edge[];
  /** Back-edges (cycle-closing) from cycle detection */
  cyclicEdges:       Edge[];
  /** "from→to" → branch index (0-based port index from wf.connections) */
  branchIndexByEdge: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Edge / connection extraction
// ---------------------------------------------------------------------------

/**
 * Extract all edges from wf.connections using only the "main" channel.
 * Returns [[from, to], …] deduplicated.
 */
export function extractEdges(connections: N8nConnections | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const [sourceName, channels] of Object.entries(connections ?? {})) {
    const mainBranches = channels['main'] ?? [];
    for (const branch of mainBranches) {
      for (const conn of (branch ?? [])) {
        if (conn?.node && conn.node !== sourceName) {
          edges.push([sourceName, conn.node]);
        }
      }
    }
  }
  const seen = new Set<string>();
  return edges.filter(([f, t]) => {
    const key = `${f}→${t}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractAISubNodes(connections: N8nConnections | undefined): Map<string, string> {
  const childToParent = new Map<string, string>();
  for (const [sourceName, channels] of Object.entries(connections ?? {})) {
    for (const [channelName, branches] of Object.entries(channels)) {
      if (!channelName.startsWith('ai_')) continue;
      for (const branch of (branches ?? [])) {
        for (const conn of (branch ?? [])) {
          if (conn?.node) {
            childToParent.set(sourceName, conn.node);
          }
        }
      }
    }
  }
  return childToParent;
}

// ---------------------------------------------------------------------------
// AI bridge edges — synthetic main-channel edges that bypass excluded AI nodes
// ---------------------------------------------------------------------------
/**
 * When an AI sub-node (connected via ai_* channel) sits in the middle of a
 * main-channel path (A → AI → B), both edges are removed by the aiChildren
 * filter.  This leaves B with no dagre predecessors → placed at col=0.
 *
 * This function generates a synthetic bridge edge A → B for every such gap,
 * following chains of consecutive AI nodes transitively.
 */
export function extractAIBridgeEdges(
  allEdges:        Edge[],
  aiChildren:      Set<string>,
  aiChildToParent: Map<string, string>,
): Edge[] {
  const succs = new Map<string, string[]>();
  const preds  = new Map<string, string[]>();
  for (const [from, to] of allEdges) {
    if (!succs.has(from)) succs.set(from, []);
    succs.get(from)!.push(to);
    if (!preds.has(to)) preds.set(to, []);
    preds.get(to)!.push(from);
  }

  function nonAIPreds(node: string, visited = new Set<string>()): string[] {
    visited.add(node);
    const result: string[] = [];
    for (const p of (preds.get(node) ?? [])) {
      if (visited.has(p)) continue;
      if (!aiChildren.has(p)) result.push(p);
      else result.push(...nonAIPreds(p, visited));
    }
    return result;
  }

  function nonAISuccs(node: string, visited = new Set<string>()): string[] {
    visited.add(node);
    const result: string[] = [];
    for (const s of (succs.get(node) ?? [])) {
      if (visited.has(s)) continue;
      if (!aiChildren.has(s)) result.push(s);
      else result.push(...nonAISuccs(s, visited));
    }
    return result;
  }

  const bridges: Edge[] = [];
  const seen = new Set<string>();
  for (const ai of aiChildren) {
    const parent = aiChildToParent.get(ai);
    for (const p of nonAIPreds(ai)) {
      for (const s of nonAISuccs(ai)) {
        if (parent) {
          const k1 = `${p}→${parent}`;
          const k2 = `${parent}→${s}`;
          if (!seen.has(k1)) { seen.add(k1); bridges.push([p, parent]); }
          if (!seen.has(k2)) { seen.add(k2); bridges.push([parent, s]); }
        } else {
          const key = `${p}→${s}`;
          if (!seen.has(key)) { seen.add(key); bridges.push([p, s]); }
        }
      }
    }
  }
  return bridges;
}

export function extractAuxEdges(connections: N8nConnections | undefined): Edge[] {
  const edges: Edge[] = [];
  for (const [sourceName, channels] of Object.entries(connections ?? {})) {
    for (const [channelName, branches] of Object.entries(channels)) {
      if (channelName === 'main') continue;
      if (channelName.startsWith('ai_')) continue;
      for (const branch of (branches ?? [])) {
        for (const conn of (branch ?? [])) {
          if (conn?.node && conn.node !== sourceName) {
            edges.push([sourceName, conn.node]);
          }
        }
      }
    }
  }
  const seen = new Set<string>();
  return edges.filter(([f, t]) => {
    const key = `${f}→${t}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Cycle detection — DFS back-edge algorithm
// ---------------------------------------------------------------------------
/**
 * Identify back-edges using a single DFS pass (three-colour marking).
 *
 * A back-edge (u → v) is one where v is GRAY (currently on the DFS stack),
 * meaning v is an ancestor of u in the DFS tree.  This is the standard
 * textbook definition and correctly identifies ALL cycle-closing edges
 * regardless of the order in which edges appear in the JSON.
 *
 * The previous incremental approach (add edge, run full cycle check, remove
 * if cycle found) was order-dependent: if a back-edge was processed before
 * the forward edges that complete the cycle it was falsely kept as "safe",
 * and the later forward edge that finally closed the cycle was removed
 * instead — producing wrong topological ranks.
 */
export function findCyclicEdges(
  nodeNames: string[],
  edges:     Edge[],
): { safe: Edge[]; cyclic: Edge[] } {
  const seenKeys = new Set<string>();
  const deduped: Edge[] = [];
  for (const e of edges) {
    const key = `${e[0]}→${e[1]}`;
    if (!seenKeys.has(key)) { seenKeys.add(key); deduped.push(e); }
  }

  const adjacency = new Map<string, string[]>(nodeNames.map(n => [n, []]));
  for (const [from, to] of deduped) {
    adjacency.get(from)?.push(to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color      = new Map<string, number>(nodeNames.map(n => [n, WHITE]));
  const cyclicKeys = new Set<string>();

  function dfs(u: string): void {
    color.set(u, GRAY);
    for (const v of (adjacency.get(u) ?? [])) {
      const vc = color.get(v);
      if (vc === undefined) continue;
      if (vc === GRAY) {
        cyclicKeys.add(`${u}→${v}`);
      } else if (vc === WHITE) {
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const name of nodeNames) {
    if ((color.get(name) ?? BLACK) === WHITE) dfs(name);
  }

  const cyclic: Edge[] = [];
  const safe:   Edge[] = [];
  for (const e of deduped) {
    if (cyclicKeys.has(`${e[0]}→${e[1]}`)) cyclic.push(e);
    else safe.push(e);
  }
  return { safe, cyclic };
}

// ---------------------------------------------------------------------------
// buildWorkflowGraph — single entry point for all graph data
// ---------------------------------------------------------------------------

/**
 * Builds a complete WorkflowGraph from a workflow definition.
 * Combines node classification, edge extraction, AI sub-node detection,
 * bridge edge synthesis, cycle detection, and branch index mapping.
 */
export function buildWorkflowGraph(wf: N8nWorkflow): WorkflowGraph {
  // R3: identify AI sub-nodes — exclude from dagre, place after layout
  const aiChildToParent = extractAISubNodes(wf.connections);
  const aiChildren      = new Set(aiChildToParent.keys());

  // Regular nodes for dagre (no stickies, no AI sub-nodes)
  const layoutNodes = wf.nodes.filter(n => !isSticky(n) && !aiChildren.has(n.name));
  const stickyNodes = wf.nodes.filter(isSticky);
  const nodeNames   = layoutNodes.map(n => n.name);

  // Edge extraction and classification
  const allEdges    = extractEdges(wf.connections);
  const mainEdges   = allEdges.filter(([f, t]) => !aiChildren.has(f) && !aiChildren.has(t));
  const bridgeEdges = extractAIBridgeEdges(allEdges, aiChildren, aiChildToParent);
  const auxEdges    = extractAuxEdges(wf.connections).filter(([f, t]) => !aiChildren.has(f) && !aiChildren.has(t));

  // Cycle detection over combined edge set
  const { safe: safeEdges, cyclic: cyclicEdges } = findCyclicEdges(
    nodeNames,
    [...mainEdges, ...bridgeEdges, ...auxEdges],
  );

  // Branch index map: "from→to" → 0-based port index from wf.connections
  const branchIndexByEdge = new Map<string, number>();
  for (const [sourceName, channels] of Object.entries(wf.connections ?? {})) {
    const mainBranches = channels['main'] ?? [];
    for (let bi = 0; bi < mainBranches.length; bi++) {
      for (const conn of (mainBranches[bi] ?? [])) {
        if (conn?.node && conn.node !== sourceName) {
          const key = `${sourceName}→${conn.node}`;
          if (!branchIndexByEdge.has(key)) branchIndexByEdge.set(key, bi);
        }
      }
    }
  }

  return {
    layoutNodes,
    stickyNodes,
    aiChildToParent,
    aiChildren,
    mainEdges,
    auxEdges,
    bridgeEdges,
    safeEdges,
    cyclicEdges,
    branchIndexByEdge,
  };
}
