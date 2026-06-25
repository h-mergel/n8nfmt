import { describe, expect, it } from "vitest";
import { score } from "../../src/core/score/index.js";
import { relayout } from "../../src/core/index.js";
import type { N8nWorkflow } from "../../src/core/types.js";

const sticky = (name: string, x: number, y: number, w = 600, h = 400) => ({
  name, type: "n8n-nodes-base.stickyNote", position: [x, y] as [number, number],
  parameters: { width: w, height: h },
});
const node = (name: string, x: number, y: number) => ({
  name, type: "n8n-nodes-base.set", position: [x, y] as [number, number],
});
const wf = (nodes: object[], connections: object = {}): N8nWorkflow =>
  ({ nodes, connections } as N8nWorkflow);

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
    const clean = score(wf([sticky("S", 0, 0, 800, 400), node("A", 100, 100), node("B", 400, 100)]));
    const overlap = score(wf([sticky("S", 0, 0, 800, 400), node("A", 100, 100), node("B", 100, 100)]));
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
});
