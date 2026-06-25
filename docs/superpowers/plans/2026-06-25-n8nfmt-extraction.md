# n8nfmt Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the n8n workflow auto-layouter from `h2k/autobot/n8n/` into a standalone, GitHub-published npm package `n8nfmt` — a neutral core library plus a thin prettier/gofmt-style CLI.

**Architecture:** A pure, side-effect-free core (`relayout()` + canonical `serialize()`) with zero knowledge of fs/CLI/AI. A single npm package ships both the library (`import { relayout } from 'n8nfmt'`) and the `bin` (`npx n8nfmt`). The scorer is internal (consumed only by the dev optimizer). MCP and standalone binaries are deferred.

**Tech Stack:** TypeScript (ESM-only), ELK.js (layout), tinyglobby (globbing), Node `util.parseArgs` (CLI args, zero-dep), vitest + fast-check (tests), Biome (lint+format), Changesets (release), GitHub Actions (CI/publish).

**Source of truth:** Design spec at `docs/superpowers/specs/2026-06-25-n8nfmt-design.md` (Rev. 2). Original source to extract lives in `\\wsl.localhost\ubuntu\home\heinrich\dev\projects\h2k\autobot\n8n\` (referred to below as **`$H2K`**). The n8nfmt repo already exists at `\\wsl.localhost\Ubuntu\home\heinrich\dev\projects\n8nfmt` (git initialised, `main`, spec committed).

## Global Constraints

Every task's requirements implicitly include these (copied verbatim from the spec):

- **Package:** single npm package named `n8nfmt`, version starts at `0.1.0`, license **MIT**.
- **Module format:** **ESM-only** (`"type": "module"`); ship `.d.ts`. `"sideEffects": false`.
- **Runtime:** `engines.node` = **`>=22`** (Node 18 and 20 are EOL as of 2026-06). CI matrix: 22 + 24.
- **Output purity:** the tool writes **only geometry** — `node.position` (all nodes) and `node.parameters.width/height` (only layouter-sized sticky notes). It **never** writes `_meta`; analysis artifacts go to the `report`. No other fields are added or removed (pre-existing fields round-trip untouched).
- **Canonical serialization:** UTF-8, **LF**, **2-space** indent, **trailing newline**, **key order preserved** (no key sorting). Deterministic and idempotent.
- **Idempotency (hard invariant):** `relayout(relayout(x)) == relayout(x)`.
- **`score()` is internal** — never exported from the public entry; consumed by `tools/optimize/` via relative deep import.
- **Core is pure & silent:** no `fs`, no `process.*`, no `console.*` anywhere under `src/core/`.

---

## File Structure

```
n8nfmt/
├─ src/
│  ├─ core/
│  │  ├─ relayout/        engine.ts, graph.ts, analysis.ts, placement.ts, grid.ts, elk.ts, nodes.ts
│  │  ├─ score/           index.ts (internal scorer)
│  │  ├─ serialize.ts     canonical JSON serialization
│  │  ├─ config.ts        LayoutConfig, DEFAULT_CONFIG, buildLayoutConfig
│  │  ├─ types.ts         unified n8n types + RelayoutOptions/Result/Report
│  │  └─ index.ts         PUBLIC API: relayout, serialize, config, types
│  └─ cli/
│     └─ index.ts         arg parsing, fs/stdin I/O, exit codes
├─ tools/optimize/        index.ts (dev-only, not published)
├─ test/
│  ├─ fixtures/           input workflows (from h2k)
│  ├─ snapshots/          golden output files (from h2k)
│  ├─ core/               vitest specs for the library
│  └─ cli/                vitest specs for the CLI
├─ .github/workflows/     ci.yml, release.yml
├─ .changeset/            config.json
├─ .n8nfmtrc.json         example/default config
├─ biome.json · vitest.config.ts · tsconfig.json · tsconfig.build.json
├─ package.json · .gitignore · .nvmrc · LICENSE · README.md
```

---

## Task 1: Repo scaffolding & toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc`, `.n8nfmtrc.json`, `src/core/index.ts` (stub)

**Interfaces:**
- Produces: the buildable/testable shell every later task relies on. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all resolve.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "n8nfmt",
  "version": "0.1.0",
  "description": "Opinionated auto-layout formatter for n8n workflow JSON. Not affiliated with n8n.",
  "type": "module",
  "license": "MIT",
  "author": "Heinrich Mergel",
  "keywords": ["n8n", "workflow", "layout", "formatter", "elk"],
  "engines": { "node": ">=22" },
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/core/index.d.ts",
      "import": "./dist/core/index.js"
    }
  },
  "bin": { "n8nfmt": "./dist/cli/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "optimize": "tsx tools/optimize/index.ts"
  },
  "dependencies": {
    "elkjs": "^0.11.1",
    "tinyglobby": "^0.2.10"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@changesets/cli": "^2.27.10",
    "@types/node": "^22.0.0",
    "fast-check": "^3.23.1",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (typecheck + editor; includes everything)

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tools", "test", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `tsconfig.build.json`** (emits only the published surface)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "noEmit": false },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "files": { "ignore": ["dist", "test/fixtures", "test/snapshots"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noConsoleLog": "off" }
    }
  }
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 6: Create `.gitignore`, `.nvmrc`, `.n8nfmtrc.json`**

