# codegraph

A **session-scoped code graph** you drop into any repo to answer *"what defines / references / calls / breaks-if-I-change* this?"* — fast, live, and local.

Two layers:

| Layer | What | Strength |
|---|---|---|
| **tree-sitter** (always on) | Node daemon, any language | Instant, live (re-indexes on save), `def` / `refs` / `callers` / `impact` |
| **Roslyn** (auto, if a `.sln` exists) | warm .NET server | **Type-exact** C# `refs` / `callers` / `impl` — resolves overloads, interfaces, inheritance |

It boots when your editor/agent session starts, keeps the index current via a file-watcher, and shuts down when the session ends. Localhost only.

## Requirements
- **Node.js 18+** (the core; no native build — tree-sitter runs as WASM).
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
node cg.mjs refs <Name> --precise     # references (type-exact C#, via Roslyn)
node cg.mjs callers <Name> --precise  # exact callers
node cg.mjs impl <Type>               # implementations / derived / overrides (Roslyn)
node cg.mjs impact <Name>             # refs + cross-language seam scan + change checklist
```

`impact` also greps config/schema/serialization files (`.json`, `.sql`, `.proto`, `.yaml`, …) for the name, because the graph can't link string/JSON/DDL seams — the boundaries where a rename compiles on both sides but breaks at runtime.

## Lifecycle
- **With Claude Code:** `--hooks` wires `SessionStart → start`, `SessionEnd → stop`.
- **Anywhere else:** call `node daemon.mjs start` / `stop` yourself (from your shell rc, a git hook, a task runner…). It's idempotent, and self-shuts-down after idle (default 180 min).

## Languages
tree-sitter grammars ship for: C#, TypeScript/TSX/JS, Python, Go, Rust, Java, Kotlin, Ruby, PHP, Swift, Scala, C/C++ (extend the map in `graph.mjs`). Definitions are detected generically (`*_declaration` / `*_definition` / `*_item` with a name), so new languages mostly work out of the box. Precise references are C#-only (Roslyn); other languages get fast syntactic references.

## Config (`config.local.json`, written by setup)
```json
{
  "roots": ["C:\\path\\to\\repo"],
  "dotnetSolution": "C:\\path\\to\\repo\\App.sln",
  "ports": { "treeSitter": 47615, "roslyn": 47616 },
  "impactChecklist": "…optional project-specific checklist…"
}
```

## How it works
- **tree-sitter** parses each file to a syntax tree and records definitions, identifier references, and call sites into in-memory maps. Syntactic: fast and language-agnostic, but a name shared across types can over-report.
- **Roslyn** loads the `.sln` into the C# compiler's semantic model once and answers `SymbolFinder.FindReferences/FindCallers/FindImplementations` — type-resolved, no false positives. It live-updates changed `.cs` files; adding/removing `.cs` sets `dirty` in `/status` → `cg reindex` for a full refresh.

## Limitations
- Syntactic references (default) are name-scoped — use `--precise` for exact C#.
- Precise references cover C# only; TS precision would need a `tsserver`/`ts-morph` layer (not built).
- Localhost, single-user; not a hosted service.
