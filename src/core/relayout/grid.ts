/**
 * grid.ts — Section-aware grid layout helpers (R5, R6–R9, R12, R13)
 *
 * Extracted from relayout.ts. All functions are pure with explicit parameters;
 * no global state (VERBOSE, CLI_PARAMS, DRY_RUN) is referenced here.
 */

import type { LayoutConfig } from "../config.js";
import { snap } from "../config.js";
import type { BranchedEdge, Edge, GridEntry, LayoutPos, N8nNode } from "../types.js";
import { DEFAULT_WIDTH, nodeWidth } from "./nodes.js";

// R5: loop target must be at least this many cols right of source
const LOOP_COL_EXTRA = 2;

// ---------------------------------------------------------------------------
// R6–R9 — Section-aware grid layout helpers
// ---------------------------------------------------------------------------

export function computeGridIndices(
  sectionNodes: N8nNode[],
  elkPositions: Map<string, LayoutPos>,
  cyclicEdgesInSection: Edge[],
  bodyNodes: Set<string> = new Set(),
  sectionEdges: BranchedEdge[] = [],
): Map<string, GridEntry> {
  if (sectionNodes.length === 0) return new Map();

  const BUCKET_EPSILON = 8; // px — one GRID step; ELK compound layouts can jitter > 4 px
  const xs = sectionNodes.map((n) => elkPositions.get(n.name)?.x ?? 0);
  const sortedRaw = [...xs].sort((a, b) => a - b);
  const buckets: number[] = [];
  for (const x of sortedRaw) {
    const lastBucket = buckets.at(-1);
    if (lastBucket === undefined || x - lastBucket > BUCKET_EPSILON) {
      buckets.push(x);
    }
  }
  const bucketOf = (x: number) => buckets.find((b) => Math.abs(x - b) <= BUCKET_EPSILON) ?? x;
  const sortedX = buckets; // already sorted
  const xToCol = new Map(sortedX.map((x, i) => [x, i]));

  const colGroups = new Map<number, Array<{ name: string; dagreY: number }>>();
  for (const node of sectionNodes) {
    const pos = elkPositions.get(node.name);
    if (!pos) continue;
    const col = xToCol.get(bucketOf(pos.x)) ?? 0;
    if (!colGroups.has(col)) colGroups.set(col, []);
    colGroups.get(col)!.push({ name: node.name, dagreY: pos.y });
  }

  const gridMap = new Map<string, GridEntry>();
  for (const [col, entries] of colGroups.entries()) {
    entries.sort((a, b) => a.dagreY - b.dagreY);
    const nonBodyEntries = entries.filter((e) => !bodyNodes.has(e.name));
    const bodyEntries = entries.filter((e) => bodyNodes.has(e.name));
    nonBodyEntries.forEach(({ name }, idx) => gridMap.set(name, { col, row: idx }));
    const bodyRowStart = Math.max(1, nonBodyEntries.length);
    bodyEntries.forEach(({ name }, idx) => gridMap.set(name, { col, row: bodyRowStart + idx }));
  }

  if (sectionEdges.length > 0) {
    const predMap = new Map<string, Array<{ from: string; branchIdx: number }>>();
    for (const [from, to, branchIdx] of sectionEdges) {
      if (!predMap.has(to)) predMap.set(to, []);
      predMap.get(to)!.push({ from, branchIdx });
    }
    const sortedCols = [...new Set([...gridMap.values()].map((g) => g.col))].sort((a, b) => a - b);
    for (const col of sortedCols) {
      for (const [name, entry] of gridMap.entries()) {
        if (entry.col !== col) continue;
        const preds = predMap.get(name) ?? [];
        if (preds.length === 0) continue;
        const adjustedRows = preds.map(
          ({ from, branchIdx }) => (gridMap.get(from)?.row ?? 0) + branchIdx,
        );
        const minAdjustedRow = Math.min(...adjustedRows);
        gridMap.set(name, { col: entry.col, row: minAdjustedRow });
      }
    }

    // De-collision: if two nodes in the same column share a row after branch adjustment,
    // sort colliding nodes by their max branchIdx so lower branch → lower row.
    const colRowBuckets = new Map<number, Map<number, string[]>>();
    for (const [name, entry] of gridMap.entries()) {
      if (!colRowBuckets.has(entry.col)) colRowBuckets.set(entry.col, new Map());
      const rm = colRowBuckets.get(entry.col)!;
      if (!rm.has(entry.row)) rm.set(entry.row, []);
      rm.get(entry.row)!.push(name);
    }
    for (const [, rowMap] of colRowBuckets.entries()) {
      for (const [startRow, names] of rowMap.entries()) {
        if (names.length < 2) continue;
        names.sort((a, b) => {
          const aBI = Math.max(0, ...(predMap.get(a) ?? []).map((p) => p.branchIdx));
          const bBI = Math.max(0, ...(predMap.get(b) ?? []).map((p) => p.branchIdx));
          return aBI - bBI;
        });
        names.forEach((name, idx) =>
          gridMap.set(name, { col: gridMap.get(name)!.col, row: startRow + idx }),
        );
      }
    }
  }

  // R5: enforce loop-entry node column > source column + LOOP_COL_EXTRA - 1
  // Only applies when the to-node is at the same or higher column than from-node
  // (accidental forward-placement). For natural back-edges (SplitInBatches pattern
  // where the loop node is at the LEFT and body nodes are to the RIGHT), skip.
  const nodeNamesInSection = new Set(sectionNodes.map((n) => n.name));
  for (const [from, to] of cyclicEdgesInSection) {
    if (!nodeNamesInSection.has(from) || !nodeNamesInSection.has(to)) continue;
    const fromGrid = gridMap.get(from);
    const toGrid = gridMap.get(to);
    if (!fromGrid || !toGrid) continue;

    if (toGrid.col < fromGrid.col) {
      continue;
    }

    const needed = fromGrid.col + LOOP_COL_EXTRA;
    if (toGrid.col < needed) {
      const shift = needed - toGrid.col;
      const threshold = toGrid.col;
      for (const [name, g] of gridMap.entries()) {
        if (g.col >= threshold) {
          gridMap.set(name, { col: g.col + shift, row: g.row });
        }
      }
    }
  }

  return gridMap;
}

