# n8nfmt — Design-Spec

**Datum:** 2026-06-25
**Status:** Genehmigt (Brainstorming abgeschlossen)
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
   (MCP, später) │   @core  relayout()       │  ← reine Funktionen, still, seiteneffektfrei
   (CI nutzt CLI)│                           │
                 └───────────────────────────┘
```

- **Library** = der Core selbst (`relayout()`). Das Fundament.
- **Executable (CLI)** = primärer Adapter, die ktlint-/prettier-Rolle. In der JS-Welt ist das
  idiomatische „Executable" ein npm-`bin` (Aufruf via `npx n8nfmt`).
- **MCP** = nur ein weiterer dünner Adapter für KI-Agenten — **additiv, später, nicht Teil des Cores**.

## 3. Scope

### In Scope (v1)
- **Core-Library** mit öffentlicher `relayout()`-API (rein, async, seiteneffektfrei).
- **CLI** `n8nfmt` (npm-`bin`, prettier-Modell) mit `--write` / `--check` / stdin→stdout.
- **Config-Datei** `.n8nfmtrc.json` für Layout-Parameter.
- **Interner Scorer + Dev-Optimizer** (nicht Teil der öffentlichen API).
- **Tests** (vitest, Snapshot-Golden-Files aus den bestehenden Fixtures).
- **Publishing** als ein npm-Paket `n8nfmt` + GitHub-Repo + CI.
- **Migration von h2k** zum Consumer.

### Out of Scope (v1, später additiv)
- **MCP-Server-Adapter** (eigenes Paket, zieht `n8nfmt` als Dependency).
- **Standalone-Binaries** (plattformübergreifende Einzeldateien ohne Node, via bun/pkg/Node-SEA).
- Anbindung an eine **laufende n8n-Instanz** (API/DB). Das Tool arbeitet ausschließlich auf
  exportiertem Workflow-JSON (Dateien / stdin) — das ist das neutrale Linter-Modell.

## 4. Repo-Struktur

Ein einzelnes publizierbares npm-Paket; interne Code-Trennung über Ordner (keine Workspaces nötig).

```
n8nfmt/
├─ src/
│  ├─ core/                      die neutrale Library
│  │  ├─ relayout/               engine, graph, analysis, placement, grid, elk, nodes
│  │  ├─ score/                  scorer (intern — kein öffentlicher Export)
│  │  ├─ config.ts               LayoutConfig, DEFAULT_CONFIG, buildLayoutConfig
│  │  ├─ types.ts                vereinheitlichte n8n-Typen
│  │  └─ index.ts                ÖFFENTLICHE API: relayout, config, types
│  └─ cli/
│     └─ index.ts                Arg-Parsing, Datei/stdin-I/O, Logging, Exit-Codes
├─ tools/
│  └─ optimize/                  Dev-only Parameter-Optimizer (wird NICHT publiziert)
├─ test/
│  ├─ fixtures/                  Eingabe-Workflows (aus h2k gezogen)
│  └─ snapshots/                 Golden-Output-Files
├─ .github/workflows/            CI: Test/Typecheck (PR) · Publish (Tag v*)
├─ .n8nfmtrc.json                Beispiel-/Default-Config
├─ package.json                  exports (Lib) + bin (CLI), files: ["dist"]
├─ tsconfig.json
├─ README.md                     inkl. „not affiliated with n8n"-Hinweis
└─ LICENSE                       MIT
```

`h2k` wird **Consumer**: der lokale relayout-/scorer-/optimize-Code dort entfällt; `h2k` ruft
künftig `npx n8nfmt write workflows/` auf. Die Engine-Fixtures/Snapshots wandern ins Tool-Repo;
`h2k` behält seine echten Workflows als Daten.

## 5. Der Extraktions-Refactor: Core wird pur

Der Core ist heute nicht ganz seiteneffektfrei. Für eine einbettbare Library gilt:

- **Core = pur & still:** kein `fs`, kein `process.exit`, kein `console.log`.
  - `engine.ts` heute: enthält `console.log`-Aufrufe → ersetzt durch strukturierte Rückgabe.
  - `relayoutWorkflow(...)` wird zu `relayout(workflow, options)` und gibt ein
    `{ workflow, report }`-Objekt zurück; alle Diagnosen (Loop-Kanten, Warnungen) landen im `report`.
- **Keine Input-Mutation:** Der Core klont den Input intern (`structuredClone`) und gibt ein **neues**
  Workflow-Objekt zurück. Der übergebene Workflow bleibt unangetastet.
- **CLI = alle I/O:** liest Dateien/stdin, schreibt, loggt, setzt Exit-Codes.
- **Typ-Deduplizierung:** `scorer.ts` hält heute eine eigene Kopie der n8n-Typen
  („independent — not imported from relayout.ts"). Diese werden in `core/types.ts` zusammengeführt.

## 6. Öffentliche API — Core

```ts
// Hauptfunktion — pur, mutiert den Input NICHT, async (ELK.js layoutet asynchron).
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
  workflow: N8nWorkflow;             // neues Objekt mit neuen Positionen
  report:   RelayoutReport;
}

