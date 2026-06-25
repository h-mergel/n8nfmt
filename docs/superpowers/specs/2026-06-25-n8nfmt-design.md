# n8nfmt — Design-Spec

**Datum:** 2026-06-25
**Status:** Genehmigt (Brainstorming abgeschlossen) · Rev. 2 (SOTA-Schärfung nach Code-Review)
**Zielort:** `\\wsl.localhost\Ubuntu\home\heinrich\dev\projects\n8nfmt` (neues, eigenständiges GitHub-Repo)

---

## 1. Kontext & Ziel

Im Projekt `h2k` (`autobot/n8n/`) existiert ein ausgereifter **Auto-Layouter für n8n-Workflows**
(~1.800 Zeilen TypeScript). Er liest n8n-Workflow-JSON, berechnet alle Knotenpositionen neu
(section-aware Grid-Layout: ELK.js für die Grobanordnung, dann eigene Regeln für Sticky-Note-
Sektionen, AI-Sub-Nodes, globale Error-Handler, Bypass-Lanes, Orphans, cross-indentierte Sektionen)
und schreibt die Positionen zurück.

Die Logik soll aus `h2k` herausgelöst und als **eigenständiges, auf GitHub veröffentlichtes Projekt**
nutzbar gemacht werden — projektübergreifend, nach dem mentalen Modell eines **Formatters/Linters**
(prettier / ktlint / gofmt): **KI- und CI-unabhängig**.

Die Core-Engine ist heute bereits reines JSON-rein/JSON-raus — **keine** Kopplung an die n8n-API,
**keine** Kopplung an h2k. Die Extraktion ist dadurch technisch unkritisch; die eigentliche
Designfrage ist die Distribution.

## 2. Leitprinzip: neutraler Core + dünne Adapter

Statt „entweder MCP oder Library oder Executable" wird ein **neutraler Core** gebaut, auf dem
**dünne Adapter** aufsetzen. Der Core weiß nichts von KI, CI, Dateisystem oder Prozess-Lifecycle.

```
                 ┌───────────────────────────┐
   CLI  ───────► │                           │
   (MCP, später) │   core   relayout()       │  ← reine Funktionen, still, seiteneffektfrei
   (CI nutzt CLI)│                           │
                 └───────────────────────────┘
```

- **Library** = der Core selbst (`relayout()`). Das Fundament.
- **Executable (CLI)** = primärer Adapter, die ktlint-/prettier-Rolle. In der JS-Welt ist das
  idiomatische „Executable" ein npm-`bin` (Aufruf via `npx n8nfmt`).
- **MCP** = nur ein weiterer dünner Adapter für KI-Agenten — **additiv, später, nicht Teil des Cores**.

## 3. Design-Prinzipien (SOTA)

Diese Prinzipien begründen die Entscheidungen in §7–§10:

1. **Formatter-Reinheit:** Das Tool fasst nur an, was es *besitzt* — die **Geometrie**. Es injiziert
   keine eigenen Bookkeeping-Metadaten in fremde Dateien (wie prettier/gofmt keine Metadaten schreiben).
2. **Kanonische, deterministische Ausgabe:** Gleiche Eingabe → byte-gleiche Ausgabe. Das erzeugt
   **stabile, minimale Git-Diffs** und macht `--check` überhaupt erst sinnvoll.
3. **Idempotenz:** `relayout(relayout(x)) == relayout(x)`. Harte Invariante (Voraussetzung für `--check`).
4. **Explizite, foot-gun-freie CLI:** Schreiben und Prüfen passieren nur auf ausdrückliche Anweisung;
   kein implizites Mutieren oder mehrdeutiges Verhalten.
5. **Minimale, stabile öffentliche Oberfläche:** so wenig wie möglich semver-geschützt exportieren
   (siehe `score()` intern, §7).

## 4. Scope

