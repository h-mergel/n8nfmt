// ---------------------------------------------------------------------------
// Node dimension helpers
// ---------------------------------------------------------------------------

import type { N8nNode } from "../types.js";

export const DEFAULT_WIDTH = 100;
export const DEFAULT_HEIGHT = 100;
export const STICKY_DEFAULT_WIDTH = 240;
export const STICKY_DEFAULT_HEIGHT = 160;

// ---------------------------------------------------------------------------
// Node type registries — extend here to support new node families
// without touching the predicate functions (OCP).
// ---------------------------------------------------------------------------

/** Node types that are sticky notes (excluded from layout, resized by engine). */
const STICKY_NODE_TYPES = new Set<string>(["n8n-nodes-base.stickyNote"]);

/** Node-type prefixes whose width is 240 px instead of DEFAULT_WIDTH. */
const WIDE_NODE_PREFIXES: string[] = ["@n8n/n8n-nodes-langchain."];

export function isSticky(node: N8nNode): boolean {
  return STICKY_NODE_TYPES.has(node.type);
}

export function nodeWidth(node: N8nNode): number {
  if (WIDE_NODE_PREFIXES.some((p) => node.type?.startsWith(p))) return 240;
  return DEFAULT_WIDTH;
}

export function nodeDimensions(node: N8nNode): { width: number; height: number } {
  if (isSticky(node)) {
    return {
      width: node.parameters?.width ?? STICKY_DEFAULT_WIDTH,
      height: node.parameters?.height ?? STICKY_DEFAULT_HEIGHT,
    };
  }
  return { width: nodeWidth(node), height: DEFAULT_HEIGHT };
}
