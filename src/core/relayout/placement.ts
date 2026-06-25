/**
 * placement.ts — Node placement functions for the section-aware grid layout.
 *
 * All functions are pure: they compute position plans without mutating any node
 * objects. applyPlacementPlan() performs the single mutation pass that writes
 * positions back to wf.nodes.
 */

import { sectionRowY, snap } from "../config.js";
import type { LayoutConfig } from "../config.js";
import type { BranchedEdge, Edge, LayoutPos, N8nNode, N8nWorkflow, Section } from "../types.js";
import { alignMergeNodes, computeColX, computeGridIndices, liftDetourNodes } from "./grid.js";
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, nodeWidth } from "./nodes.js";

// ---------------------------------------------------------------------------
// Layout constants (R3, R6–R12)
// ---------------------------------------------------------------------------

const AI_OFFSET_Y = 192; // R3: AI sub-node vertical offset below parent
const STICKY_X = 200; // left edge of the first section column
const STICKY_Y = 0; // fixed y for all sticky notes
const RIGHT_PAD = 200; // rightmost node right edge to sticky right edge
const STICKY_PAD_X = 100; // horizontal padding between node edges and sticky edges
const CROSS_INDENT = 80; // R10: x-offset for cross-section-indented sections
const MIN_STICKY_HEIGHT = 720; // minimum sticky height
const STICKY_PAD_Y_BOT = 120; // min gap from last node bottom to sticky bottom

// ---------------------------------------------------------------------------
// Placement plan types
// ---------------------------------------------------------------------------

export interface NodePosition {
  name: string;
  position: [number, number];
}

export interface StickyPlacement {
  name: string;
  position: [number, number];
  width: number;
  height: number;
}

export interface SectionLayoutResult {
  nodePlacements: NodePosition[];
  stickyPlacements: StickyPlacement[];
  stickyOffsets: number[];
  stickyWidths: number[];
  sectionLefts: number[];
  /** currentX after stacking all sections — used as orphanBaseX */
  nextX: number;
}

export interface OrphanLayoutResult {
  nodePlacements: NodePosition[];
  /** currentX after orphan columns — passed to placeGlobalHandlers */
  nextX: number;
}

export interface PlacementPlan {
  nodePlacements: NodePosition[];
  stickyPlacements: StickyPlacement[];
}

// ---------------------------------------------------------------------------
// placeSections — R6–R10: compute section metrics and return placement plans
// ---------------------------------------------------------------------------

/**
 * Computes per-section grid indices, column offsets, section stacking, and
 * sticky auto-resize. Returns a SectionLayoutResult with all positions as
 * plain data — no node objects are mutated.
 */
