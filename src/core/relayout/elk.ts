import { createRequire } from "node:module";
import type { ElkExtendedEdge, ElkNode } from "elkjs";
import type { Edge, LayoutPos, N8nNode } from "../types.js";
import { STICKY_DEFAULT_HEIGHT, STICKY_DEFAULT_WIDTH, nodeDimensions } from "./nodes.js";

export interface ElkLayouter {
  layout(graph: ElkNode): Promise<ElkNode>;
}

const requireCjs = createRequire(import.meta.url);
const ElkConstructor = requireCjs("elkjs/lib/elk.bundled.js") as { new (): ElkLayouter };

/**
 * Instantiate the ELK engine. elkjs is a CommonJS bundle; `createRequire` is the
 * ESM-interop load under `verbatimModuleSyntax` + NodeNext. It is a pure in-process
 * module load (no I/O), so it does not violate the "core is silent" constraint.
 * Loaded once at module init, not per call.
 */
export function createElkInstance(): ElkLayouter {
  return new ElkConstructor();
}

// ---------------------------------------------------------------------------
// ELK graph construction and layout
// ---------------------------------------------------------------------------

function extractElkPositions(
  node: ElkNode,
  offsetX: number,
  offsetY: number,
  out: Map<string, LayoutPos>,
): void {
  const x = (node.x ?? 0) + offsetX;
  const y = (node.y ?? 0) + offsetY;
  if (node.id !== "root") out.set(node.id, { x, y });
  for (const child of node.children ?? []) {
    extractElkPositions(child, x, y, out);
  }
}

/**
 * Build an ELK compound graph from layout nodes + sticky groups, run the
 * layered layout algorithm, and return a map of node-name → {x, y}.
 *
 * The returned positions are used for column/row ordering only — absolute
 * pixel placement is handled by the section-aware grid (R6–R9).
 */
export async function runElkLayout(
  elkInstance: ElkLayouter,
  layoutNodes: N8nNode[],
  stickyNodes: N8nNode[],
  stickyGroups: Map<string, Set<string>>,
  safeEdges: Edge[],
  rankSep: number,
  nodeSep: number,
): Promise<Map<string, LayoutPos>> {
  // Map each member node to the sticky it belongs to
  const stickyMemberToGroup = new Map<string, string>();
  for (const [stickyName, members] of stickyGroups.entries()) {
    for (const memberName of members) {
      stickyMemberToGroup.set(memberName, stickyName);
    }
  }

  // Build top-level ELK nodes (stickies become compound parents)
  const topLevelElkNodes: ElkNode[] = [];

  for (const sticky of stickyNodes) {
    const sw = sticky.parameters?.width ?? STICKY_DEFAULT_WIDTH;
    const sh = sticky.parameters?.height ?? STICKY_DEFAULT_HEIGHT;
    const memberChildren: ElkNode[] = layoutNodes
      .filter((n) => stickyMemberToGroup.get(n.name) === sticky.name)
      .map((n) => {
        const { width, height } = nodeDimensions(n);
        return { id: n.name, width, height };
      });
    topLevelElkNodes.push({ id: sticky.name, width: sw, height: sh, children: memberChildren });
  }

  for (const node of layoutNodes) {
    if (!stickyMemberToGroup.has(node.name)) {
      const { width, height } = nodeDimensions(node);
      topLevelElkNodes.push({ id: node.name, width, height });
    }
  }

  const elkEdges: ElkExtendedEdge[] = safeEdges.map(([from, to], i) => ({
    id: `e${i}`,
    sources: [from],
    targets: [to],
  }));

  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(rankSep),
      "elk.spacing.nodeNode": String(nodeSep),
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.mergeHierarchyEdges": "true",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: topLevelElkNodes,
    edges: elkEdges,
  };

  const layoutResult = await elkInstance.layout(elkGraph);

  const elkPositions = new Map<string, LayoutPos>();
  extractElkPositions(layoutResult, 0, 0, elkPositions);
  return elkPositions;
}