`.gitignore`:
```
node_modules
dist
*.tsbuildinfo
.DS_Store
```

`.nvmrc`:
```
22
```

`.n8nfmtrc.json` (example/default — every key optional, equals built-in defaults):
```json
{
  "rowStep": 200,
  "minGap": 100,
  "sectionGap": 80,
  "rankSep": 80,
  "nodeSep": 100
}
```

- [ ] **Step 7: Create `src/core/index.ts` stub** (replaced in Task 5)

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 8: Install and verify the toolchain**

Run:
```bash
cd "//wsl.localhost/ubuntu/home/heinrich/dev/projects/n8nfmt"
npm install
npm run typecheck
npm run lint
npm run build
```
Expected: install succeeds; `typecheck` exits 0; `lint` exits 0; `build` produces `dist/core/index.js`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold n8nfmt package (toolchain, configs)"
```

---

## Task 2: Move & purify the leaf layout modules

Move the pure layout modules out of `$H2K/src/relayout/` into `src/core/`, unify the n8n types, and strip all `console.*` / `verbose`-only debug code (Global Constraint: core is silent).

**Files:**
- Create: `src/core/types.ts`, `src/core/config.ts`, `src/core/relayout/nodes.ts`, `src/core/relayout/graph.ts`, `src/core/relayout/analysis.ts`, `src/core/relayout/grid.ts`, `src/core/relayout/elk.ts`, `src/core/relayout/placement.ts`
- Source: the same-named files under `$H2K/src/relayout/`

**Interfaces:**
- Produces (consumed by Task 4 engine): `buildWorkflowGraph(wf): WorkflowGraph`, `analyzeWorkflow(wf, graph, stickyGroups): WorkflowAnalysis`, `computeStickyGroups(nodes)`, `runElkLayout(...)`, `placeSections/placeOrphans/placeGlobalHandlers/placeAiSubNodes(...)`, `applyPlacementPlan(wf, plan): number`, type `PlacementPlan`. All keep their current signatures **except** the trailing `verbose: boolean` parameter is removed.
- Produces (consumed everywhere): unified `src/core/types.ts` exporting `N8nNode`, `N8nWorkflow`, `N8nConnections`, `N8nConnection`, `N8nBranch`, `N8nChannels`, `Edge`, `BranchedEdge`, `LayoutPos`, `GridEntry`, `Section`.

- [ ] **Step 1: Copy `types.ts` and `config.ts` verbatim, then extend types**

Copy `$H2K/src/relayout/types.ts` → `src/core/types.ts` and `$H2K/src/relayout/config.ts` → `src/core/config.ts` unchanged. Append the public result types to `src/core/types.ts` (consumed by Tasks 4–5):

```ts
// ---------------------------------------------------------------------------
// Public relayout API types
// ---------------------------------------------------------------------------

export interface RelayoutOptions {
  config?: Partial<import("./config.js").LayoutConfig>;
  rankSep?: number;
  nodeSep?: number;
}

export interface RelayoutReport {
  totalNodes: number;
  nodesChanged: number;
  cyclicEdges: Edge[];
  globalHandlers: string[];
  warnings: string[];
}

export interface RelayoutResult {
  workflow: N8nWorkflow;
  report: RelayoutReport;
}
```

- [ ] **Step 2: Copy `nodes.ts`, `graph.ts`, `analysis.ts`, `elk.ts` verbatim**

Copy each from `$H2K/src/relayout/` to `src/core/relayout/`. These already use `./x.js` ESM imports — no change needed. (`nodes.ts`, `graph.ts`, `analysis.ts`, `elk.ts` contain no `console.*`.)

- [ ] **Step 3: Copy `grid.ts` and `placement.ts`, then strip debug logging**

Copy both into `src/core/relayout/`. Then, in each file:
- Delete every `console.log(...)` and every `if (verbose) console.log(...)` statement (grid.ts has them around lines 114, 128, 235, 250, 284; placement.ts around 183, 208, 231, 277, 339, 378).
- Remove the now-unused trailing `verbose: boolean` parameter from each exported function signature that only used it for logging (`placeSections`, `placeOrphans`, `placeGlobalHandlers`, `placeAiSubNodes`, and any grid helper that took `verbose`).
- Remove any local `if (verbose)` blocks left empty.

- [ ] **Step 4: Verify purity and types compile**

Run:
```bash
cd "//wsl.localhost/ubuntu/home/heinrich/dev/projects/n8nfmt"
grep -rn "console\.\|process\.\|require(\|from 'fs'\|from \"fs\"" src/core && echo "IMPURITY FOUND" || echo "clean"
npx tsc -p tsconfig.json --noEmit
```
Expected: prints `clean` (no matches); `tsc` reports errors only about the not-yet-created `engine.ts`/`serialize.ts`/`score` (acceptable — fixed in later tasks) OR exits 0 if no file references them yet. If `tsc` complains about an unused `verbose` import or param, remove it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): port pure layout modules, strip debug logging"
```

---

## Task 3: Canonical serializer

**Files:**
- Create: `src/core/serialize.ts`
- Test: `test/core/serialize.test.ts`

**Interfaces:**
- Produces (consumed by Task 5 index + CLI): `serialize(workflow: N8nWorkflow): string` — the one canonical text form.

- [ ] **Step 1: Write the failing test**