export function placeSections(
  sections: Section[],
  elkPositions: Map<string, LayoutPos>,
  cyclicEdges: Edge[],
  safeEdges: Edge[],
  branchIndexByEdge: Map<string, number>,
  crossIndentedSections: Set<number>,
  bypassNodeNames: Set<string>,
  bodyNodes: Set<string>,
  aiChildToParent: Map<string, string>,
  config: LayoutConfig,
): SectionLayoutResult {
  // --- per-section grid indices and column offsets -------------------------
  const sectionGrids = sections.map(({ members }) => {
    const memberNames = new Set(members.map((m) => m.name));
    const cyclicInSection = cyclicEdges.filter(
      ([f, t]) => members.some((m) => m.name === f) && members.some((m) => m.name === t),
    );
    const safeInSection = safeEdges.filter(([f, t]) => memberNames.has(f) && memberNames.has(t));
    const branchedSafeInSection = safeInSection.map<BranchedEdge>(([f, t]) => [
      f,
      t,
      branchIndexByEdge.get(`${f}→${t}`) ?? 0,
    ]);
    return computeGridIndices(
      members,
      elkPositions,
      cyclicInSection,
      bodyNodes,
      branchedSafeInSection,
    );
  });

  const sectionColX = sections.map(({ members }, i) =>
    computeColX(members, sectionGrids[i] ?? new Map(), config),
  );

  // --- R6: per-section sticky metrics (stickyOffsets, stickyWidths) --------
  const stickyOffsets: number[] = [];
  const stickyWidths: number[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const gridMap = sectionGrids[i];
    const colX = sectionColX[i];
    if (!section || !gridMap || !colX) continue;

    const { members } = section;
    const indent = crossIndentedSections.has(i) ? CROSS_INDENT : 0;
    let maxCol = -1;
    let rightColMaxWidth = DEFAULT_WIDTH;

    for (const node of members) {
      const grid = gridMap.get(node.name);
      if (!grid) continue;
      if (grid.col > maxCol) {
        maxCol = grid.col;
        rightColMaxWidth = nodeWidth(node);
      } else if (grid.col === maxCol) {
        rightColMaxWidth = Math.max(rightColMaxWidth, nodeWidth(node));
      }
    }

    if (maxCol < 0) {
      // Empty section
      stickyOffsets.push(0);
      stickyWidths.push(snap(config.leftIndent + DEFAULT_WIDTH + RIGHT_PAD, config));
      continue;
    }

    stickyOffsets.push(snap(snap(indent + config.leftIndent, config) - STICKY_PAD_X, config));
    const A = snap(indent + (colX.get(maxCol) ?? config.leftIndent), config) + rightColMaxWidth;
    const B = snap(indent + config.leftIndent, config);
    stickyWidths.push(snap(A - B + 2 * STICKY_PAD_X, config));
  }

  // --- Stack sections left-to-right with exactly SECTION_GAP between sticky edges
  const sectionLefts: number[] = [];
  let currentX = STICKY_X;
  for (let i = 0; i < sections.length; i++) {
    sectionLefts.push(currentX);
    const C_i = stickyOffsets[i] ?? 0;
    const C_next = i + 1 < sections.length ? (stickyOffsets[i + 1] ?? 0) : 0;
    const sw_i = stickyWidths[i] ?? 0;
    currentX += C_i - C_next + sw_i + config.sectionGap;
  }

  // --- Compute node positions for section members --------------------------
  const nodePlacements: NodePosition[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const gridMap = sectionGrids[i];
    const colX = sectionColX[i];
    const sectionLeft = sectionLefts[i];
    if (!section || !gridMap || !colX || sectionLeft === undefined) continue;

    const { members } = section;
    const indent = crossIndentedSections.has(i) ? CROSS_INDENT : 0;

    for (const node of members) {
      const grid = gridMap.get(node.name);
      if (!grid) continue;
      const newX = snap(sectionLeft + indent + (colX.get(grid.col) ?? config.leftIndent), config);
      const newY = snap(sectionRowY(grid.row, config), config);
      nodePlacements.push({ name: node.name, position: [newX, newY] });
    }
  }

  // --- POST-PROCESS: auto-resize stickies to contain their member nodes ----
  // Bypass-lane nodes float above the sticky intentionally (R12) — exclude from bbox.
  const aiParents = new Set(aiChildToParent.values());
  const posMap = new Map<string, [number, number]>(nodePlacements.map((p) => [p.name, p.position]));
  const stickyPlacements: StickyPlacement[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionLeft = sectionLefts[i];
    if (!section || sectionLeft === undefined) continue;

    const { sticky, members } = section;
    const layoutMembers = members.filter((n) => !bypassNodeNames.has(n.name));

    if (layoutMembers.length === 0) {
      const w = snap(config.leftIndent + DEFAULT_WIDTH + RIGHT_PAD, config);
      const h = snap(MIN_STICKY_HEIGHT, config);
      stickyPlacements.push({
        name: sticky.name,
        position: [sectionLeft, STICKY_Y],
        width: w,
        height: h,
      });
      continue;
    }

    const memberPositions: [number, number][] = layoutMembers.map(
      (n) => posMap.get(n.name) ?? [0, 0],
    );
    const minX = Math.min(...layoutMembers.map((_, mi) => (memberPositions[mi] ?? [0, 0])[0]));
    const maxX = Math.max(
      ...layoutMembers.map((n, mi) => (memberPositions[mi] ?? [0, 0])[0] + nodeWidth(n)),
    );
    const maxY = Math.max(
      ...layoutMembers.map((_, mi) => (memberPositions[mi] ?? [0, 0])[1] + DEFAULT_HEIGHT),
    );

    let effectiveMaxY = maxY;
    for (let mi = 0; mi < layoutMembers.length; mi++) {
      const node = layoutMembers[mi];
      if (!node || !aiParents.has(node.name)) continue;
      const mpos = memberPositions[mi] ?? [0, 0];
      const aiBottom = mpos[1] + AI_OFFSET_Y + DEFAULT_HEIGHT;
      if (aiBottom > effectiveMaxY) effectiveMaxY = aiBottom;
    }

    const stickyX = snap(minX - STICKY_PAD_X, config);
    const w = snap(maxX - minX + 2 * STICKY_PAD_X, config);
    const rawHeight = snap(effectiveMaxY - STICKY_Y + STICKY_PAD_Y_BOT, config);
    const h = Math.max(snap(MIN_STICKY_HEIGHT, config), rawHeight);

    stickyPlacements.push({
      name: sticky.name,
      position: [stickyX, STICKY_Y],
      width: w,
      height: h,
    });
  }

  return {
    nodePlacements,
    stickyPlacements,
    stickyOffsets,
    stickyWidths,
    sectionLefts,
    nextX: currentX,
  };
}

