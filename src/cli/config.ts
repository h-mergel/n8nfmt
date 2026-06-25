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
