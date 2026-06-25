import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { relayout } from "../../src/core/index.js";
import type { N8nWorkflow } from "../../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const snapshotsDir = join(here, "..", "snapshots");

function positions(wf: N8nWorkflow) {
  return wf.nodes
    .map((n) => ({ name: n.name, position: n.position }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

describe("golden snapshots", () => {
  it("loaded the migrated fixtures (guards against an empty/missing fixtures dir)", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files)("relayout(%s) matches its golden positions", async (file) => {
    const input = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as N8nWorkflow;
    const golden = JSON.parse(readFileSync(join(snapshotsDir, file), "utf8")) as N8nWorkflow;
    const { workflow } = await relayout(input);
    expect(positions(workflow)).toEqual(positions(golden));
  });
});