export interface RelayoutReport {
  totalNodes:   number;
  nodesChanged: number;
  cyclicEdges:  Edge[];              // übersprungene Loop-Kanten
  warnings:     string[];           // cross-indent, bypass-lane, orphans …
  // KEIN score — hält das stabile Ergebnisformat frei von der instabilen Bewertung
}

// Config & Typen
export const DEFAULT_CONFIG: LayoutConfig;
export function buildLayoutConfig(overrides?: Partial<LayoutConfig>): LayoutConfig;
export type { N8nWorkflow, N8nNode, LayoutConfig, Edge /* … */ };
```

Kernpunkte: **kein Seiteneffekt**, **strukturierter `report`** statt `console.log`, **`async`**.

### `score()` ist NICHT öffentlich
- Begründung: Formatter-Identität (prettier exportiert keinen Score); `--check` braucht ihn nicht
  (siehe §8); als public API wären die Scoring-Metriken ein semver-geschützter Vertrag —
  ausgerechnet das, was beim Verbessern der Engine frei verändert werden soll; YAGNI (einziger
  Consumer ist heute der In-Repo-Optimizer).
- `score()` lebt in `src/core/score/` und wird von `tools/optimize/` per **Deep-Import** konsumiert
  (nicht über den öffentlichen Entry). Bei späterem Bedarf (MCP) wird es additiv zu public promotet.

## 7. CLI-Kontrakt — `n8nfmt`

prettier-/gofmt-Modell: nicht-destruktiver Default, explizites Schreiben.

```
n8nfmt [optionen] [dateien/globs...]

Standard (mit Dateien):   relayoutetes JSON → stdout (nicht-destruktiv)
Standard (ohne Dateien):  JSON von stdin → relayoutetes JSON auf stdout   (Pipe / Agent)

-w, --write      Dateien an Ort und Stelle neu schreiben          (die mutierende Aktion)
-c, --check      nichts schreiben; Exit 1, wenn eine Datei nicht
                 bereits sauber gelayoutet ist                     (CI / Pre-Commit)
    --config <f> Layout-Parameter aus Datei laden  (Default: .n8nfmtrc.json)
    --params <j> Inline-Parameter-Overrides (JSON)
    --verbose    Detail (Loop-Kanten, Bypass-Lanes …)