### In Scope (v1)
- **Core-Library** mit öffentlicher `relayout()`-API (rein, async, seiteneffektfrei, idempotent).
- **Kanonischer Serialisierer** (deterministische JSON-Ausgabe, §8).
- **CLI** `n8nfmt` (npm-`bin`, prettier-/gofmt-Modell) mit `--write` / `--check` / stdin→stdout.
- **Config-Datei** `.n8nfmtrc.json` für Layout-Parameter.
- **Interner Scorer + Dev-Optimizer** (nicht Teil der öffentlichen API).
- **Tests** (vitest: Golden-Snapshots + Idempotenz + Property-based).
- **Publishing** als ein npm-Paket `n8nfmt` + GitHub-Repo + CI.
- **Migration von h2k** zum Consumer.

### Out of Scope (v1, später additiv)
- **MCP-Server-Adapter** (eigenes Paket, zieht `n8nfmt` als Dependency).
- **Standalone-Binaries** (plattformübergreifende Einzeldateien ohne Node, via bun/pkg/Node-SEA).
- Anbindung an eine **laufende n8n-Instanz** (API/DB). Das Tool arbeitet ausschließlich auf
  exportiertem Workflow-JSON (Dateien / stdin) — das neutrale Linter-Modell.
- **Key-Sorting** der Workflow-JSON (semantisch konservativ; ggf. später als Opt-in `--sort-keys`).

## 5. Repo-Struktur

Ein einzelnes publizierbares npm-Paket; interne Code-Trennung über Ordner (keine Workspaces nötig).

```
n8nfmt/
├─ src/
│  ├─ core/                      die neutrale Library
│  │  ├─ relayout/               engine, graph, analysis, placement, grid, elk, nodes
│  │  ├─ score/                  scorer (intern — kein öffentlicher Export)
│  │  ├─ serialize.ts            kanonische JSON-Serialisierung (§8)
│  │  ├─ config.ts               LayoutConfig, DEFAULT_CONFIG, buildLayoutConfig
│  │  ├─ types.ts                vereinheitlichte n8n-Typen
│  │  └─ index.ts                ÖFFENTLICHE API: relayout, serialize, config, types
│  └─ cli/
│     └─ index.ts                Arg-Parsing, Datei/stdin-I/O, Logging, Exit-Codes
├─ tools/
│  └─ optimize/                  Dev-only Parameter-Optimizer (wird NICHT publiziert)
├─ test/
│  ├─ fixtures/                  Eingabe-Workflows (aus h2k gezogen)
│  └─ snapshots/                 Golden-Output-Files
├─ .github/workflows/            CI: Test/Typecheck (PR) · Release (Changesets → publish)
├─ .changeset/                   Changesets-Konfiguration
├─ .n8nfmtrc.json                Beispiel-/Default-Config
├─ biome.json                    Lint+Format (eigener Code)
├─ package.json                  type:module, exports (Lib) + bin (CLI), files:["dist"]
├─ tsconfig.json
├─ README.md                     inkl. „not affiliated with n8n"-Hinweis
└─ LICENSE                       MIT
```

`h2k` wird **Consumer**: der lokale relayout-/scorer-/optimize-Code dort entfällt; `h2k` ruft
künftig `npx n8nfmt --write workflows/` auf. Die Engine-Fixtures/Snapshots wandern ins Tool-Repo;
`h2k` behält seine echten Workflows als Daten.

## 6. Der Extraktions-Refactor: Core wird pur

Der Core ist heute nicht seiteneffektfrei. Für eine einbettbare Library gilt:

- **Core = pur & still:** kein `fs`, kein `process.exit`, kein `console.log`.
  - `engine.ts` heute: enthält `console.log`-Aufrufe → ersetzt durch strukturierte Rückgabe.
  - `relayoutWorkflow(...)` wird zu `relayout(workflow, options)` und gibt `{ workflow, report }` zurück;
    alle Diagnosen (Loop-Kanten, Warnungen, globale Handler) landen im `report`.