export function computeColX(
  sectionNodes: N8nNode[],
  gridMap: Map<string, GridEntry>,
  cfg: LayoutConfig,
): Map<number, number> {
  if (sectionNodes.length === 0) return new Map();

  let maxCol = 0;
  for (const { col } of gridMap.values()) {
    if (col > maxCol) maxCol = col;
  }

  const colMaxWidth = new Map<number, number>();
  for (const node of sectionNodes) {
    const grid = gridMap.get(node.name);
    if (!grid) continue;
    const w = nodeWidth(node);
    const cur = colMaxWidth.get(grid.col) ?? DEFAULT_WIDTH;
    if (w > cur) colMaxWidth.set(grid.col, w);
  }
  for (let c = 0; c <= maxCol; c++) {
    if (!colMaxWidth.has(c)) colMaxWidth.set(c, DEFAULT_WIDTH);
  }

  const colX = new Map<number, number>();
  let x = cfg.leftIndent;
  for (let c = 0; c <= maxCol; c++) {
    colX.set(c, x);
    x = snap(x + (colMaxWidth.get(c) ?? DEFAULT_WIDTH) + cfg.minGap, cfg);
  }
  return colX;
}

// ---------------------------------------------------------------------------
// R12 — Skip-lift: lift detour nodes above main flow for orphan layouts
// ---------------------------------------------------------------------------

/**
 * Post-pass over orphan gridMap: detect "skip" edges (col distance ≥ threshold)
 * and lift the detour nodes — those reachable from the non-skip branch and
 * strictly between skip-source col and skip-target col — to row = -1.
 * After all lifts, normalises rows so min row = 0.
 *
 * Result: detour nodes → row=0 (y=80, routing lane)
 *         main-flow nodes → row=1 (y=272, primary lane)
 */
