import { describe, expect, it } from "vitest";
import { relayout } from "../../src/core/relayout/engine.js";
import type { N8nWorkflow } from "../../src/core/types.js";

function twoNodeFlow(): N8nWorkflow {
  return {
    nodes: [
      { name: "A", type: "n8n-nodes-base.set", position: [999, 999] },
      { name: "B", type: "n8n-nodes-base.set", position: [0, 0] },
    ],
    connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
  };
}

describe("relayout", () => {
  it("returns a report and repositions nodes", async () => {
    const { workflow, report } = await relayout(twoNodeFlow());
    expect(report.totalNodes).toBe(2);
    expect(report.nodesChanged).toBeGreaterThan(0);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it("does not mutate the input object", async () => {
    const input = twoNodeFlow();
    const snapshot = structuredClone(input);
    await relayout(input);
    expect(input).toEqual(snapshot);
  });

  it("never writes _meta into the output workflow", async () => {
    const { workflow } = await relayout(twoNodeFlow());
    expect("_meta" in workflow).toBe(false);
  });

  it("handles an empty workflow without throwing", async () => {
    const { report } = await relayout({ nodes: [], connections: {} });
    expect(report.totalNodes).toBe(0);
    expect(report.nodesChanged).toBe(0);
  });

  it("throws a clear error for non-workflow input (missing nodes array)", async () => {
    await expect(relayout({} as unknown as N8nWorkflow)).rejects.toThrow(/not an n8n workflow/);
  });
});