`test/core/serialize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { serialize } from "../../src/core/serialize.js";
import type { N8nWorkflow } from "../../src/core/types.js";

const wf: N8nWorkflow = {
  nodes: [{ name: "A", type: "n8n-nodes-base.set", position: [0, 0] }],
  connections: {},
};

describe("serialize", () => {
  it("uses 2-space indent, LF, and a trailing newline", () => {
    const out = serialize(wf);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).not.toContain("\r");
    expect(out).toContain('\n  "nodes"');
  });

  it("preserves key insertion order (no sorting)", () => {
    const out = serialize({ connections: {}, nodes: [] } as unknown as N8nWorkflow);
    expect(out.indexOf('"connections"')).toBeLessThan(out.indexOf('"nodes"'));
  });

  it("is idempotent on its own output bytes", () => {
    expect(serialize(JSON.parse(serialize(wf)))).toBe(serialize(wf));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/serialize.test.ts`
Expected: FAIL — cannot resolve `../../src/core/serialize.js`.

- [ ] **Step 3: Implement `src/core/serialize.ts`**

```ts
import type { N8nWorkflow } from "./types.js";

/**
 * The single canonical text form of a workflow (the contract `--check` compares
 * against): UTF-8, LF, 2-space indent, trailing newline, key order preserved.
 * `JSON.stringify` keeps string-key insertion order and always emits `\n`.
 */
export function serialize(workflow: N8nWorkflow): string {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/serialize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add canonical serialize()"
```

---

## Task 4: Pure `relayout()` engine

Refactor the orchestrator into a pure, async function returning `{ workflow, report }` — no `console.*`, no `process.*`, no input mutation, no `_meta` written.

**Files:**
- Create: `src/core/relayout/engine.ts` (rewrite of `$H2K/src/relayout/engine.ts`)
- Test: `test/core/relayout.test.ts`

**Interfaces:**
- Consumes (from Task 2): `computeStickyGroups`, `buildWorkflowGraph`, `runElkLayout`, `analyzeWorkflow`, `placeSections`, `placeOrphans`, `placeGlobalHandlers`, `placeAiSubNodes`, `applyPlacementPlan`, `PlacementPlan`, `buildLayoutConfig`.
- Produces (consumed by Task 5 + CLI): `relayout(workflow: N8nWorkflow, options?: RelayoutOptions): Promise<RelayoutResult>`.

- [ ] **Step 1: Write the failing test**

`test/core/relayout.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/relayout.test.ts`
Expected: FAIL — cannot resolve `engine.js`.

- [ ] **Step 3: Implement `src/core/relayout/engine.ts`**

```ts
import ELK from "elkjs/lib/elk.bundled.js";
import { buildLayoutConfig } from "../config.js";
import type {
  N8nWorkflow,
  RelayoutOptions,
  RelayoutResult,
  RelayoutReport,
} from "../types.js";
import { buildWorkflowGraph } from "./graph.js";
import { runElkLayout } from "./elk.js";
import { computeStickyGroups, analyzeWorkflow } from "./analysis.js";
import {
  placeSections,
  placeOrphans,
  placeGlobalHandlers,
  placeAiSubNodes,
  applyPlacementPlan,
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

  const elk = new ELK();
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
```

> Note: if Task 2 left `placeSections`/`placeOrphans`/`placeGlobalHandlers`/`placeAiSubNodes` with a different post-`verbose`-removal arity, match the call sites here to the actual signatures (drop the removed trailing arg).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/relayout.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): pure async relayout() returning {workflow, report}"
```

---

## Task 5: Public core entry point

**Files:**
- Modify: `src/core/index.ts` (replace the Task 1 stub)
- Test: `test/core/public-api.test.ts`

**Interfaces:**
- Produces (consumed by CLI + external users): the public surface — `relayout`, `serialize`, `DEFAULT_CONFIG`, `buildLayoutConfig`, and the public types. **No `score` export.**

- [ ] **Step 1: Write the failing test**

`test/core/public-api.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as api from "../../src/core/index.js";