// ---------------------------------------------------------------------------
// placeOrphans — R12/R13: orphan grid layout with skip-lift and merge alignment
// ---------------------------------------------------------------------------

/**
 * Computes grid indices for orphan (no-sticky) nodes, applies R12 detour-lift
 * and R13 merge-alignment, and returns node positions as plain data.
 */
export function placeOrphans(
  orphans: N8nNode[],
  safeEdges: Edge[],
  cyclicEdges: Edge[],
  branchIndexByEdge: Map<string, number>,
  elkPositions: Map<string, LayoutPos>,
  startX: number,
  config: LayoutConfig,
): OrphanLayoutResult {
  if (orphans.length === 0) return { nodePlacements: [], nextX: startX };

  const orphanNames = new Set(orphans.map((n) => n.name));
  const safeOrphan = safeEdges.filter(([f, t]) => orphanNames.has(f) && orphanNames.has(t));
  const branchedOrphan: BranchedEdge[] = safeOrphan.map(([f, t]) => [
    f,
    t,
    branchIndexByEdge.get(`${f}→${t}`) ?? 0,
  ]);
  const cyclicOrphan = cyclicEdges.filter(([f, t]) => orphanNames.has(f) && orphanNames.has(t));

  const orphanGridMap = computeGridIndices(
    orphans,
    elkPositions,
    cyclicOrphan,
    new Set(),
    branchedOrphan,
  );
  liftDetourNodes(orphanNames, orphanGridMap, safeOrphan, config);
  alignMergeNodes(orphanNames, orphanGridMap, branchedOrphan, config);
  const orphanColX = computeColX(orphans, orphanGridMap, config);

  const nodePlacements: NodePosition[] = [];
  for (const node of orphans) {
    const grid = orphanGridMap.get(node.name);
    if (!grid) continue;
    const newX = snap(startX + (orphanColX.get(grid.col) ?? config.leftIndent), config);
    const newY = snap(sectionRowY(grid.row, config), config);
    nodePlacements.push({ name: node.name, position: [newX, newY] });
  }

  let maxOrphanCol = -1;
  let maxOrphanColWidth = DEFAULT_WIDTH;
  for (const node of orphans) {
    const grid = orphanGridMap.get(node.name);
    if (!grid) continue;
    if (grid.col > maxOrphanCol) {
      maxOrphanCol = grid.col;
      maxOrphanColWidth = nodeWidth(node);
    } else if (grid.col === maxOrphanCol) {
      maxOrphanColWidth = Math.max(maxOrphanColWidth, nodeWidth(node));
    }
  }

  const nextX =
    maxOrphanCol >= 0
      ? snap(
          startX +
            (orphanColX.get(maxOrphanCol) ?? config.leftIndent) +
            maxOrphanColWidth +
            config.sectionGap,
          config,
        )
      : snap(startX + DEFAULT_WIDTH + config.sectionGap, config);

  return { nodePlacements, nextX };
}

// ---------------------------------------------------------------------------
// placeGlobalHandlers — R11: center global error handlers below all sections
// ---------------------------------------------------------------------------