export function liftDetourNodes(
  orphanNames: Set<string>,
  gridMap: Map<string, GridEntry>,
  safeEdges: Edge[],
  cfg: LayoutConfig,
): void {
  const SKIP_COL_THRESHOLD = cfg.skipColThreshold;
  const nodeCol = (name: string): number => gridMap.get(name)?.col ?? 0;

  // Build forward adjacency among orphan nodes
  const succs = new Map<string, string[]>();
  for (const [from, to] of safeEdges) {
    if (!orphanNames.has(from) || !orphanNames.has(to)) continue;
    if (!succs.has(from)) succs.set(from, []);
    succs.get(from)!.push(to);
  }

  for (const [from, to] of safeEdges) {
    if (!orphanNames.has(from) || !orphanNames.has(to)) continue;
    const fromCol = nodeCol(from);
    const toCol = nodeCol(to);
    if (toCol - fromCol < SKIP_COL_THRESHOLD) continue;

    // Skip edge found: from (col fromCol) → to (col toCol)
    // Only lift when the merge point continues the main flow (not a sink like an error handler)
    const targetSuccessors = (succs.get(to) ?? []).filter((s) => orphanNames.has(s));
    if (targetSuccessors.length === 0) continue;

    // Detour starts: all successors of `from` except the skip target
    const detourStarts = (succs.get(from) ?? []).filter((s) => s !== to);
    if (detourStarts.length === 0) continue;

    // BFS: collect all nodes reachable from detour starts with col < toCol
    const detour = new Set<string>();
    const queue = [...detourStarts];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (detour.has(cur)) continue;
      if (nodeCol(cur) >= toCol) continue; // stop at or past the merge point
      detour.add(cur);
      for (const s of succs.get(cur) ?? []) {
        if (!detour.has(s)) queue.push(s);
      }
    }

    // Lift detour nodes to row = -1
    for (const name of detour) {
      const e = gridMap.get(name);
      if (e) gridMap.set(name, { col: e.col, row: -1 });
    }
  }

  // Normalise: shift all rows so minimum = 0
  if (gridMap.size === 0) return;
  const minRow = Math.min(...[...gridMap.values()].map((e) => e.row));
  if (minRow < 0) {
    const shift = -minRow;
    for (const [name, e] of gridMap.entries()) {
      gridMap.set(name, { col: e.col, row: e.row + shift });
    }
  }
}

export function alignMergeNodes(
  names: Set<string>,
  gridMap: Map<string, GridEntry>,
  branchedEdges: BranchedEdge[],
  cfg: LayoutConfig,
): void {
  const SKIP_COL_THRESHOLD = cfg.skipColThreshold;
  const predMap = new Map<string, Array<{ from: string; branchIdx: number }>>();
  for (const name of names) predMap.set(name, []);
  for (const [from, to, bi] of branchedEdges) {
    if (names.has(from) && names.has(to)) predMap.get(to)!.push({ from, branchIdx: bi });
  }

  const sorted = [...names].sort((a, b) => (gridMap.get(a)?.col ?? 0) - (gridMap.get(b)?.col ?? 0));
  const shifted = new Set<string>();

  for (const name of sorted) {
    const entry = gridMap.get(name);
    if (!entry) continue;
    const preds = predMap.get(name) ?? [];
    let targetRow = -1;
    for (const { from } of preds) {
      const pe = gridMap.get(from);
      if (!pe) continue;
      if (entry.col - pe.col >= SKIP_COL_THRESHOLD && pe.row > entry.row) {
        targetRow = Math.max(targetRow, pe.row);
      }
    }
    if (targetRow >= 0) {
      gridMap.set(name, { col: entry.col, row: targetRow });
      shifted.add(name);
    }
  }

  if (shifted.size === 0) return;

  for (const name of sorted) {
    const entry = gridMap.get(name);
    if (!entry) continue;
    const preds = predMap.get(name) ?? [];
    if (!preds.some(({ from }) => shifted.has(from))) continue;
    const desired = Math.max(
      ...preds.map(({ from, branchIdx }) => (gridMap.get(from)?.row ?? 0) + branchIdx),
    );
    if (desired > entry.row) {
      gridMap.set(name, { col: entry.col, row: desired });
      shifted.add(name);
    }
  }

  const colRowBuckets = new Map<number, Map<number, string[]>>();
  for (const name of names) {
    const e = gridMap.get(name);
    if (!e) continue;
    if (!colRowBuckets.has(e.col)) colRowBuckets.set(e.col, new Map());
    const rm = colRowBuckets.get(e.col)!;
    if (!rm.has(e.row)) rm.set(e.row, []);
    rm.get(e.row)!.push(name);
  }
  for (const [, rowMap] of colRowBuckets.entries()) {
    for (const [startRow, ns] of rowMap.entries()) {
      if (ns.length < 2) continue;
      ns.sort((a, b) => {
        const aBI = Math.max(0, ...(predMap.get(a) ?? []).map((p) => p.branchIdx));
        const bBI = Math.max(0, ...(predMap.get(b) ?? []).map((p) => p.branchIdx));
        return aBI - bBI;
      });
      ns.forEach((n, i) => {
        const e = gridMap.get(n)!;
        gridMap.set(n, { col: e.col, row: startRow + i });
      });
    }
  }
}
