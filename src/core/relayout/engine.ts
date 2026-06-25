import { buildLayoutConfig } from "../config.js";
import type { N8nWorkflow, RelayoutOptions, RelayoutReport, RelayoutResult } from "../types.js";
import { analyzeWorkflow, computeStickyGroups } from "./analysis.js";
import { createElkInstance, runElkLayout } from "./elk.js";
import { buildWorkflowGraph } from "./graph.js";
import {
  applyPlacementPlan,
  placeAiSubNodes,
  placeGlobalHandlers,
  placeOrphans,
  placeSections,
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
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw new Error("not an n8n workflow: expected an object with a nodes[] array");
  }

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

  const elk = createElkInstance();
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
  // `globalHandlerNames` (string set) is intentionally not destructured — the engine uses
  // the `globalHandlers` node array directly to populate `report.globalHandlers`.
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
