import fc from "fast-check";
import type { N8nWorkflow } from "../../src/core/types.js";

const nodeName = fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[A-Za-z0-9]+$/.test(s));

/** Generates small, structurally-valid workflows: unique node names, main-channel
 *  edges only between existing nodes. */
export const arbWorkflow: fc.Arbitrary<N8nWorkflow> = fc
  .uniqueArray(nodeName, { minLength: 1, maxLength: 8 })
  .chain((names) => {
    const nodes = names.map((name, i) => ({
      name,
      type: "n8n-nodes-base.set",
      position: [i * 10, i * 10] as [number, number],
    }));

    // With only one node, no edges are possible — return immediately.
    if (names.length < 2) {
      return fc.constant({ nodes, connections: {} } as N8nWorkflow);
    }

    return fc
      .array(
        fc.tuple(fc.constantFrom(...names), fc.constantFrom(...names)).filter(([a, b]) => a !== b),
        { maxLength: 12 },
      )
      .map((pairs) => {
        const connections: N8nWorkflow["connections"] = {};
        for (const [from, to] of pairs) {
          const conn = { node: to, type: "main", index: 0 };
          const entry = connections[from];
          if (entry) entry.main?.[0]?.push(conn);
          else connections[from] = { main: [[conn]] };
        }
        return { nodes, connections } as N8nWorkflow;
      });
  });
