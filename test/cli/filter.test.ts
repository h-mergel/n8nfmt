import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "src", "cli", "index.ts");

function run(args: string[], input?: string) {
  return spawnSync("npx", ["tsx", cli, ...args], { input, encoding: "utf8" });
}

const wf = JSON.stringify({
  nodes: [{ name: "A", type: "n8n-nodes-base.set", position: [9, 9] }],
  connections: {},
});

describe("CLI filter mode", () => {
  it("reads stdin and writes canonical JSON to stdout", () => {
    const r = run([], wf);
    expect(r.status).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(r.stdout).nodes[0].name).toBe("A");
  });

  it("--version prints the version", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 2 on empty stdin", () => {
    const r = run([], "");
    expect(r.status).toBe(2);
  });
});