describe("public API", () => {
  it("exports relayout, serialize, and config helpers", () => {
    expect(typeof api.relayout).toBe("function");
    expect(typeof api.serialize).toBe("function");
    expect(typeof api.buildLayoutConfig).toBe("function");
    expect(api.DEFAULT_CONFIG).toBeDefined();
  });

  it("does NOT export score (internal only)", () => {
    expect("score" in api).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/public-api.test.ts`
Expected: FAIL — `api.relayout` is not a function (stub still in place).

- [ ] **Step 3: Implement `src/core/index.ts`**

```ts
export { relayout } from "./relayout/engine.js";
export { serialize } from "./serialize.js";
export { DEFAULT_CONFIG, buildLayoutConfig } from "./config.js";
export type { LayoutConfig } from "./config.js";
export type {
  N8nWorkflow,
  N8nNode,
  N8nConnections,
  RelayoutOptions,
  RelayoutResult,
  RelayoutReport,
  Edge,
} from "./types.js";
```

- [ ] **Step 4: Run test + full typecheck**

Run:
```bash
npx vitest run test/core/public-api.test.ts
npm run typecheck
```
Expected: tests PASS; `typecheck` exits 0 (whole `src/core` now compiles).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): public API entry (relayout, serialize, config, types)"
```

---

## Task 6: Migrate fixtures + golden snapshot test

**Files:**
- Copy: `$H2K/workflows/*.json` → `test/fixtures/*.json`; `$H2K/test/snapshots/*.json` → `test/snapshots/*.json`
- Test: `test/core/snapshots.test.ts`

**Interfaces:**
- Consumes: `relayout` (Task 4). Replaces the old `test/verify-snapshots.sh` (sorted name+position diff) with an in-process vitest equivalent.

- [ ] **Step 1: Copy the test data**

Copy all `$H2K/workflows/*.json` into `test/fixtures/` and all `$H2K/test/snapshots/*.json` into `test/snapshots/` (six workflows each: `dc-to-userstory`, `ai-mr-note-reviewer`, `family-appointments`, `ai-planning`, `gitlab-to-miro-mindmap`, `ai-implementation-intake`).

- [ ] **Step 2: Write the snapshot test**

`test/core/snapshots.test.ts`:
```ts
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
  it.each(files)("relayout(%s) matches its golden positions", async (file) => {
    const input = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as N8nWorkflow;
    const golden = JSON.parse(readFileSync(join(snapshotsDir, file), "utf8")) as N8nWorkflow;
    const { workflow } = await relayout(input);
    expect(positions(workflow)).toEqual(positions(golden));
  });
});
```

- [ ] **Step 3: Run the snapshot test**

Run: `npx vitest run test/core/snapshots.test.ts`
Expected: PASS for all six fixtures. If any fixture diverges, the ported engine differs from the original — diff the offending file's positions and reconcile against `$H2K` before continuing (do not edit the golden to mask a regression).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(core): migrate fixtures + golden snapshot suite"
```

---

## Task 7: Idempotency, determinism & non-mutation tests

**Files:**
- Test: `test/core/invariants.test.ts`

**Interfaces:**
- Consumes: `relayout`, `serialize`. Locks the Global Constraints (idempotency, determinism, only-geometry).

- [ ] **Step 1: Write the failing test**

`test/core/invariants.test.ts`:
```ts
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
    expect("_meta" in workflow).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run test/core/invariants.test.ts`
Expected: PASS. If an idempotency case fails, the engine is not stable on its own output — this is a real bug that must be fixed in `src/core/relayout/` (not worked around), because `--check` depends on it.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(core): idempotency, determinism, geometry-only invariants"
```

---

## Task 8: Property-based tests (fast-check)

**Files:**
- Create: `test/core/arbitraries.ts` (workflow generator)
- Test: `test/core/property.test.ts`

**Interfaces:**
- Consumes: `relayout`, `serialize`, `fast-check`. Asserts the invariants over generated workflows, not just fixtures.

- [ ] **Step 1: Create the workflow arbitrary**

`test/core/arbitraries.ts`:
```ts
import fc from "fast-check";
import type { N8nWorkflow } from "../../src/core/types.js";

const nodeName = fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[A-Za-z0-9]+$/.test(s));

/** Generates small, structurally-valid workflows: unique node names, main-channel
 *  edges only between existing nodes. */
export const arbWorkflow: fc.Arbitrary<N8nWorkflow> = fc
  .uniqueArray(nodeName, { minLength: 1, maxLength: 8 })
  .chain((names) =>
    fc
      .array(
        fc.tuple(fc.constantFrom(...names), fc.constantFrom(...names)).filter(([a, b]) => a !== b),
        { maxLength: 12 },
      )
      .map((pairs) => {
        const nodes = names.map((name, i) => ({
          name,
          type: "n8n-nodes-base.set",
          position: [i * 10, i * 10] as [number, number],
        }));
        const connections: N8nWorkflow["connections"] = {};
        for (const [from, to] of pairs) {
          const conn = { node: to, type: "main", index: 0 };
          const entry = connections[from];
          if (entry) entry.main?.[0]?.push(conn);
          else connections[from] = { main: [[conn]] };
        }
        return { nodes, connections } as N8nWorkflow;
      }),
  );
```

- [ ] **Step 2: Write the property test**

`test/core/property.test.ts`:
```ts
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
  });

  it("never adds _meta and preserves the node set", async () => {
    await fc.assert(
      fc.asyncProperty(arbWorkflow, async (wf) => {
        const { workflow } = await relayout(wf);
        const names = (w: typeof wf) => w.nodes.map((n) => n.name).sort().join(",");
        return !("_meta" in workflow) && names(workflow) === names(wf);
      }),
      { numRuns: 50 },
    );
  });
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run test/core/property.test.ts`
Expected: PASS. A counterexample here is a genuine engine bug — fix the engine, do not loosen the property. (If the generator itself produces structurally invalid input that throws, tighten `arbWorkflow`, not the invariant.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(core): property-based idempotency & purity (fast-check)"
```

---

## Task 9: Internal scorer + in-process scorer tests

Move the scorer into the core as an **internal** module exposing a pure `score()`, replacing the stale subprocess-based `scorer.test.ts`.

**Files:**
- Create: `src/core/score/index.ts` (from `$H2K/scorer.ts`)
- Test: `test/core/score.test.ts` (rewrite of `$H2K/scorer.test.ts`, in-process)

**Interfaces:**
- Produces (consumed by Task 10 optimizer + tests, via **relative import only** — never re-exported from `src/core/index.ts`):
```ts
export interface ScoreResult {
  score: number;
  rawScore: number;
  metrics: Record<string, number>;       // nodeOverlaps, nodeOutsideSection, edgeCrossings, …
  violationGroups: Array<{ rootCause: string; count: number }>;
  hardConstraintsPassed: boolean;
  hardViolations: Array<{ type: string; node: string; expectedSticky: string }>;
}
export function score(workflow: N8nWorkflow, original?: N8nWorkflow): ScoreResult;
```

- [ ] **Step 1: Port `scorer.ts` into a pure module**

Copy `$H2K/scorer.ts` → `src/core/score/index.ts`. Then:
- Delete the CLI wrapper: the `process.argv` parsing, `loadWorkflow`/`fs` reads, all `console.*`, and the `process.exit` calls (top ~57 lines and the trailing output block).
- Replace the local duplicated type declarations (`N8nNode`, `N8nWorkflow`, `N8nConnections`) and helpers (`isSticky`, `nodeDims`) with imports from `../types.js` and `../relayout/nodes.js` (use `nodeDimensions` for `{width,height}`; adapt the local `{w,h}` call sites).
- Wrap the existing scoring computation in an exported `score(workflow, original?)` that returns `ScoreResult` (the shape above — already produced by the current code, just returned instead of printed).
- Keep all metric/hard-constraint logic byte-for-byte otherwise.

- [ ] **Step 2: Write the in-process test**

`test/core/score.test.ts` (ported assertions, now calling `score()`/`relayout()` directly — no `execSync`, no temp files):
```ts
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
```

- [ ] **Step 3: Run + verify purity**

Run:
```bash
npx vitest run test/core/score.test.ts
grep -rn "console\.\|process\.\|execSync" src/core/score && echo "IMPURITY" || echo "clean"
```
Expected: tests PASS; prints `clean`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): internal score() + in-process scorer tests"
```

---

## Task 10: Move the parameter optimizer to `tools/`

**Files:**
- Create: `tools/optimize/index.ts` (from `$H2K/optimize.ts`)
- Copy: `$H2K/fixtures/*.json` → `test/fixtures/` (already done in Task 6 for the workflow set; copy any optimizer-only fixtures such as `family-appointments.original.json` too)

**Interfaces:**
- Consumes: `relayout` (via `src/core/index.js`) and `score` (via relative `../../src/core/score/index.js`). Dev-only; **excluded from `files`** so it never ships.

- [ ] **Step 1: Port `optimize.ts`**

Copy `$H2K/optimize.ts` → `tools/optimize/index.ts`. Update it to run in-process instead of shelling out:
- Replace any `execSync(... relayout ...)` with `import { relayout } from "../../src/core/index.js"` and `await relayout(wf, { config, rankSep, nodeSep })`.
- Replace any `execSync(... scorer ...)` with `import { score } from "../../src/core/score/index.js"`.
- Point the fixtures directory at `test/fixtures` (compute via `import.meta.url`). Keep the parameter-search loop, `--inject-bad-candidate`, and the result reporting; `console.*`/`process.*` are allowed here (it is a CLI dev tool, not core).

- [ ] **Step 2: Smoke-run the optimizer**

Run:
```bash
cd "//wsl.localhost/ubuntu/home/heinrich/dev/projects/n8nfmt"
npx tsx tools/optimize/index.ts test/fixtures/family-appointments.json
```
Expected: it runs the parameter sweep and prints a best-parameter summary without throwing. (No assertion — this is a dev tool; the gate is "runs end-to-end".)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(tools): port parameter optimizer (in-process, dev-only)"
```

---

## Task 11: CLI — filter mode (stdin → stdout) + config resolution

**Files:**
- Create: `src/cli/index.ts`, `src/cli/config.ts`
- Test: `test/cli/filter.test.ts`

**Interfaces:**
- Consumes: `relayout`, `serialize`, `buildLayoutConfig`, `LayoutConfig`.
- Produces (consumed by Task 12): `resolveOptions(opts): Promise<RelayoutOptions>`, and the runnable `dist/cli/index.js` `bin`.

- [ ] **Step 1: Write the failing test**

`test/cli/filter.test.ts`:
```ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cli/filter.test.ts`
Expected: FAIL — `src/cli/index.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/config.ts`**

```ts
import { readFile } from "node:fs/promises";
import type { LayoutConfig, RelayoutOptions } from "../core/index.js";

type FileConfig = Partial<LayoutConfig> & { rankSep?: number; nodeSep?: number };

async function readJsonIfExists(path: string): Promise<FileConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as FileConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`invalid config file ${path}: ${(e as Error).message}`);
  }
}

/** Precedence: --params > --config file > .n8nfmtrc.json > built-in defaults. */
export async function resolveOptions(args: {
  config?: string;
  params?: string;
}): Promise<RelayoutOptions> {
  const fromFile = (await readJsonIfExists(args.config ?? ".n8nfmtrc.json")) ?? {};
  const fromParams: FileConfig = args.params ? JSON.parse(args.params) : {};
  const merged: FileConfig = { ...fromFile, ...fromParams };
  const { rankSep, nodeSep, ...config } = merged;
  return { config, rankSep, nodeSep };
}
```

- [ ] **Step 4: Implement `src/cli/index.ts` (filter mode + skeleton)**

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { relayout, serialize } from "../core/index.js";
import type { N8nWorkflow } from "../core/index.js";
import { resolveOptions } from "./config.js";

const HELP = `n8nfmt — auto-layout formatter for n8n workflow JSON

Usage:
  n8nfmt [options] [globs...]

  Without paths:  read one workflow JSON from stdin, write canonical JSON to stdout.
  With paths:     exactly one action is required:
    -w, --write   rewrite the matched files in place
    -c, --check   exit 1 if any file is not already canonical (no writes)

Options:
      --config <f>  layout params file (default: .n8nfmtrc.json)
      --params <j>  inline JSON param overrides
      --verbose     extra detail on stderr
  -h, --help        show this help
      --version     print version
`;

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  return pkg.version as string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      write: { type: "boolean", short: "w" },
      check: { type: "boolean", short: "c" },
      config: { type: "string" },
      params: { type: "string" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });

  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values.version) { process.stdout.write(`${await readVersion()}\n`); return 0; }

  const options = await resolveOptions({ config: values.config, params: values.params });

  // Filter mode: no paths → stdin to stdout.
  if (positionals.length === 0) {
    const input = await readStdin();
    if (!input.trim()) { process.stderr.write("n8nfmt: no input on stdin\n"); return 2; }
    const wf = JSON.parse(input) as N8nWorkflow;
    const { workflow } = await relayout(wf, options);
    process.stdout.write(serialize(workflow));
    return 0;
  }

  // File modes are implemented in Task 12.
  return await runFileMode(values, positionals, options);
}

// Placeholder wired up in Task 12.
async function runFileMode(
  _values: Record<string, unknown>,
  _paths: string[],
  _options: Awaited<ReturnType<typeof resolveOptions>>,
): Promise<number> {
  process.stderr.write("n8nfmt: file mode not yet implemented\n");
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`n8nfmt: ${(err as Error).message}\n`);
    process.exit(2);
  });
```

> The `runFileMode` placeholder is replaced with the real implementation in Task 12 — it is internal, not a public deliverable, and Task 11's tests do not exercise file mode.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/cli/filter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): filter mode (stdin→stdout) + config resolution"
```

---

## Task 12: CLI — `--write`, `--check`, and required-action errors

**Files:**
- Modify: `src/cli/index.ts` (replace `runFileMode`)
- Test: `test/cli/files.test.ts`

**Interfaces:**
- Consumes: `relayout`, `serialize`, `tinyglobby`, `resolveOptions`.
- Behaviour: with paths, exactly one of `--write`/`--check` is required. `--check` byte-compares each file against `serialize(relayout(file))`; exit 1 if any differ. `--write` rewrites changed files. Missing action → exit 2. Per-file errors are collected; the run does not abort.

- [ ] **Step 1: Write the failing test**

`test/cli/files.test.ts`:
```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

  it("--write rewrites the file, after which --check passes (idempotent)", () => {
    const file = tmpWorkflow();
    expect(run(["--write", file]).status).toBe(0);
    const written = readFileSync(file, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(run(["--check", file]).status).toBe(0); // canonical now
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cli/files.test.ts`
Expected: FAIL — `runFileMode` returns 2 for all (including `--check`/`--write`).

- [ ] **Step 3: Implement `runFileMode` in `src/cli/index.ts`**

Add the import at the top:
```ts
import { writeFile } from "node:fs/promises";
import { glob } from "tinyglobby";
```
Replace the placeholder `runFileMode` with:
```ts
async function runFileMode(
  values: { write?: boolean; check?: boolean; verbose?: boolean },
  paths: string[],
  options: Awaited<ReturnType<typeof resolveOptions>>,
): Promise<number> {
  if (values.write === values.check) {
    // neither or both
    process.stderr.write("n8nfmt: with file paths, pass exactly one of --write or --check\n");
    return 2;
  }

  // Normalize `\` → `/`: tinyglobby treats backslashes as escapes, and on Windows
  // both argv paths and temp paths arrive with backslashes.
  const patterns = paths.map((p) => p.replace(/\\/g, "/"));
  const files = await glob(patterns, { absolute: true, onlyFiles: true });
  if (files.length === 0) {
    process.stderr.write("n8nfmt: no files matched\n");
    return 2;
  }

  let changed = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const original = await readFile(file, "utf8");
      const { workflow } = await relayout(JSON.parse(original) as N8nWorkflow, options);
      const canonical = serialize(workflow);
      if (canonical === original) continue;
      changed++;
      if (values.check) {
        if (values.verbose) process.stderr.write(`would reformat: ${file}\n`);
      } else {
        await writeFile(file, canonical, "utf8");
        if (values.verbose) process.stderr.write(`reformatted: ${file}\n`);
      }
    } catch (e) {
      failed++;
      process.stderr.write(`n8nfmt: ${file}: ${(e as Error).message}\n`);
    }
  }

  if (values.verbose) {
    process.stderr.write(`n8nfmt: ${files.length} file(s), ${changed} changed, ${failed} failed\n`);
  }
  if (failed > 0) return 2;
  if (values.check && changed > 0) return 1;
  return 0;
}
```
Update the call site's type annotation in `main` so `values` carries `write`/`check`/`verbose`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/cli/files.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: CLI self-test on committed fixtures (Global Constraint: fixtures are canonical)**

Add `test/cli/selfcheck.test.ts`:
```ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "src", "cli", "index.ts");

describe("CLI self-check", () => {
  it("--write then --check leaves fixtures canonical", () => {
    const glob = join(here, "..", "fixtures", "*.json");
    expect(spawnSync("npx", ["tsx", cli, "--write", glob], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("npx", ["tsx", cli, "--check", glob], { encoding: "utf8" }).status).toBe(0);
  });
});
```
Run: `npx vitest run test/cli/selfcheck.test.ts`
Expected: PASS. (Writes then verifies fixtures are canonical; positions already match goldens from Task 6, so `--write` only normalizes whitespace once.)

- [ ] **Step 6: Full suite + commit**

Run: `npm test`
Expected: all suites PASS.
```bash
git add -A
git commit -m "feat(cli): --write, --check, required-action errors + self-check"
```

---

## Task 13: Build, bin, and package verification

**Files:**
- Modify: none (uses `tsconfig.build.json` from Task 1)
- Verify: `dist/` layout, `bin` shebang, `npm pack` contents

**Interfaces:**
- Produces: a working `dist/cli/index.js` (executable) and `dist/core/index.js` (library) — the published artifacts.

- [ ] **Step 1: Build and inspect output**

Run:
```bash
cd "//wsl.localhost/ubuntu/home/heinrich/dev/projects/n8nfmt"
npm run build
ls dist/core/index.js dist/core/index.d.ts dist/cli/index.js
head -1 dist/cli/index.js
```
Expected: all three files exist; first line of the CLI is `#!/usr/bin/env node`.

- [ ] **Step 2: Run the built CLI end-to-end**

Run:
```bash
echo '{"nodes":[{"name":"A","type":"n8n-nodes-base.set","position":[9,9]}],"connections":{}}' | node dist/cli/index.js
node dist/cli/index.js --version
```
Expected: canonical JSON on stdout (trailing newline); version prints.

- [ ] **Step 3: Verify the published file set**

Run: `npm pack --dry-run`
Expected: the tarball lists only `dist/**`, `package.json`, `README.md`, `LICENSE` — **no** `src`, `test`, `tools`, or `docs`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build: verify dist artifacts and package contents"
```

---

## Task 14: CI, release automation, and Biome gate

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.changeset/config.json`

**Interfaces:**
- Produces: PRs run typecheck/lint/test on Node 22+24; merges to `main` with changesets cut a release and publish with provenance.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [22, 24] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}", cache: "npm" }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Create `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- [ ] **Step 3: Create `.github/workflows/release.yml`**

```yaml
name: Release
on:
  push: { branches: [main] }
permissions:
  contents: write
  pull-requests: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: "npm", registry-url: "https://registry.npmjs.org" }
      - run: npm ci
      - run: npm run build
      - uses: changesets/action@v1
        with:
          publish: npm publish --provenance --access public
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
```

- [ ] **Step 4: Add an initial changeset**

Create `.changeset/initial-release.md`:
```md
---
"n8nfmt": minor
---

Initial release: pure relayout() core, canonical serialize(), and the n8nfmt CLI (--write / --check / stdin filter).
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: add CI matrix, changesets release, npm provenance"
```

> Note for the human owner (not an automation step): set the `NPM_TOKEN` secret on the GitHub repo and create the empty `n8nfmt` package owner on npm before the first publish.

---

## Task 15: README and LICENSE

**Files:**
- Create: `README.md`, `LICENSE`

**Interfaces:**
- Produces: the public-facing docs (Global Constraint: MIT + "not affiliated with n8n").

- [ ] **Step 1: Create `LICENSE`**

Standard MIT license text, copyright holder `Heinrich Mergel`, year `2026`.

- [ ] **Step 2: Create `README.md`**

````md
# n8nfmt

Opinionated auto-layout **formatter for [n8n](https://n8n.io) workflow JSON** — like Prettier, but for the canvas geometry of your workflows. It recomputes node positions with a section-aware grid layout and rewrites the file in a canonical form.

> Not affiliated with, or endorsed by, n8n GmbH. "n8n" is a trademark of its respective owner.

## Install

```bash
npm install -D n8nfmt
```

## CLI

```bash
# Rewrite workflow files in place
npx n8nfmt --write "workflows/**/*.json"

# CI / pre-commit: fail if anything is not already canonical
npx n8nfmt --check "workflows/**/*.json"

# Filter mode (pipe one workflow through)
cat workflow.json | npx n8nfmt
```

Exit codes: `0` ok · `1` `--check` found changes · `2` error.

## Library

```ts
import { relayout, serialize } from "n8nfmt";

const { workflow, report } = await relayout(JSON.parse(input));
process.stdout.write(serialize(workflow));
console.log(`${report.nodesChanged}/${report.totalNodes} nodes moved`);
```

`relayout()` is pure (it clones its input), async, and idempotent. It writes only
geometry (`position`, sticky `width/height`) — never metadata.

## Configuration

Optional `.n8nfmtrc.json` in the project root:

```json
{ "rowStep": 200, "minGap": 100, "sectionGap": 80, "rankSep": 80, "nodeSep": 100 }
```

Override inline with `--params '{"rowStep":160}'`. Precedence: `--params` > `--config` > `.n8nfmtrc.json` > defaults.

## License

MIT
````

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README and MIT LICENSE"
```

---

## Task 16: Migrate h2k to consume n8nfmt

Done **after** the package builds and tests green (publish optional — `file:`/`npm link` works pre-publish).

**Files (in `$H2K`):**
- Modify: `autobot/n8n/package.json`
- Delete: `autobot/n8n/src/relayout/`, `autobot/n8n/relayout/`, `autobot/n8n/scorer.ts`, `autobot/n8n/scorer.test.ts`, `autobot/n8n/optimize.ts`, `autobot/n8n/test/snapshots/`, `autobot/n8n/test/verify-snapshots.sh`, `autobot/n8n/fixtures/`
- Keep untouched: `autobot/n8n/workflows/`, `autobot/n8n/tests/` (jest n8n-runtime suite), `autobot/n8n/.flowlint.yml`, `patch-flowlint.js`

**Interfaces:**
- Consumes: published (or linked) `n8nfmt` CLI.

- [ ] **Step 1: Point h2k at the new tool**

In `autobot/n8n/package.json`, add `n8nfmt` as a devDependency (during development: `"n8nfmt": "file:../../../n8nfmt"`; after publish: `"^0.1.0"`) and replace the layout scripts:
```json
"scripts": {
  "lint": "flowlint scan .",
  "relayout": "n8nfmt --write workflows/",
  "relayout:dry": "n8nfmt --check workflows/",
  "typecheck": "tsc --noEmit",
  "postinstall": "node patch-flowlint.js"
}
```
(Remove the `score`, `optimize`, `relayout:dry` tsx, and `test:scorer` scripts.)

- [ ] **Step 2: Install and verify behaviour parity**

Run:
```bash
cd "//wsl.localhost/ubuntu/home/heinrich/dev/projects/h2k/autobot/n8n"
npm install
npm run relayout:dry || echo "check reported changes (expected before first write)"
npm run relayout
npm run relayout:dry
```
Expected: after `relayout`, the `relayout:dry` (`--check`) run exits 0 — h2k's workflows are now canonical under the published engine.

- [ ] **Step 3: Delete the extracted code**

Remove the files/dirs listed under "Delete" above. Verify the kept items remain:
```bash
ls src/relayout 2>/dev/null && echo "STILL PRESENT (remove it)" || echo "removed"
ls tests/ workflows/ .flowlint.yml
```
Expected: `removed`; `tests/`, `workflows/`, `.flowlint.yml` still present.

- [ ] **Step 4: Commit (in the h2k repo)**

```bash
cd "//wsl.localhost/ubuntu/home/heinrich/dev/projects/h2k"
git add -A 2>/dev/null || true
git commit -m "chore(n8n): consume external n8nfmt; drop in-repo layouter" 2>/dev/null || echo "h2k is not a git repo — skip commit"
```
(If `$H2K` is not under git, just leave the working tree changed.)

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §2 neutral core + adapters → Tasks 2–5 (core), 11–12 (CLI).
- §3 design principles (purity, canonical, idempotency, foot-gun-free, minimal surface) → Tasks 2/4 (purity), 3 (canonical), 7–8 (idempotency), 12 (foot-gun-free), 5/9 (minimal surface, score internal).
- §4 scope → all tasks; out-of-scope (MCP, binaries, key-sorting) → not built.
- §5 repo structure → Task 1 + file placement throughout.
- §6 core-pure refactor (no fs/exit/console, no `_meta`, no input mutation, type dedup) → Tasks 2, 4, 9.
- §7 public API (`relayout`, `serialize`, config, types; `score` internal) → Task 5; `score` internal → Task 9.
- §8 output contract (geometry only, canonical, key order, idempotent) → Tasks 3, 4, 7.
- §9 CLI contract (stdin filter, `-w`/`-c`, exit codes, precedence, globbing) → Tasks 11–12.
- §10 decisions → encoded across the above.
- §11 packaging (ESM, Node ≥22, sideEffects, exports, Biome, Changesets, provenance, 0.1.0, MIT) → Tasks 1, 13, 14, 15.
- §12 tests (vitest, goldens, idempotency, property, non-mutation, self-check; h2k `tests/` stays) → Tasks 6–9, 12, 16.
- §13 migration → Task 16.
- §14 later extensions → intentionally not built.

**2. Placeholder scan** — the only `runFileMode` stub (Task 11) is explicitly replaced in Task 12; no "TBD"/"add error handling"/"write tests for the above" left. All test steps contain runnable code.

**3. Type consistency** — `relayout(workflow, options?) → Promise<RelayoutResult>`, `RelayoutReport` (totalNodes/nodesChanged/cyclicEdges/globalHandlers/warnings), `serialize(workflow) → string`, `score(workflow, original?) → ScoreResult`, `resolveOptions({config?,params?}) → RelayoutOptions`, `PlacementPlan`, and `applyPlacementPlan(wf, plan) → number` are used identically everywhere they appear. CLI `values` carry `write`/`check`/`config`/`params`/`verbose`. Config precedence string matches §9.

> One known risk flagged for execution: Task 2 removes a trailing `verbose` parameter from several placement/grid functions. Task 4's engine call sites assume that removal. If any of those functions used `verbose` for control flow (not just logging), keep the parameter and pass `false`; the Task 4 note covers reconciling arity. The Task 6 snapshot suite is the backstop that catches any behavioural drift from the port.