/**
 * Positions global error handler nodes centered below the full workflow width.
 * Reads sticky heights from sectionResult (computed by placeSections) so that
 * no sticky mutation has to have occurred before this call.
 *
 * @param currentX  rightmost X after sections + orphans (fallback when no sections)
 */
export function placeGlobalHandlers(
  globalHandlers: N8nNode[],
  sections: Section[],
  sectionResult: SectionLayoutResult,
  currentX: number,
  config: LayoutConfig,
): NodePosition[] {
  if (globalHandlers.length === 0) return [];

  const { stickyPlacements, sectionLefts, stickyOffsets, stickyWidths } = sectionResult;
  const maxStickyHeight = stickyPlacements.reduce((max, s) => Math.max(max, s.height), 0);
  const handlersY = snap(STICKY_Y + maxStickyHeight + 368, config);

  const lastIdx = sections.length - 1;
  const workflowRight =
    sections.length > 0
      ? (sectionLefts[lastIdx] ?? 0) + (stickyOffsets[lastIdx] ?? 0) + (stickyWidths[lastIdx] ?? 0)
      : currentX;
  const workflowLeft = sections.length > 0 ? (sectionLefts[0] ?? STICKY_X) : STICKY_X;
  const totalWidth =
    globalHandlers.length * DEFAULT_WIDTH + (globalHandlers.length - 1) * config.minGap;
  const groupStartX = snap((workflowLeft + workflowRight) / 2 - totalWidth / 2, config);

  const placements: NodePosition[] = [];
  for (let hi = 0; hi < globalHandlers.length; hi++) {
    const handler = globalHandlers[hi];
    if (!handler) continue;
    const pos: [number, number] = [
      snap(groupStartX + hi * (DEFAULT_WIDTH + config.minGap), config),
      handlersY,
    ];
    placements.push({ name: handler.name, position: pos });
  }
  return placements;
}

// ---------------------------------------------------------------------------
// placeAiSubNodes — R3: place AI sub-nodes below their parent
// ---------------------------------------------------------------------------

/**
 * Positions AI sub-nodes below their parent using previously computed parent
 * positions (from section/orphan placement). allPositions is a combined map
 * of node-name → [x, y] from all earlier placement steps.
 */
export function placeAiSubNodes(
  aiChildToParent: Map<string, string>,
  allPositions: Map<string, [number, number]>,
  config: LayoutConfig,
): NodePosition[] {
  const childrenByParent = new Map<string, string[]>();
  for (const [childName, parentName] of aiChildToParent.entries()) {
    const list = childrenByParent.get(parentName) ?? [];
    list.push(childName);
    childrenByParent.set(parentName, list);
  }

  const placements: NodePosition[] = [];
  for (const [parentName, childNames] of childrenByParent.entries()) {
    const parentPos = allPositions.get(parentName);
    if (!parentPos) continue;
    const groupStartX = snap(parentPos[0], config);
    const childY = snap(parentPos[1] + AI_OFFSET_Y, config);
    for (let ci = 0; ci < childNames.length; ci++) {
      const childName = childNames[ci];
      if (!childName) continue;
      const pos: [number, number] = [
        snap(groupStartX + ci * (DEFAULT_WIDTH + config.minGap), config),
        childY,
      ];
      placements.push({ name: childName, position: pos });
    }
  }
  return placements;
}

// ---------------------------------------------------------------------------
// applyPlacementPlan — single mutation pass: write positions to wf.nodes
// ---------------------------------------------------------------------------

/**
 * The only function in placement.ts that mutates wf.nodes. Applies all
 * node positions and sticky dimensions from the plan in a single pass.
 *
 * @returns number of regular (non-sticky) nodes repositioned
 */
export function applyPlacementPlan(wf: N8nWorkflow, plan: PlacementPlan): number {
  const nodeByName = new Map(wf.nodes.map((n) => [n.name, n]));
  let changed = 0;

  for (const { name, position } of plan.nodePlacements) {
    const node = nodeByName.get(name);
    if (!node) continue;
    node.position = position;
    changed++;
  }

  for (const { name, position, width, height } of plan.stickyPlacements) {
    const node = nodeByName.get(name);
    if (!node) continue;
    node.position = position;
    node.parameters = node.parameters ?? {};
    node.parameters.width = width;
    node.parameters.height = height;
  }

  return changed;
}
