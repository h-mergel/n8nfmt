import { describe, expect, it } from "vitest";
import { relayout } from "../../src/core/index.js";
import { score } from "../../src/core/score/index.js";
import type { N8nWorkflow } from "../../src/core/types.js";

const sticky = (name: string, x: number, y: number, w = 600, h = 400) => ({
  name,
  type: "n8n-nodes-base.stickyNote",
  position: [x, y] as [number, number],
  parameters: { width: w, height: h },
});
const node = (name: string, x: number, y: number) => ({
  name,
  type: "n8n-nodes-base.set",
  position: [x, y] as [number, number],
});
const wf = (nodes: object[], connections: object = {}): N8nWorkflow =>
  ({ nodes, connections }) as N8nWorkflow;

/**
 * Minimal workflow that produces a global handler:
 *
 *  Section A (sticky "SA"):  NodeA1 --[error]--> Handler
 *  Section B (sticky "SB"):  NodeB1 --[error]--> Handler
 *
 * Handler receives error connections from nodes in 2 different sections,
 * so detectGlobalErrorHandlers() classifies it as a global handler.
 */
function makeHandlerWorkflow(): N8nWorkflow {
  return {
    nodes: [
      {
        name: "SA",
        type: "n8n-nodes-base.stickyNote",
        position: [0, 0] as [number, number],
        parameters: { width: 500, height: 400 },
      },
      {
        name: "SB",
        type: "n8n-nodes-base.stickyNote",
        position: [600, 0] as [number, number],
        parameters: { width: 500, height: 400 },
      },
      { name: "NodeA1", type: "n8n-nodes-base.set", position: [100, 100] as [number, number] },
      { name: "NodeB1", type: "n8n-nodes-base.set", position: [700, 100] as [number, number] },
      { name: "Handler", type: "n8n-nodes-base.set", position: [400, 100] as [number, number] },
    ],
    connections: {
      NodeA1: {
        error: [[{ node: "Handler", type: "error", index: 0 }]],
      },
      NodeB1: {
        error: [[{ node: "Handler", type: "error", index: 0 }]],
      },
    },
  };
}

describe("score", () => {
  it("detects overlapping nodes", () => {
    const r = score(wf([sticky("S", 0, 0, 800, 600), node("A", 100, 100), node("B", 100, 100)]));
    expect(r.metrics.nodeOverlaps).toBeGreaterThanOrEqual(1);
  });

  it("flags a node outside all sections", () => {
    const r = score(wf([sticky("S", 0, 0, 400, 300), node("In", 50, 50), node("Out", 100, 9999)]));
    expect(r.metrics.nodeOutsideSection).toBeGreaterThanOrEqual(1);
  });

  it("clean layout scores better than overlapping", () => {
    const clean = score(
      wf([sticky("S", 0, 0, 800, 400), node("A", 100, 100), node("B", 400, 100)]),
    );
    const overlap = score(
      wf([sticky("S", 0, 0, 800, 400), node("A", 100, 100), node("B", 100, 100)]),
    );
    expect(clean.rawScore).toBeGreaterThan(overlap.rawScore);
  });

  it("hard constraint fails when a node leaves its assigned sticky", () => {
    const original = wf([sticky("A", 0, 0, 600, 400), node("A1", 100, 100)]);
    const candidate = wf([sticky("A", 0, 0, 600, 400), node("A1", 100, 500)]);
    const r = score(candidate, original);
    expect(r.hardConstraintsPassed).toBe(false);
  });

  it("relayout output satisfies sticky-containment hard constraints", async () => {
    const original = wf([sticky("S", 0, 0, 600, 400), node("A", 50, 50), node("B", 250, 150)]);
    const relayouted = (await relayout(original)).workflow;
    const r = score(relayouted, original);
    const containment = r.hardViolations.filter((v) => v.type === "node_outside_assigned_sticky");
    expect(containment).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // B: global-handler exemption via report → _meta path
  // ---------------------------------------------------------------------------
  it("global-handler exemption: with _meta set, handler is NOT flagged as outside sticky", async () => {
    const input = makeHandlerWorkflow();
    const { workflow: candidate, report } = await relayout(input);

    // The engine must identify Handler as a global handler
    expect(report.globalHandlers.length).toBeGreaterThan(0);
    expect(report.globalHandlers).toContain("Handler");

    // Feed the report context back (as the optimizer does after fix A)
    candidate._meta = { globalHandlers: report.globalHandlers };

    const result = score(candidate, input);
    const handlerViolations = result.hardViolations.filter(
      (v) => v.type === "node_outside_assigned_sticky" && report.globalHandlers.includes(v.node),
    );
    expect(handlerViolations).toHaveLength(0);
  });

  it("global-handler exemption: WITHOUT _meta, handler IS flagged (proving context matters)", async () => {
    const input = makeHandlerWorkflow();
    const { workflow: candidate, report } = await relayout(input);

    expect(report.globalHandlers.length).toBeGreaterThan(0);

    // Do NOT set candidate._meta — scorer has no exemption context
    const result = score(candidate, input);
    const handlerViolations = result.hardViolations.filter(
      (v) => v.type === "node_outside_assigned_sticky" && report.globalHandlers.includes(v.node),
    );
    expect(handlerViolations.length).toBeGreaterThan(0);
  });
});
