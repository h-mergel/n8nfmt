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
