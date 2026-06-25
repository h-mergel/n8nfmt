import { createRequire } from "node:module";
import { buildLayoutConfig } from "../config.js";
import type {
  N8nWorkflow,
  RelayoutOptions,
  RelayoutResult,
  RelayoutReport,
} from "../types.js";
import type { ElkLayouter } from "./elk.js";
import { buildWorkflowGraph } from "./graph.js";
import { runElkLayout } from "./elk.js";
import { computeStickyGroups, analyzeWorkflow } from "./analysis.js";
import {
  placeSections,
  placeOrphans,
  placeGlobalHandlers,
  placeAiSubNodes,
  applyPlacementPlan,
} from "./placement.js";
import type { PlacementPlan } from "./placement.js";

/**
 * Lays out a single workflow. Pure: clones the input, never logs, never sets
 * process state, never writes `_meta`. All diagnostics go into `report`.
 */
export async function relayout(
  workflow: N8nWorkflow,
  options: RelayoutOptions = {},
): Promise<RelayoutResult> {
  const config = buildLayoutConfig(options.config);
  const rankSep = options.rankSep ?? 80;
  const nodeSep = options.nodeSep ?? 100;

  const wf = structuredClone(workflow);
  const warnings: string[] = [];
  const report: RelayoutReport = {
    totalNodes: wf.nodes.length,
    nodesChanged: 0,
    cyclicEdges: [],
    globalHandlers: [],
    warnings,
  };

  if (wf.nodes.length === 0) return { workflow: wf, report };

  const stickyGroups = computeStickyGroups(wf.nodes);
  const graph = buildWorkflowGraph(wf);
  const { layoutNodes, stickyNodes, aiChildToParent, safeEdges, cyclicEdges, branchIndexByEdge } =
    graph;

  if (layoutNodes.length === 0) return { workflow: wf, report };
  report.cyclicEdges = cyclicEdges;

  const _require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports
  const ELKCtor = _require("elkjs/lib/elk.bundled.js") as { new(): ElkLayouter };
  const elk = new ELKCtor();
  const elkPositions = await runElkLayout(
    elk,
    layoutNodes,
    stickyNodes,
    stickyGroups,
    safeEdges,
    rankSep,
    nodeSep,
  );

  const analysis = analyzeWorkflow(wf, graph, stickyGroups);
  const { sections, bodyNodes, crossIndentedSections, bypassNodeNames, orphans, globalHandlers } =
    analysis;

  report.globalHandlers = globalHandlers.map((n) => n.name);
  if (crossIndentedSections.size > 0) {
    warnings.push(
      `cross-indented sections: ${[...crossIndentedSections].sort((a, b) => a - b).join(", ")}`,
    );
  }
  if (bypassNodeNames.size > 0) {
    warnings.push(`bypass-lane nodes: ${[...bypassNodeNames].join(", ")}`);
  }

  const sectionResult = placeSections(
    sections,
    elkPositions,
    cyclicEdges,
    safeEdges,
    branchIndexByEdge,
    crossIndentedSections,
    bypassNodeNames,
    bodyNodes,
    aiChildToParent,
    config,
  );
  const orphanResult = placeOrphans(
    orphans,
    safeEdges,
    cyclicEdges,
    branchIndexByEdge,
    elkPositions,
    sectionResult.nextX,
    config,
  );
  const handlerPlacements = placeGlobalHandlers(
    globalHandlers,
    sections,
    sectionResult,
    orphanResult.nextX,
    config,
  );

  const allPositions = new Map<string, [number, number]>([
    ...sectionResult.nodePlacements.map((p) => [p.name, p.position] as [string, [number, number]]),
    ...orphanResult.nodePlacements.map((p) => [p.name, p.position] as [string, [number, number]]),
    ...handlerPlacements.map((p) => [p.name, p.position] as [string, [number, number]]),
  ]);
  const aiPlacements = placeAiSubNodes(aiChildToParent, allPositions, config);

  const plan: PlacementPlan = {
    nodePlacements: [
      ...sectionResult.nodePlacements,
      ...orphanResult.nodePlacements,
      ...handlerPlacements,
      ...aiPlacements,
    ],
    stickyPlacements: sectionResult.stickyPlacements,
  };

  report.nodesChanged = applyPlacementPlan(wf, plan);
  return { workflow: wf, report };
}
