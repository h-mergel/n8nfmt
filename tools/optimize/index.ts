#!/usr/bin/env tsx

// ---------------------------------------------------------------------------
// Parameter optimizer — DEV TOOL ONLY, not published (files: ["dist"] excludes tools/).
// Sweeps layout parameters over fixture files to find the best config.
// console.* / process.* are allowed here (it is a CLI, not core).
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { relayout } from "../../src/core/index.js";
import type { N8nWorkflow } from "../../src/core/index.js";
import { score } from "../../src/core/score/index.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const injectIdx = args.indexOf("--inject-bad-candidate");
const INJECT_BAD_CANDIDATE = injectIdx !== -1 ? path.resolve(args[injectIdx + 1] ?? "") : null;

const fixtures = args.filter((a, i) => {
  if (a.startsWith("--")) return false;
  if (i > 0 && args[i - 1] === "--inject-bad-candidate") return false;
  return true;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveFixtures(): string[] {
  if (fixtures.length > 0) return fixtures.map((f) => path.resolve(f));
  // Default: test/fixtures relative to repo root (tools/optimize → ../../test/fixtures)
  const dir = path.join(__dirname, "..", "..", "test", "fixtures");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
}

const fixtureFiles = resolveFixtures();
if (fixtureFiles.length === 0) {
  process.stderr.write("No fixture files found.\n");
  process.exit(1);
}

process.stderr.write(`Fixtures: ${fixtureFiles.join(", ")}\n`);

// ---------------------------------------------------------------------------
// Parameter space
// ---------------------------------------------------------------------------
interface Params {
  nodesep: number;
  ranksep: number;
  ROW_STEP: number;
  MIN_GAP: number;
  SECTION_GAP: number;
}

const DEFAULT_PARAMS: Params = {
  nodesep: 100,
  ranksep: 80,
  ROW_STEP: 192,
  MIN_GAP: 80,
  SECTION_GAP: 64,
};

const STEPS: Params = {
  nodesep: 10,
  ranksep: 20,
  ROW_STEP: 20,
  MIN_GAP: 20,
  SECTION_GAP: 10,
};

const RANGES: Record<keyof Params, [number, number]> = {
  nodesep: [60, 120],
  ranksep: [80, 200],
  ROW_STEP: [120, 320],
  MIN_GAP: [80, 200],
  SECTION_GAP: [30, 100],
};

const MAX_ITER = 20;

// ---------------------------------------------------------------------------
// Param-name mapping:
//   ROW_STEP    → config.rowStep
//   MIN_GAP     → config.minGap
//   SECTION_GAP → config.sectionGap
//   ranksep     → rankSep
//   nodesep     → nodeSep
// ---------------------------------------------------------------------------

// Score a set of params across all fixture files — returns { raw, clamped, hardRejected }
async function scoreParams(
  params: Params,
  files: string[],
): Promise<{ raw: number; clamped: number; hardRejected: boolean }> {
  let totalRaw = 0;
  let totalClamped = 0;
  let counted = 0;
  let hardRejected = false;

  for (const fixture of files) {
    // Each fixture file is scored against its companion ".original.json" (for hard constraints),
    // or just against itself (no original → hardConstraintsPassed will be null/true).
    const originalPath = fixture.replace(/\.json$/, ".original.json");
    const originalWf: N8nWorkflow | undefined = fs.existsSync(originalPath)
      ? (JSON.parse(fs.readFileSync(originalPath, "utf8")) as N8nWorkflow)
      : undefined;

    const wf = JSON.parse(fs.readFileSync(fixture, "utf8")) as N8nWorkflow;

    try {
      const { workflow: candidateWf } = await relayout(wf, {
        config: {
          rowStep: params.ROW_STEP,
          minGap: params.MIN_GAP,
          sectionGap: params.SECTION_GAP,
        },
        rankSep: params.ranksep,
        nodeSep: params.nodesep,
      });

      const result = score(candidateWf, originalWf);

      if (result.hardConstraintsPassed === false) {
        hardRejected = true;
        process.stderr.write(`  [hard-reject] ${path.basename(fixture)}\n`);
        break;
      }

      totalRaw += result.rawScore;
      totalClamped += result.score;
      counted++;
    } catch (e) {
      process.stderr.write(
        `  [warn] scoring failed for ${path.basename(fixture)}: ${(e as Error).message.split("\n")[0]}\n`,
      );
    }
  }

  if (counted === 0) return { raw: 0, clamped: 0, hardRejected };
  return { raw: totalRaw / counted, clamped: totalClamped / counted, hardRejected };
}

function clamp(v: number, range: [number, number]): number {
  return Math.max(range[0], Math.min(range[1], v));
}

// ---------------------------------------------------------------------------
// Hill-climbing optimizer
// ---------------------------------------------------------------------------
process.stderr.write("Computing baseline score...\n");
const baseline = await scoreParams(DEFAULT_PARAMS, fixtureFiles);
const baselineScore = baseline.clamped;
process.stderr.write(
  `Baseline score: ${baselineScore.toFixed(1)} (rawScore=${baseline.raw.toFixed(1)})\n`,
);

let bestParams = { ...DEFAULT_PARAMS };
let bestScore = baselineScore;
let bestRaw = baseline.raw;
let noImprovementCount = 0;
let rejectedByHardConstraints = 0;
const history: Array<{ iter: number; score: number; params: Params }> = [];

for (let iter = 1; iter <= MAX_ITER; iter++) {
  process.stderr.write(
    `\nIteration ${iter}/${MAX_ITER} (best so far: ${bestScore.toFixed(1)}, raw=${bestRaw.toFixed(1)})\n`,
  );
  let improved = false;

  for (const key of Object.keys(STEPS) as Array<keyof Params>) {
    for (const delta of [STEPS[key], -STEPS[key]]) {
      const candidate = clamp(bestParams[key] + delta, RANGES[key]);
      if (candidate === bestParams[key]) continue;
      const newParams = { ...bestParams, [key]: candidate };
      process.stderr.write(`  trying ${key}=${candidate}...`);
      const s = await scoreParams(newParams, fixtureFiles);
      if (s.hardRejected) {
        rejectedByHardConstraints++;
        process.stderr.write(" [HARD_REJECTED]\n");
        continue;
      }
      process.stderr.write(` clamped=${s.clamped.toFixed(1)} raw=${s.raw.toFixed(1)}\n`);
      if (s.raw > bestRaw) {
        bestRaw = s.raw;
        bestScore = s.clamped;
        bestParams = newParams;
        improved = true;
        process.stderr.write(`  ✓ improved! ${key}=${candidate} raw=${s.raw.toFixed(1)}\n`);
      }
    }
  }

  history.push({ iter, score: bestScore, params: { ...bestParams } });

  if (!improved) {
    noImprovementCount++;
    process.stderr.write(`  No improvement (${noImprovementCount}/2)\n`);
  } else {
    noImprovementCount = 0;
  }

  if (noImprovementCount >= 2) {
    process.stderr.write("Stopping: 2 consecutive no-improvement iterations.\n");
    break;
  }
  if (bestScore >= 90) {
    process.stderr.write("Stopping: score >= 90.\n");
    break;
  }
}

// ---------------------------------------------------------------------------
// Plateau analysis — relayout first fixture with best params, extract violationGroups
// ---------------------------------------------------------------------------
let plateauAnalysis: unknown = null;
try {
  const firstFixture = fixtureFiles[0];
  if (firstFixture !== undefined) {
    const wf = JSON.parse(fs.readFileSync(firstFixture, "utf8")) as N8nWorkflow;
    const { workflow: laidOut } = await relayout(wf, {
      config: {
        rowStep: bestParams.ROW_STEP,
        minGap: bestParams.MIN_GAP,
        sectionGap: bestParams.SECTION_GAP,
      },
      rankSep: bestParams.ranksep,
      nodeSep: bestParams.nodesep,
    });
    const scored = score(laidOut);
    plateauAnalysis = {
      fixture: path.basename(firstFixture),
      bestParams,
      violationGroups: scored.violationGroups ?? [],
    };
  }
} catch (e) {
  process.stderr.write(`[warn] plateauAnalysis failed: ${(e as Error).message.split("\n")[0]}\n`);
}

// ---------------------------------------------------------------------------
// --inject-bad-candidate smoke test
// ---------------------------------------------------------------------------
if (INJECT_BAD_CANDIDATE) {
  process.stderr.write(`\n[inject-bad-candidate] Evaluating: ${INJECT_BAD_CANDIDATE}\n`);
  const badWf = JSON.parse(fs.readFileSync(INJECT_BAD_CANDIDATE, "utf8")) as N8nWorkflow;
  for (const fixture of fixtureFiles) {
    try {
      const originalWf = JSON.parse(fs.readFileSync(fixture, "utf8")) as N8nWorkflow;
      const result = score(badWf, originalWf);
      if (result.hardConstraintsPassed === false) {
        rejectedByHardConstraints++;
        process.stderr.write(
          `  [inject-bad-candidate] REJECTED by hard constraints (total rejected: ${rejectedByHardConstraints})\n`,
        );
      } else {
        process.stderr.write(
          "  [inject-bad-candidate] WARNING: candidate passed hard constraints — not a valid bad candidate\n",
        );
      }
    } catch (e) {
      process.stderr.write(
        `  [inject-bad-candidate] error: ${(e as Error).message.split("\n")[0]}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const result = {
  baselineScore: Math.round(baselineScore * 10) / 10,
  bestScore: Math.round(bestScore * 10) / 10,
  bestParams,
  iterations: history.length,
  rejectedByHardConstraints,
  history,
  plateauAnalysis,
};

const outPath = path.join(__dirname, ".optimize-result.json");
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stderr.write(`\nResult written to ${outPath}\n`);

console.log(JSON.stringify(result, null, 2));