- **Kein `_meta` in die Datei:** Heute schreibt der Core `wf._meta = { globalHandlers }` in den Workflow
  (h2k-Quelle `src/relayout/engine.ts:75`) — das wird **entfernt**. Diese Information geht in
  `report.globalHandlers`, **nicht** in die Ausgabedatei (Prinzip §3.1).
- **Nur Geometrie wird geschrieben:** `node.position` (alle Knoten) sowie `node.parameters.width/height`
  ausschließlich für Sticky-Notes, die der Layouter dimensioniert (h2k-Quelle
  `src/relayout/placement.ts:411-413`). Sonst werden keine Felder hinzugefügt oder entfernt.
- **Keine Input-Mutation:** Der Core klont den Input intern (`structuredClone`) und gibt ein **neues**
  Workflow-Objekt zurück. Der übergebene Workflow bleibt unangetastet.
- **CLI = alle I/O:** liest Dateien/stdin, schreibt, loggt, setzt Exit-Codes.
- **Typ-Deduplizierung:** `scorer.ts` hält heute eine eigene Kopie der n8n-Typen
  („independent — not imported from relayout.ts"). Diese werden in `core/types.ts` zusammengeführt.

## 7. Öffentliche API — Core

```ts
// Hauptfunktion — pur, mutiert den Input NICHT, async (ELK.js layoutet asynchron), idempotent.
export async function relayout(
  workflow: N8nWorkflow,
  options?: RelayoutOptions,
): Promise<RelayoutResult>;

export interface RelayoutOptions {
  config?:  Partial<LayoutConfig>;   // rowStep, minGap, sectionGap, …
  rankSep?: number;                  // ELK-Parameter
  nodeSep?: number;
}

export interface RelayoutResult {
  workflow: N8nWorkflow;             // neues Objekt mit neuer Geometrie
  report:   RelayoutReport;
}

export interface RelayoutReport {
  totalNodes:     number;
  nodesChanged:   number;
  cyclicEdges:    Edge[];            // übersprungene Loop-Kanten
  globalHandlers: string[];         // Analyse-Artefakt — NUR hier, nie in der Datei (§3.1)
  warnings:       string[];         // cross-indent, bypass-lane, orphans …
  // KEIN score — hält das stabile Ergebnisformat frei von der instabilen Bewertung
}

// Kanonische Serialisierung (§8) — auch öffentlich, weil Adapter (CLI, später MCP) sie brauchen.
export function serialize(workflow: N8nWorkflow): string;

// Config & Typen
export const DEFAULT_CONFIG: LayoutConfig;
export function buildLayoutConfig(overrides?: Partial<LayoutConfig>): LayoutConfig;
export type { N8nWorkflow, N8nNode, LayoutConfig, Edge /* … */ };
```

Kernpunkte: **kein Seiteneffekt**, **strukturierter `report`** statt `console.log`, **`async`**, **idempotent**.

### `score()` ist NICHT öffentlich
- Begründung: Formatter-Identität (prettier exportiert keinen Score); `--check` braucht ihn nicht
  (§10); als public API wären die Scoring-Metriken ein semver-geschützter Vertrag — ausgerechnet das,
  was beim Verbessern der Engine frei verändert werden soll; YAGNI (einziger Consumer ist der
  In-Repo-Optimizer).
- `score()` lebt in `src/core/score/` und wird von `tools/optimize/` per **Deep-Import** konsumiert
  (relativer Pfad, nicht über den öffentlichen Entry). Bei späterem Bedarf (MCP) additiv zu public promotbar.

## 8. Output-Kontrakt — kanonische Serialisierung

`serialize(workflow)` erzeugt die **eine kanonische Textform** eines Workflows. Das Tool *besitzt*
diese Form (wie prettier den Quelltext besitzt):

- **Geschrieben werden ausschließlich Geometrie-Felder:** `node.position` (alle) und
  `node.parameters.width/height` (nur vom Layouter dimensionierte Sticky-Notes). Kein `_meta`, keine
  sonstigen Felder werden hinzugefügt oder entfernt.
- **Serialisierung:** UTF-8, **LF**, **2-Space-Einrückung**, **abschließender Newline**.
- **Schlüsselreihenfolge bleibt erhalten** — *kein* Key-Sorting (semantisch konservativ, wie prettier).
- **Idempotent & deterministisch:** `serialize` desselben Workflows liefert immer dieselben Bytes.

**Konsequenz (bewusst, dokumentiert):** Der erste Lauf normalisiert ggf. abweichenden Whitespace einer
fremden Datei — exakt wie `prettier --write`. `--check` (§9) vergleicht **byte-genau** gegen diese Form.

## 9. CLI-Kontrakt — `n8nfmt`

prettier-/gofmt-Modell: nicht-destruktiv, explizit, foot-gun-frei.

```
n8nfmt [optionen] [globs...]

OHNE Pfade:  JSON von stdin → kanonisches JSON auf stdout      (Filter, wie gofmt/jq; Pipe/Agent)
MIT  Pfaden: genau EINE Aktion erforderlich (kein impliziter Default):
  -w, --write    Dateien kanonisch neu schreiben (relayout + Format)   (die mutierende Aktion)
  -c, --check    nichts schreiben; Exit 1, wenn eine Datei nicht bereits
                 kanonisch ist (byte-genau)                            (CI / Pre-Commit)

  --config <f>   Layout-Parameter aus Datei laden  (Default: .n8nfmtrc.json)
  --params <j>   Inline-Parameter-Overrides (JSON)
  --verbose      Detail (Loop-Kanten, Bypass-Lanes, geänderte Dateien …)
-h, --help · --version
```

- **Pfad-Argumente ohne `-w`/`-c`** → Fehler (Exit 2) mit Hinweis „nutze --write oder --check".
  Kein mehrdeutiges Mehrdatei-stdout-Dump.
- **Exit-Codes:** `0` ok · `1` `--check` schlägt fehl (mind. eine Datei nicht kanonisch) ·
  `2` Fehler (kaputtes JSON, Datei fehlt, fehlende Aktion). Fehler pro Datei werden gesammelt,
  der Lauf bricht nicht ab (Summe `ok`/`changed`/`fail` am Ende).
- **`--check`-Semantik:** byte-genauer Vergleich `dateiinhalt == serialize(relayout(dateiinhalt))`.
- **Globbing:** eingebaut (kleine Dependency, z.B. `tinyglobby`) — Verlass auf Shell-Expansion scheidet
  aus, weil PowerShell (Zielumgebung Windows) Globs nicht selbst expandiert.
- **Parameter-Präzedenz:** `--params` > `--config`-Datei > `.n8nfmtrc.json` > `DEFAULT_CONFIG`.

## 10. Bewusste Design-Entscheidungen

1. **`--check` = byte-genauer Diff gegen die kanonische Form**, **nicht** ein Score-Schwellwert.
   Der prettier-Kontrakt: reproduzierbar, kein magischer Grenzwert. Setzt Idempotenz (§3.3) voraus.
2. **Output-Reinheit:** nur Geometrie, kein `_meta` (§3.1, §8).
3. **Config-Datei `.n8nfmtrc.json`** für Layout-Parameter — linter-idiomatisch (vgl. `.prettierrc`),
   CI-tauglich. `--params` für Inline-Overrides.
4. **Foot-gun-frei:** stdin→stdout als einziger impliziter Modus; Datei-Operationen nur mit `-w`/`-c`.
5. **Ein npm-Paket statt zwei** (prettier-Modell): `n8nfmt` liefert Library *und* `bin`. Kein
   npm-Scope/Org, eine Version, keine Workspaces. Spätere Adapter (MCP) = eigenes Paket mit `n8nfmt`-Dep.
6. **`score()` intern** (§7).

## 11. Packaging & Publishing

- **TypeScript → `dist/`**, **ESM-only** (`"type": "module"`), `.d.ts` mitgeliefert.
- **`engines.node`: `>=22`.** Node 18 und 20 sind Stand 2026-06 EOL; 22 ist aktueller Maintenance-LTS.
  CI-Matrix gegen **22 + 24**. (`structuredClone` etc. ohnehin verfügbar.)
- `package.json`: `"sideEffects": false`; `"exports"` mit `types`-/`import`-Conditions
  (Lib-Entry `src/core/index.ts` → `dist/core/index.js`); `bin.n8nfmt` → `dist/cli/index.js`;
  `files: ["dist"]` (Optimizer & Tests werden nicht ausgeliefert).
- **Build:** `tsc` (ESM, `.js` + `.d.ts`) — simpel und ausreichend.
- **Dev-Tooling:** **Biome** (Lint + Format in einem) für den eigenen Quellcode; Conventional Commits.
- **Release:** **Changesets** (Versionierung + Changelog) → GitHub Actions publiziert mit
  `npm publish --provenance` (OIDC). PR/Push → `install`, `typecheck`, `lint`, `test`.
- **Version:** Start `0.1.0` (pre-1.0 signalisiert: API darf sich noch bewegen).
- **Lizenz:** MIT.
- **README:** Nutzung (prettier-Style-Beispiele) + „not affiliated with n8n"-Hinweis (Marke).

## 12. Tests

- **Runner:** vitest (ESM/TS-nativ, Snapshots eingebaut) — ersetzt das heutige tsx/bash-Snapshot-Setup.
- **Golden-Snapshots:** bestehende Fixtures + Snapshot-JSONs wandern mit und werden Golden-Files:
  jede Fixture relayouten, gegen Soll-Positionen vergleichen.
- **Idempotenz-Test:** Golden erneut durch `relayout` → **keine** Änderung (sichert §3.3 / `--check`).
- **Property-based (fast-check):** generierte Workflows → Invarianten: Determinismus, Idempotenz,
  „nur Geometrie verändert" (keine anderen Felder/Strukturen mutiert), kein `_meta` im Output.
- **Non-Mutation-Test:** `relayout()` lässt das Eingabe-Objekt unverändert.
- **CLI-Selbsttest:** `n8nfmt --check` über die committeten Fixtures → Exit `0`.
- **Abgrenzung Migration:** Es wandern **nur** `test/snapshots/` + `fixtures/` + `scorer.test.ts`.
  Der h2k-Ordner `tests/` (jest: `n8n-runner`, `parse-events`, `state-logging`, `build-notification`)
  testet die **n8n-Instanz**, nicht den Layouter, und **bleibt in h2k**.

## 13. Migration von h2k (Reihenfolge)

1. `n8nfmt` extrahieren, bauen, Tests grün.
2. Während der Entwicklung konsumiert `h2k` es lokal via `npm link` / `file:`-Pfad.
3. Nach dem ersten Publish: in `h2k` `n8nfmt` als devDependency; `n8n/package.json`-Scripts →
   `"relayout": "npx n8nfmt --write workflows/"`, `"relayout:dry": "npx n8nfmt --check workflows/"`.
   **Alten relayout-/scorer-/optimize-Code + Fixtures in `h2k` löschen.**
4. `h2k` behält seine echten `workflows/*.json`, den `tests/`-Ordner und das separate
   `flowlint`-Setup (alles unverändert).

## 14. Spätere Erweiterungen (nicht v1)

- **MCP-Server** als eigenes Paket (`n8nfmt-mcp` o.ä.), das `relayout` aus `n8nfmt` importiert und
  als Tool für KI-Agenten exponiert.
- **Standalone-Binaries** als GitHub-Release-Assets (bun/pkg/Node-SEA), für Nutzer/CI-Runner ohne Node.
- **`score()` zu public promoten**, falls ein echter externer Consumer eine Qualitätsbewertung braucht.
- **`--sort-keys`** als Opt-in, falls vollständig stabile Cross-Export-Diffs gewünscht sind.
