#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
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

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  const options = await resolveOptions({ config: values.config, params: values.params });

  // Filter mode: no paths → stdin to stdout.
  if (positionals.length === 0) {
    const input = await readStdin();
    if (!input.trim()) {
      process.stderr.write("n8nfmt: no input on stdin\n");
      return 2;
    }
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
