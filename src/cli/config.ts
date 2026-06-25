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

async function readJsonRequired(path: string): Promise<FileConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as FileConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`config file not found: ${path}`);
    throw new Error(`invalid config file ${path}: ${(e as Error).message}`);
  }
}

/** Precedence: --params > --config file > .n8nfmtrc.json > built-in defaults. */
export async function resolveOptions(args: {
  config?: string;
  params?: string;
}): Promise<RelayoutOptions> {
  const fromFile: FileConfig = args.config
    ? await readJsonRequired(args.config)
    : ((await readJsonIfExists(".n8nfmtrc.json")) ?? {});
  let fromParams: FileConfig = {};
  if (args.params) {
    try {
      fromParams = JSON.parse(args.params) as FileConfig;
    } catch (e) {
      throw new Error(`invalid --params JSON: ${(e as Error).message}`);
    }
  }
  const merged: FileConfig = { ...fromFile, ...fromParams };
  const { rankSep, nodeSep, ...config } = merged;
  return { config, rankSep, nodeSep };
}
