import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { relayout, serialize } from "../../src/core/index.js";
import type { N8nWorkflow } from "../../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

function load(file: string): N8nWorkflow {
  return JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as N8nWorkflow;
}

describe("invariants", () => {
  it("loaded the fixtures (guards against an empty fixtures dir)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("idempotent: relayout(relayout(%s)) == relayout(%s)", async (file) => {
    const once = (await relayout(load(file))).workflow;
    const twice = (await relayout(once)).workflow;
    expect(serialize(twice)).toBe(serialize(once));
  });

  it.each(files)("deterministic: two runs of %s produce identical bytes", async (file) => {
    const a = (await relayout(load(file))).workflow;
    const b = (await relayout(load(file))).workflow;
    expect(serialize(a)).toBe(serialize(b));
  });

  it.each(files)("only geometry changes for %s (same node set & types)", async (file) => {
    const input = load(file);
    const { workflow } = await relayout(input);
    const sig = (wf: N8nWorkflow) =>
      wf.nodes.map((n) => `${n.name}:${n.type}`).sort().join("|");
    expect(sig(workflow)).toBe(sig(input));
    // _meta: relayout must not ADD it; if the input had it, it must round-trip untouched (spec §8).
    if ("_meta" in input) {
      expect(workflow._meta).toEqual((input as { _meta: unknown })._meta);
    } else {
      expect("_meta" in workflow).toBe(false);
    }
  });
});