-h, --help · --version
```

**Exit-Codes:** `0` ok · `1` `--check` schlägt fehl (etwas würde sich ändern) ·
`2` Fehler (kaputtes JSON, Datei fehlt). Fehler pro Datei werden gesammelt, der Lauf bricht nicht ab
(Summe `ok`/`fail` am Ende, wie das heutige Tool).

**Parameter-Präzedenz:** `--params` (inline) > `--config`-Datei > `.n8nfmtrc.json` > `DEFAULT_CONFIG`.

## 8. Bewusste Design-Entscheidungen

1. **`--check` = deterministischer Diff** („würde `relayout` etwas ändern?"), **nicht** ein
   Score-Schwellwert. Exakt der prettier-Kontrakt: reproduzierbar, kein magischer Grenzwert.
   Der Scorer bleibt davon getrennt und rein informativ/intern.
2. **Config-Datei `.n8nfmtrc.json`** (Projekt-Wurzel) für die Layout-Parameter — linter-idiomatisch
   (vgl. `.prettierrc`), CI-tauglich. `--params` bleibt für Inline-Overrides.
3. **Eingebautes Globbing** (kleine Dependency, z.B. `tinyglobby`) statt Verlass auf Shell-Expansion
   — wichtig, weil PowerShell (Zielumgebung Windows) Globs nicht selbst expandiert.
4. **Ein npm-Paket statt zwei** (prettier-Modell): `n8nfmt` liefert Library *und* `bin`. Kein
   npm-Scope/Org, eine Version, keine Workspaces. Spätere Adapter (MCP) = eigenes Paket mit
   `n8nfmt` als Dependency.
5. **`score()` intern** (siehe §6).

## 9. Packaging & Publishing

- **TypeScript → `dist/`**, **ESM-only**, Node ≥ 18, `.d.ts` mitgeliefert.
- `package.json`: `exports` → Library-Entry (`src/core/index.ts` → `dist/core/index.js`),
  `bin.n8nfmt` → `dist/cli/index.js`, `files: ["dist"]` (Optimizer & Tests werden nicht ausgeliefert).
- **GitHub Actions:**
  - PR/Push → `install`, `typecheck`, `test`.
  - Git-Tag `v*` → `build`, `test`, `npm publish --provenance`.
- **Version:** Start `0.1.0` (pre-1.0 signalisiert: API darf sich noch bewegen).
- **Lizenz:** MIT.
- **README:** Nutzung (prettier-Style-Beispiele) + „not affiliated with n8n"-Hinweis (Marke).

## 10. Tests

- **Runner:** vitest (ESM/TS-nativ, Snapshots eingebaut) — ersetzt das heutige tsx/bash-Snapshot-Setup.
- **Snapshot-Tests:** bestehende Fixtures + Snapshot-JSONs wandern mit und werden Golden-Files:
  jede Fixture relayouten, gegen Soll-Positionen vergleichen (ELK ist deterministisch).
- **Selbsttest:** `n8nfmt --check` über die committeten Fixtures muss Exit `0` liefern
  (sie sind bereits sauber gelayoutet) — verifiziert zugleich den `--check`-Diff-Kontrakt.
- **Core-Reinheit:** ein Test stellt sicher, dass `relayout()` den Input nicht mutiert.

## 11. Migration von h2k (Reihenfolge)

1. `n8nfmt` extrahieren, bauen, Tests grün.
2. Während der Entwicklung konsumiert `h2k` es lokal via `npm link` / `file:`-Pfad.
3. Nach dem ersten Publish: in `h2k` `n8nfmt` als devDependency; `n8n/package.json`-Scripts →
   `"relayout": "npx n8nfmt write workflows/"`, `"relayout:dry": "npx n8nfmt workflows/"`.
   **Alten relayout-/scorer-/optimize-Code + Fixtures in `h2k` löschen.**
4. `h2k` behält seine echten `workflows/*.json` und das separate `flowlint`-Setup (unverändert).

## 12. Spätere Erweiterungen (nicht v1)

- **MCP-Server** als eigenes Paket (`n8nfmt-mcp` o.ä.), das `relayout` aus `n8nfmt` importiert und
  als Tool für KI-Agenten exponiert.
- **Standalone-Binaries** als GitHub-Release-Assets (bun/pkg/Node-SEA), für Nutzer/CI-Runner ohne Node.
- **`score()` zu public promoten**, falls ein echter externer Consumer eine Qualitätsbewertung braucht.
