import type { N8nWorkflow } from "./types.js";

/**
 * The single canonical text form of a workflow (the contract `--check` compares
 * against): UTF-8, LF, 2-space indent, trailing newline, key order preserved.
 * `JSON.stringify` keeps string-key insertion order and always emits `\n`.
 */
export function serialize(workflow: N8nWorkflow): string {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}
