// ---------------------------------------------------------------------------
// Internal scorer — pure function, no CLI, no file I/O, no console output.
// Consumed only by the dev optimizer (Task 10) and tests.
// NOT re-exported from src/core/index.ts.
// ---------------------------------------------------------------------------

import { isSticky, nodeDimensions } from "../relayout/nodes.js";
import type { N8nNode, N8nWorkflow } from "../types.js";

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------
export interface ScoreResult {
  score: number;
  rawScore: number;
  metrics: Record<string, number>;
  violationGroups: Array<{ rootCause: string; count: number }>;
  hardConstraintsPassed: boolean;
  hardViolations: Array<{ type: string; node: string; expectedSticky: string }>;
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------
interface Edge {
  from: string;
  to: string;
  channel: string;
  branchIndex: number;
  isCyclic: boolean;
}

function extractEdges(wf: N8nWorkflow): Edge[] {
  const edges: Edge[] = [];
  for (const [sourceName, channels] of Object.entries(wf.connections ?? {})) {
    for (const [channelName, branches] of Object.entries(channels)) {
      if (!branches) continue;
      branches.forEach((branch, branchIdx) => {
        if (!branch) return;
        for (const conn of branch) {
          if (conn?.node) {
            edges.push({
              from: sourceName,
              to: conn.node,
              channel: channelName,
              branchIndex: branchIdx,
              isCyclic: false,
            });
          }
        }
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Cyclic detection: targetX < sourceX
// ---------------------------------------------------------------------------
function markCyclicEdges(edges: Edge[], nodeMap: Map<string, N8nNode>): void {
  for (const e of edges) {
    const src = nodeMap.get(e.from);
    const tgt = nodeMap.get(e.to);
    if (!src || !tgt) continue;
    if (tgt.position[0] < src.position[0]) e.isCyclic = true;
  }
}

// ---------------------------------------------------------------------------
// Port anchors
// ---------------------------------------------------------------------------
function sourcePort(n: N8nNode, channel: string): [number, number] {
  const { width: w, height: h } = nodeDimensions(n);
  const [x, y] = n.position;
  if (channel.startsWith("ai_")) return [x + w / 2, y];
  return [x + w, y + h / 2];
}

function targetPort(n: N8nNode, channel: string): [number, number] {
  const { width: w, height: h } = nodeDimensions(n);
  const [x, y] = n.position;
  if (channel.startsWith("ai_")) return [x + w / 2, y + h];
  return [x, y + h / 2];
}

// ---------------------------------------------------------------------------
// Bézier path
// ---------------------------------------------------------------------------
function sampleCubicBezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  n: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const x = mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0];
    const y = mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1];
    pts.push([x, y]);
  }
  return pts;
}

function getBezierPath(sx: number, sy: number, tx: number, ty: number): Array<[number, number]> {
  const dist = tx - sx;
  const offset = dist >= 0 ? 0.5 * dist : 0.25 * 25 * Math.sqrt(-dist);
  return sampleCubicBezier([sx, sy], [sx + offset, sy], [tx - offset, ty], [tx, ty], 20);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = dx - cx;
  const d2y = dy - cy;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

function segmentIntersectsAABB(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  if (ax >= left && ax <= right && ay >= top && ay <= bottom) return true;
  if (bx >= left && bx <= right && by >= top && by <= bottom) return true;
  return (
    segmentsIntersect(ax, ay, bx, by, left, top, right, top) ||
    segmentsIntersect(ax, ay, bx, by, right, top, right, bottom) ||
    segmentsIntersect(ax, ay, bx, by, right, bottom, left, bottom) ||
    segmentsIntersect(ax, ay, bx, by, left, bottom, left, top)
  );
}

// ---------------------------------------------------------------------------
// Violation types
// ---------------------------------------------------------------------------
type EdgeType =
  | "cross_section_backward"
  | "intra_section_backward"
  | "cross_section_forward"
  | "forward";

type RootCause =
  | "cross_section_backward_edge"
  | "intra_section_backward_edge"
  | "node_outside_section"
  | "node_overlap"
  | "y_alignment"
  | "parameter_tunable";

interface ViolationGroup {
  rootCause: RootCause;
  count: number;
  fixable: string;
  suggestion: string;
  affectedEdges: [string, string][];
  affectedNodes: string[];
}

interface Violation {
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  parameterSensitive: boolean;
  edgeType?: EdgeType;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Section map (from sticky bounding boxes, sorted L→R by x)
// ---------------------------------------------------------------------------
function buildSectionMap(nodes: N8nNode[]): Map<string, number> {
  const stickies = nodes
    .filter((n) => n.type === "n8n-nodes-base.stickyNote")
    .sort((a, b) => a.position[0] - b.position[0]);
  const sections = stickies.map((s, idx) => ({
    idx,
    x: s.position[0],
    y: s.position[1],
    w: (s.parameters?.width as number | undefined) ?? 240,
    h: (s.parameters?.height as number | undefined) ?? 160,
  }));
  const nodeToSection = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === "n8n-nodes-base.stickyNote") continue;
    const [nx, ny] = node.position;
    for (const sec of sections) {
      if (nx >= sec.x && nx < sec.x + sec.w && ny >= sec.y && ny < sec.y + sec.h) {
        nodeToSection.set(node.name, sec.idx);
        break;
      }
    }
  }
  return nodeToSection;
}

// ---------------------------------------------------------------------------
// Hard-constraint types and functions
// ---------------------------------------------------------------------------
type HardViolation =
  | { type: "node_outside_assigned_sticky"; node: string; expectedSticky: string; severity: "hard" }
  | { type: "sticky_membership_lost"; node: string; expectedSticky: string; severity: "hard" }
  | { type: "unexpected_bypass_node"; node: string; expectedSticky: ""; severity: "hard" };

function buildMembershipSnapshot(wf: N8nWorkflow): Map<string, string> {
  const stickies = wf.nodes
    .filter((n) => n.type === "n8n-nodes-base.stickyNote")
    .map((s) => ({
      name: s.name,
      x: s.position[0],
      y: s.position[1],
      w: (s.parameters?.width as number | undefined) ?? 240,
      h: (s.parameters?.height as number | undefined) ?? 160,
    }));
  const membership = new Map<string, string>();
  for (const n of wf.nodes) {
    if (n.type === "n8n-nodes-base.stickyNote") continue;
    const [nx, ny] = n.position;
    for (const s of stickies) {
      if (nx >= s.x && nx < s.x + s.w && ny >= s.y && ny < s.y + s.h) {
        membership.set(n.name, s.name);
        break;
      }
    }
  }
  return membership;
}

function checkHardConstraints(
  originalMembership: Map<string, string>,
  candidate: N8nWorkflow,
): { passed: boolean; violations: HardViolation[] } {
  const violations: HardViolation[] = [];
  const candidateStickies = candidate.nodes.filter(isSticky).map((s) => ({
    name: s.name,
    x: s.position[0],
    y: s.position[1],
    w: (s.parameters?.width as number | undefined) ?? 240,
    h: (s.parameters?.height as number | undefined) ?? 160,
  }));
  const candidateStickyMap = new Map(candidateStickies.map((s) => [s.name, s]));

  const gridTop = candidateStickies.length > 0 ? Math.min(...candidateStickies.map((s) => s.y)) : 0;
  const gridBottom =
    candidateStickies.length > 0 ? Math.max(...candidateStickies.map((s) => s.y + s.h)) : 0;
  const gridRight =
    candidateStickies.length > 0 ? Math.max(...candidateStickies.map((s) => s.x + s.w)) : 0;

  for (const candNode of candidate.nodes) {
    if (isSticky(candNode)) continue;
    const [nx, ny] = candNode.position;

    if (ny < 0) {
      const declared = candidate._meta?.bypassNodes ?? [];
      if (!declared.includes(candNode.name)) {
        violations.push({
          type: "unexpected_bypass_node",
          node: candNode.name,
          expectedSticky: "",
          severity: "hard",
        });
      }
      continue;
    }

    const expectedSticky = originalMembership.get(candNode.name);
    if (!expectedSticky) continue;
    if (nx >= gridRight && ny >= gridTop && ny < gridBottom) continue; // R11: handler right of stickies
    if ((candidate._meta?.globalHandlers ?? []).includes(candNode.name)) continue; // R11: handler below stickies

    const sticky = candidateStickyMap.get(expectedSticky);
    if (!sticky) {
      violations.push({
        type: "sticky_membership_lost",
        node: candNode.name,
        expectedSticky,
        severity: "hard",
      });
      continue;
    }
    if (
      !(nx >= sticky.x && nx < sticky.x + sticky.w && ny >= sticky.y && ny < sticky.y + sticky.h)
    ) {
      violations.push({
        type: "node_outside_assigned_sticky",
        node: candNode.name,
        expectedSticky,
        severity: "hard",
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Edge type classification
// ---------------------------------------------------------------------------
function classifyEdge(
  from: string,
  to: string,
  nodeToSection: Map<string, number>,
  nodeMap: Map<string, N8nNode>,
): EdgeType {
  const secFrom = nodeToSection.get(from);
  const secTo = nodeToSection.get(to);
  if (secFrom !== undefined && secTo !== undefined) {
    if (secFrom > secTo) return "cross_section_backward";
    if (secFrom < secTo - 1) return "cross_section_forward";
  }
  const nFrom = nodeMap.get(from);
  const nTo = nodeMap.get(to);
  if (nFrom && nTo && nFrom.position[0] > nTo.position[0]) {
    return secFrom === secTo ? "intra_section_backward" : "cross_section_backward";
  }
  return "forward";
}

// ---------------------------------------------------------------------------
// Violation grouping
// ---------------------------------------------------------------------------
function groupViolations(violations: Violation[]): ViolationGroup[] {
  const SUGGESTIONS: Record<RootCause, string> = {
    cross_section_backward_edge:
      "source.sectionIdx > target.sectionIdx — add bypass lane (R12) or reroute these nodes",
    intra_section_backward_edge:
      "cyclic within section — R5 loop-spreading handles column offset; consider ROW_STEP increase",
    node_outside_section:
      "node position falls outside all sticky-note bounding boxes after auto-resize — likely a bypass-lane or orphan node that was not excluded correctly",
    node_overlap: "nodes placed too close — increase nodesep or MIN_GAP",
    y_alignment: "Y-drift on main path — check ROW_STEP and section grouping",
    parameter_tunable: "reducible by parameter tuning — run optimizer",
  };
  const FIXABLE: Record<RootCause, string> = {
    cross_section_backward_edge: "layout_rule",
    intra_section_backward_edge: "layout_rule",
    node_outside_section: "optimizer",
    node_overlap: "optimizer",
    y_alignment: "optimizer",
    parameter_tunable: "optimizer",
  };

  const groups = new Map<RootCause, { count: number; edges: Set<string>; nodes: Set<string> }>();

  const touch = (cause: RootCause, v: Violation) => {
    const g = groups.get(cause) ?? { count: 0, edges: new Set<string>(), nodes: new Set<string>() };
    g.count++;
    if ("edge" in v) g.edges.add(JSON.stringify(v.edge));
    if ("edge1" in v) {
      g.edges.add(JSON.stringify(v.edge1));
      g.edges.add(JSON.stringify(v.edge2));
    }
    if ("node" in v && typeof v.node === "string") g.nodes.add(v.node);
    groups.set(cause, g);
  };

  for (const v of violations) {
    if (!v.parameterSensitive && v.edgeType === "cross_section_backward") {
      touch("cross_section_backward_edge", v);
    } else if (!v.parameterSensitive && v.edgeType === "intra_section_backward") {
      touch("intra_section_backward_edge", v);
    } else if (v.type === "node_outside_section") {
      touch("node_outside_section", v);
    } else if (v.type === "node_overlap") {
      touch("node_overlap", v);
    } else if (v.type === "y_drift" || v.type === "y_asymmetry") {
      touch("y_alignment", v);
    } else {
      touch("parameter_tunable", v);
    }
  }

  return [...groups.entries()].map(([cause, g]) => ({
    rootCause: cause,
    count: g.count,
    fixable: FIXABLE[cause],
    suggestion: SUGGESTIONS[cause],
    affectedEdges: [...g.edges].map((e) => JSON.parse(e) as [string, string]),
    affectedNodes: [...g.nodes],
  }));
}

// ---------------------------------------------------------------------------
// Internal scoring computation
// ---------------------------------------------------------------------------
function computeScore(wf: N8nWorkflow): {
  score: number;
  rawScore: number;
  violations: Violation[];
  metrics: Record<string, number>;
  violationGroups: ViolationGroup[];
} {
  const violations: Violation[] = [];
  const nodeMap = new Map(wf.nodes.map((n) => [n.name, n]));
  const nonSticky = wf.nodes.filter((n) => !isSticky(n));
  const nodeToSection = buildSectionMap(wf.nodes);

  const edges = extractEdges(wf);
  markCyclicEdges(edges, nodeMap);

  // Precompute bézier paths per edge
  const edgePaths: Array<Array<[number, number]>> = edges.map((e) => {
    const src = nodeMap.get(e.from);
    const tgt = nodeMap.get(e.to);
    if (!src || !tgt) return [];
    const [sx, sy] = sourcePort(src, e.channel);
    const [tx, ty] = targetPort(tgt, e.channel);
    return getBezierPath(sx, sy, tx, ty);
  });

  // 1. Node overlaps
  let nodeOverlaps = 0;
  for (let i = 0; i < nonSticky.length; i++) {
    for (let j = i + 1; j < nonSticky.length; j++) {
      const a = nonSticky[i]!;
      const b = nonSticky[j]!;
      const [ax, ay] = a.position;
      const { width: aw, height: ah } = nodeDimensions(a);
      const [bx, by] = b.position;
      const { width: bw, height: bh } = nodeDimensions(b);
      if (ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by) {
        nodeOverlaps++;
        violations.push({
          type: "node_overlap",
          nodes: [a.name, b.name],
          severity: "critical",
          parameterSensitive: true,
        });
      }
    }
  }

  // 2. Edge-node intersections (skip cyclic, skip own source/target)
  let edgeNodeIntersections = 0;
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]!;
    const path = edgePaths[ei]!;
    if (e.isCyclic || path.length < 2) continue;
    for (const node of nonSticky) {
      if (node.name === e.from || node.name === e.to) continue;
      const [nx, ny] = node.position;
      const { width: w, height: h } = nodeDimensions(node);
      let hit = false;
      for (let pi = 0; pi < path.length - 1 && !hit; pi++) {
        if (
          segmentIntersectsAABB(
            path[pi]![0],
            path[pi]![1],
            path[pi + 1]![0],
            path[pi + 1]![1],
            nx,
            ny,
            nx + w,
            ny + h,
          )
        ) {
          hit = true;
        }
      }
      if (hit) {
        edgeNodeIntersections++;
        const et = classifyEdge(e.from, e.to, nodeToSection, nodeMap);
        violations.push({
          type: "edge_node_intersection",
          edge: [e.from, e.to],
          node: node.name,
          severity: "high",
          parameterSensitive: et === "forward",
          edgeType: et,
        });
      }
    }
  }

  // 3. Edge crossings
  let edgeCrossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const pA = edgePaths[i]!;
      const pB = edgePaths[j]!;
      if (pA.length < 2 || pB.length < 2) continue;
      let crossed = false;
      outer: for (let a = 0; a < pA.length - 1 && !crossed; a++) {
        for (let b = 0; b < pB.length - 1; b++) {
          if (
            segmentsIntersect(
              pA[a]![0],
              pA[a]![1],
              pA[a + 1]![0],
              pA[a + 1]![1],
              pB[b]![0],
              pB[b]![1],
              pB[b + 1]![0],
              pB[b + 1]![1],
            )
          ) {
            crossed = true;
            break outer;
          }
        }
      }
      if (crossed) {
        edgeCrossings++;
        const severity = edges[i]!.isCyclic || edges[j]!.isCyclic ? "low" : "medium";
        const et = classifyEdge(edges[i]!.from, edges[i]!.to, nodeToSection, nodeMap);
        violations.push({
          type: "edge_crossing",
          edge1: [edges[i]!.from, edges[i]!.to],
          edge2: [edges[j]!.from, edges[j]!.to],
          severity,
          parameterSensitive: et === "forward",
          edgeType: et,
        });
      }
    }
  }

  // 4. Backward edges (non-cyclic only)
  let backwardEdges = 0;
  for (const e of edges) {
    if (e.isCyclic) continue;
    const src = nodeMap.get(e.from);
    const tgt = nodeMap.get(e.to);
    if (!src || !tgt) continue;
    if (src.position[0] > tgt.position[0]) {
      backwardEdges++;
      const et = classifyEdge(e.from, e.to, nodeToSection, nodeMap);
      violations.push({
        type: "backward_edge",
        edge: [e.from, e.to],
        severity: "low",
        parameterSensitive: false,
        edgeType: et,
      });
    }
  }

  // 5. Y drift on main path (branchIndex === 0, channel === "main")
  let yDriftMainPath = 0;
  for (const e of edges) {
    if (e.branchIndex !== 0 || e.channel !== "main") continue;
    const src = nodeMap.get(e.from);
    const tgt = nodeMap.get(e.to);
    if (!src || !tgt) continue;
    const [sx, sy] = sourcePort(src, "main");
    const [, ty] = targetPort(tgt, "main");
    const drift = Math.abs(sy - ty);
    yDriftMainPath += drift;
    if (drift > 0) {
      violations.push({
        type: "y_drift",
        edge: [e.from, e.to],
        drift: Math.round(drift),
        severity: "low",
        parameterSensitive: true,
      });
    }
  }

  // 6. Y asymmetry
  let yAsymmetryCount = 0;
  for (const node of nonSticky) {
    const { height: h } = nodeDimensions(node);
    const targets = edges
      .filter((e) => e.from === node.name && e.channel === "main")
      .map((e) => nodeMap.get(e.to))
      .filter((n): n is N8nNode => n !== undefined);
    if (targets.length < 2) continue;
    const avgTargetY =
      targets.reduce((s, t) => {
        const { height: th } = nodeDimensions(t);
        return s + t.position[1] + th / 2;
      }, 0) / targets.length;
    const nodeCenterY = node.position[1] + h / 2;
    const delta = Math.abs(nodeCenterY - avgTargetY);
    if (delta > 20) {
      yAsymmetryCount++;
      violations.push({
        type: "y_asymmetry",
        node: node.name,
        delta: Math.round(delta),
        severity: "low",
        parameterSensitive: true,
      });
    }
  }

  // 7. Nodes outside all sticky-note sections
  let nodeOutsideSection = 0;
  const stickies = wf.nodes
    .filter((n) => isSticky(n))
    .map((s) => ({
      x: s.position[0],
      y: s.position[1],
      w: (s.parameters?.width as number | undefined) ?? 240,
      h: (s.parameters?.height as number | undefined) ?? 160,
    }));
  if (stickies.length > 0) {
    const gridLeft = Math.min(...stickies.map((s) => s.x));
    const gridRight = Math.max(...stickies.map((s) => s.x + s.w));
    const gridTop = Math.min(...stickies.map((s) => s.y));
    for (const node of nonSticky) {
      const [nx, ny] = node.position;
      const insideAny = stickies.some(
        (s) => nx >= s.x && nx < s.x + s.w && ny >= s.y && ny < s.y + s.h,
      );
      if (!insideAny) {
        const isAboveGrid = ny < gridTop;
        const isRightOfAll = nx >= gridRight;
        const isLeftOfAll = nx < gridLeft;
        if (isAboveGrid || isRightOfAll || isLeftOfAll) continue;
        nodeOutsideSection++;
        violations.push({
          type: "node_outside_section",
          node: node.name,
          severity: "high",
          parameterSensitive: true,
          note: "sticky note should have been resized by relayout — possible bypass-lane or orphan node",
        });
      }
    }
  }

  // 8. Total edge length over median
  const edgeLengths = edges.map((e) => {
    const src = nodeMap.get(e.from);
    const tgt = nodeMap.get(e.to);
    if (!src || !tgt) return 0;
    const dx = tgt.position[0] - src.position[0];
    const dy = tgt.position[1] - src.position[1];
    return Math.sqrt(dx * dx + dy * dy);
  });
  const sorted = [...edgeLengths].sort((a, b) => a - b);
  const median = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;
  const totalEdgeLength = edgeLengths.reduce((s, l) => s + l, 0);
  const overMedianSum = edgeLengths.reduce((s, l) => s + Math.max(0, l - median), 0);

  // Compute penalties
  const penalties =
    nodeOverlaps * -50 +
    edgeNodeIntersections * -10 +
    edgeCrossings * -3 +
    edgeCrossings * 0 + // cyclic crossings already counted above; weight -1 handled below
    backwardEdges * -2 +
    yDriftMainPath * -0.01 +
    yAsymmetryCount * -0.5 +
    nodeOutsideSection * -200 +
    overMedianSum * -0.01;

  // Adjust: cyclic crossings were counted as -3, should be -1 (add back +2 per cyclic crossing)
  let cyclicCrossingCount = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (!edges[i]!.isCyclic && !edges[j]!.isCyclic) continue;
      const pA = edgePaths[i]!;
      const pB = edgePaths[j]!;
      if (pA.length < 2 || pB.length < 2) continue;
      let crossed = false;
      outer2: for (let a = 0; a < pA.length - 1 && !crossed; a++) {
        for (let b = 0; b < pB.length - 1; b++) {
          if (
            segmentsIntersect(
              pA[a]![0],
              pA[a]![1],
              pA[a + 1]![0],
              pA[a + 1]![1],
              pB[b]![0],
              pB[b]![1],
              pB[b + 1]![0],
              pB[b + 1]![1],
            )
          ) {
            crossed = true;
            break outer2;
          }
        }
      }
      if (crossed) cyclicCrossingCount++;
    }
  }
  const adjustedPenalties = penalties + cyclicCrossingCount * 2;

  const rawScore = Math.round(100 + adjustedPenalties);
  const finalScore = Math.max(0, Math.min(100, rawScore));

  const metrics = {
    edgeNodeIntersections,
    edgeCrossings,
    backwardEdges,
    nodeOverlaps,
    nodeOutsideSection,
    yDriftMainPath: Math.round(yDriftMainPath),
    yAsymmetryCount,
    totalEdgeLength: Math.round(totalEdgeLength),
    rawScore,
    score: finalScore,
  };

  const violationGroups = groupViolations(violations);
  return { score: finalScore, rawScore, violations, metrics, violationGroups };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function score(workflow: N8nWorkflow, original?: N8nWorkflow): ScoreResult {
  const computed = computeScore(workflow);

  let hardConstraintsPassed = true;
  let hardViolations: Array<{ type: string; node: string; expectedSticky: string }> = [];

  if (original !== undefined) {
    const membership = buildMembershipSnapshot(original);
    const hc = checkHardConstraints(membership, workflow);
    hardConstraintsPassed = hc.passed;
    hardViolations = hc.violations.map((v) => ({
      type: v.type,
      node: v.node,
      expectedSticky: v.expectedSticky,
    }));
  }

  return {
    score: computed.score,
    rawScore: computed.rawScore,
    metrics: computed.metrics,
    violationGroups: computed.violationGroups.map((g) => ({
      rootCause: g.rootCause,
      count: g.count,
    })),
    hardConstraintsPassed,
    hardViolations,
  };
}
