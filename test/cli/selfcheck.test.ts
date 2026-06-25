import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "src", "cli", "index.ts");
const fixturesDir = join(here, "..", "fixtures");

describe("CLI self-check on real workflows (temp copy — no tracked-file mutation)", () => {
  it("--write canonicalizes real fixtures, then --check passes (idempotent)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "n8nfmt-selfcheck-"));
    for (const f of readdirSync(fixturesDir).filter((n) => n.endsWith(".json"))) {
      copyFileSync(join(fixturesDir, f), join(tmp, f));
    }
    const glob = join(tmp, "*.json");
    expect(spawnSync("npx", ["tsx", cli, "--write", glob], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("npx", ["tsx", cli, "--check", glob], { encoding: "utf8" }).status).toBe(0);
  });
});
