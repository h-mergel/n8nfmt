import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "src", "cli", "index.ts");
const run = (args: string[]) => spawnSync("npx", ["tsx", cli, ...args], { encoding: "utf8" });

function tmpWorkflow(): string {
  const dir = mkdtempSync(join(tmpdir(), "n8nfmt-"));
  const file = join(dir, "wf.json");
  writeFileSync(
    file,
    JSON.stringify({
      nodes: [
        { name: "A", type: "n8n-nodes-base.set", position: [999, 999] },
        { name: "B", type: "n8n-nodes-base.set", position: [0, 0] },
      ],
      connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    }),
  );
  return file;
}

describe("CLI file modes", () => {
  it("exits 2 when paths are given without --write/--check", () => {
    const r = run([tmpWorkflow()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--write|--check/);
  });

  it("--check exits 1 on a non-canonical file", () => {
    const r = run(["--check", tmpWorkflow()]);
    expect(r.status).toBe(1);
  });

  it("exits 2 when both --write and --check are given", () => {
    const r = run(["--write", "--check", tmpWorkflow()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--write|--check/);
  });

  it("--write rewrites the file, after which --check passes (idempotent)", () => {
    const file = tmpWorkflow();
    expect(run(["--write", file]).status).toBe(0);
    const written = readFileSync(file, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(run(["--check", file]).status).toBe(0); // canonical now
  });
});
