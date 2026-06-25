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

# Use a custom config file and verbose output
npx n8nfmt --write --config .n8nfmtrc.json --verbose "workflows/**/*.json"
```

Options:

| Flag | Description |
|---|---|
| `--write` | Rewrite files in place |
| `--check` | Fail (exit 1) if any file would change |
| `--config <file>` | Path to a JSON config file (same keys as `.n8nfmtrc.json`) |
| `--params <json>` | Inline parameter overrides, e.g. `'{"rowStep":160}'` |
| `--verbose` | Print per-file change counts to stderr |

Exit codes: `0` ok · `1` `--check` found changes · `2` error.

## Library

```ts
import { relayout, serialize } from "n8nfmt";

const { workflow, report } = await relayout(JSON.parse(input));
process.stdout.write(serialize(workflow));
console.log(`${report.nodesChanged}/${report.totalNodes} nodes moved`);
```

`relayout()` is pure (it clones its input), async, and idempotent. It writes only geometry (`position`, sticky `width/height`) — never metadata.

## Configuration

Optional `.n8nfmtrc.json` in the project root:

```json
{ "rowStep": 200, "minGap": 100, "sectionGap": 80, "rankSep": 80, "nodeSep": 100 }
```

Override inline with `--params '{"rowStep":160}'`. Precedence: `--params` > `--config` > `.n8nfmtrc.json` > defaults.

### Config keys

`rowStep`, `minGap`, and `sectionGap` are `LayoutConfig` keys that control the section grid geometry (row height, minimum gap between nodes, gap between sticky sections).

`rankSep` and `nodeSep` are ELK graph-spacing options (passed directly to the ELK layout engine as `elk.layered.spacing.nodeNodeBetweenLayers` and `elk.spacing.nodeNode`). They are distinct from the `LayoutConfig` keys and control how ELK spaces nodes during the initial rank-assignment pass.

## License

MIT
