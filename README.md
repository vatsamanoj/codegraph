# codegraph

A **session-scoped code graph** you drop into any repo to answer *"what defines / references / calls / breaks-if-I-change* this?"* — fast, live, and local.

Three layers, all localhost:

| Layer | What | Strength |
|---|---|---|
| **tree-sitter** (always on) | Node daemon, any language | Instant, live (re-indexes on save), `def` / `refs` / `callers` / `impact` |
| **Roslyn** (auto, if a `.sln` exists) | warm .NET server | **Type-exact** C# `refs` / `callers` / `impl` — resolves overloads, interfaces, inheritance |
| **ts-morph** (auto, if a `tsconfig.json` exists) | warm Node server | **Type-exact** TypeScript/TSX `refs` / `callers` / `impl` via the TS compiler |

One `--precise` flag fans out to whichever precise servers exist and merges the result — so a single query spans your backend (C#) and frontend (TS) at once. It boots when your editor/agent session starts, keeps the index current via file-watchers, and shuts down when the session ends.

> **Get more out of it over time:** [AUDIT-PROTOCOL.md](AUDIT-PROTOCOL.md) is a lightweight per-task ritual — query codegraph first, turn every real gap into a new capability, and end with an honest "what did this save me?" scorecard. Following it makes codegraph compound to *your* codebase and shows exactly where it earns its keep. Recommended for anyone using codegraph (especially with an AI coding agent).

## Requirements
- **Node.js 18+** (the core; no native build — tree-sitter runs as WASM; ts-morph is pure JS).
- **.NET SDK** *(optional)* — only to enable the precise C# layer when the repo has a `.sln`.

## Install (plug-and-play)
Clone it anywhere inside (or beside) your project, then:

```bash
node setup.mjs            # auto-detects the repo root + solution, installs deps, builds Roslyn
# or:
node setup.mjs --root /path/to/your/repo --hooks
```

`setup.mjs`:
1. detects the codebase root (nearest `.git` ancestor, or `--root`), and any `*.sln`,
2. `npm install`,
3. builds the Roslyn server (only if a `.sln` + .NET SDK are present),
4. writes `config.local.json` (per-machine, git-ignored),
5. with `--hooks`, installs auto start/stop into `<root>/.claude/settings.json` (Claude Code).

## Use
```bash
node daemon.mjs start                 # start (both layers); stop | status
node cg.mjs def <Name>                # where it's defined
node cg.mjs refs <Name>               # references (fast, syntactic)
node cg.mjs refs <Name> --precise     # references (type-exact: C# via Roslyn + TS via ts-morph, merged)
node cg.mjs callers <Name> --precise  # exact callers
node cg.mjs impl <Type>               # implementations / derived / overrides (C# + TS)
node cg.mjs impact <Name>             # refs + cross-language seam scan + change checklist (add --precise)
node cg.mjs text <string> [--regex]   # grep source; EACH hit tagged with its enclosing symbol
```

### `text` — the entry-point bridge (string concept → pivotable symbol)
`def`/`refs`/`callers` are keyed by **identifier name**, so they can't find a *concept named as a string*: a UI label (`"Narration"`), a CSS class (`tp-vch-date-input`), an i18n key, an error code, JSX text. Those are where real bug-hunting *starts* ("after save, focus stays in Narration"). Plain grep finds the line but not *which function you're in*, so you then have to read around each hit. `cg text` does both at once — it greps the indexed source and tags every hit with its **enclosing definition** (the innermost def whose span contains the line):

```
$ cg text tp-vch-date-input
  src/components/vouchers/useVoucherModes.ts
    277: const dateEl = document.querySelector('.tp-vch-date-input') …   → in useVoucherModes {function_declaration}
```

So the workflow is: **`cg text "<the string from the report>"` → read off the enclosing symbol → `cg callers`/`refs`/`impact` that symbol.** Literal substring by default (case-insensitive); `--regex` opts into a JS regexp.

`impact` also greps config/schema/serialization files (`.json`, `.sql`, `.proto`, `.yaml`, …) for the name, because the graph can't link string/JSON/DDL seams — the boundaries where a rename compiles on both sides but breaks at runtime.

## Lifecycle
- **With Claude Code:** `--hooks` wires `SessionStart → start`, `SessionEnd → stop`.
- **Anywhere else:** call `node daemon.mjs start` / `stop` yourself (from your shell rc, a git hook, a task runner…). It's idempotent, and self-shuts-down after idle (default 180 min).

## Languages
tree-sitter grammars ship for: C#, TypeScript/TSX/JS, Python, Go, Rust, Java, Kotlin, Ruby, PHP, Swift, Scala, C/C++ (extend the map in `graph.mjs`). Definitions are detected generically (`*_declaration` / `*_definition` / `*_item` with a name), so new languages mostly work out of the box. **Precise** (type-resolved) references cover **C#** (Roslyn) and **TypeScript/TSX** (ts-morph); other languages get fast syntactic references.

## Config (`config.local.json`, written by setup)
```json
{
  "roots": ["C:/path/to/repo"],
  "dotnetSolution": "C:/path/to/repo/App.sln",
  "tsConfig": "C:/path/to/repo/tsconfig.json",
  "schemaJson": "C:/path/to/repo/schema.json",
  "schemaPatchFiles": ["src/Persistence/Patches"],
  "ports": { "treeSitter": 47615, "roslyn": 47616, "ts": 47617 },
  "impactChecklist": "…optional project-specific checklist…"
}
```
`roots` may list multiple directories (e.g. a separate frontend and backend). Forward slashes work on all platforms.

## How it works
- **tree-sitter** parses each file to a syntax tree and records definitions, identifier references, and call sites into in-memory maps. Syntactic: fast and language-agnostic, but a name shared across types can over-report.
- **Roslyn** loads the `.sln` into the C# compiler's semantic model and answers `SymbolFinder.FindReferences/FindCallers/FindImplementations` — type-resolved, no false positives. Live-updates changed `.cs`; add/remove sets `dirty` → `cg reindex`.
- **ts-morph** loads the `tsconfig.json` project into the TypeScript language service and answers `findReferences` / `getImplementations` — type-resolved. Live-refreshes changed `.ts`/`.tsx`.

## Schema layer (relational impact) — optional
If a `schema.json` is present, `cg` gains a **relational** view so an entity/table change shows its DB ripple, not just code refs:

```bash
node cg.mjs schema <Table|Entity>   # PK, columns (PK/FK marked), FKs out, referenced-by (in), indexes
```
…and `cg impact <Name>` appends a **Schema ripple** block when the name is a table/entity — the tables that FK *into* it, cascade behavior, and a reminder that a column add/alter needs both the model change and a schema migration for existing DBs.

`schema.json` is **project-supplied** — generate it however fits your stack (EF Core model reflection, a DB `information_schema`/`PRAGMA` dump, or by hand). codegraph just consumes it. Point `config.local.json`'s `schemaJson` at the file, or drop it as `schema.json` next to the tool. Format:

```json
{ "tables": [ {
  "table": "Ledgers", "entity": "Ledger", "context": "TenantDbContext",
  "primaryKey": ["Id"],
  "columns": [ { "name": "Id", "type": "Guid", "nullable": false, "pk": true, "fk": false }, … ],
  "foreignKeys": [ { "columns": ["GroupId"], "refTable": "AccountGroups", "refColumns": ["Id"], "onDelete": "Cascade", "inferred": false } ],
  "referencedBy": [ { "fromTable": "Vouchers", "columns": ["LedgerId"], "onDelete": "Restrict" } ],
  "indexes": [ { "columns": ["Alias"], "unique": true } ]
} ] }
```
FKs may be `"inferred": true` — when the code uses loose `XxxId` id columns without declared relationships, a reflector can infer edges from naming (`CompanyId → Companies`). A ready-made **EF Core reflector** example (reads `DbContext.Model`, no DB connection needed) ships separately; adapt it to your ORM.

**Existing-DB migration check.** If your app upgrades *live* databases with startup DDL patches (idempotent `ALTER TABLE ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`) rather than full migrations, point `schemaPatchFiles` at the file(s)/dir holding them. Then `cg schema <Table>` reports which columns have an ALTER patch vs not, and **`cg impact <Column>` says whether that column's patch is FOUND or MISSING** — catching the "added a column but forgot the patch → *no such column* on customer data" bug class before it ships.

## Scope of the precise TS layer
ts-morph loads exactly the files your `tsconfig`'s `include` defines (e.g. `["src"]`). Files outside it — `tests/`, `poc/`, `*.config.ts` — are **not** in the precise TS graph, but they *are* in the fast tree-sitter layer (which indexes every `.ts`/`.tsx`). So `cg refs X` covers them; `cg refs X --precise` covers the app project only.

If your repo uses **TypeScript project references** to split source across multiple composite `tsconfig`s (a real monorepo), point `tsConfig` at the composite root — ts-morph loads the tsconfig you give it and does **not** auto-follow `references` into sibling projects.

Precise resolution is per-language: ts-morph resolves the TS project, Roslyn resolves the C# project. No symbol spans both languages — the frontend↔backend boundary is the JSON/HTTP seam, which `cg impact` surfaces via its seam scan (and the serializer's `PascalCase`⇄`camelCase` mapping means the field *name* differs across the wire, so watch that in the checklist).

## Limitations
- Syntactic references (default) are name-scoped — use `--precise` for exact C# / TS.
- Precise layers cover C# and TypeScript; other languages get the fast syntactic layer only.
- Localhost, single-user; not a hosted service.
