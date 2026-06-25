import fc from "fast-check";
import { describe, it } from "vitest";
import { relayout, serialize } from "../../src/core/index.js";
import { arbWorkflow } from "./arbitraries.js";

describe("properties", () => {
  it("is idempotent for arbitrary workflows", async () => {
    await fc.assert(
      fc.asyncProperty(arbWorkflow, async (wf) => {
        const once = (await relayout(wf)).workflow;
        const twice = (await relayout(once)).workflow;
        return serialize(once) === serialize(twice);
      }),
      { numRuns: 50 },
    );
  }, 60_000);

  it("never adds _meta and preserves the node set", async () => {
    await fc.assert(
      fc.asyncProperty(arbWorkflow, async (wf) => {
        const { workflow } = await relayout(wf);
        const names = (w: typeof wf) =>
          w.nodes
            .map((n) => n.name)
            .sort()
            .join(",");
        return !("_meta" in workflow) && names(workflow) === names(wf);
      }),
      { numRuns: 50 },
    );
  }, 60_000);
});
