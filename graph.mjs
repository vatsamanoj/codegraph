// Language-agnostic code graph via tree-sitter. Extracts definitions, references, calls.
// Syntactic (name+kind), not type-resolved — the fast/live layer. For type-exact C#,
// the Roslyn server (roslyn/) is the precise layer.
import Parser from 'web-tree-sitter';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = (n) => path.join(HERE, 'node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${n}.wasm`);

// file extension -> tree-sitter-wasms grammar name (extend freely; grammars ship in the package)
const GRAMMAR = {
  '.cs': 'c_sharp', '.ts': 'typescript', '.tsx': 'tsx', '.jsx': 'tsx',
  '.js': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.scala': 'scala',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
};
// leaf nodes that count as name references, across grammars
const ID = new Set(['identifier', 'type_identifier', 'property_identifier', 'field_identifier',
  'shorthand_property_identifier', 'constant', 'name']);
// a definition node introduces a named symbol — generic across grammars
const DEF_RE = /(?:_declaration|_definition|_item|_declarator|_signature|_spec)$/;
const DEF_DENY = new Set(['import_declaration', 'using_directive', 'package_declaration',
  'import_spec', 'import_from_statement', 'export_statement']);
const FUNC_RE = /function|method|lambda|closure|arrow|constructor|local_function/;
const CALL_RE = /call_expression|invocation_expression|method_invocation|function_call/;

export class CodeGraph {
  constructor(config) {
    this.config = config;
    this.langs = new Map();          // grammar name -> Language
    this.defsByName = new Map();
    this.refsByName = new Map();
    this.callsByName = new Map();
    this.fileData = new Map();
  }

  async init() { await Parser.init(); this.parser = new Parser(); }

  async langFor(file) {
    const ext = path.extname(file).toLowerCase();
    const g = GRAMMAR[ext]; if (!g) return null;
    if (!this.langs.has(g)) {
      try { this.langs.set(g, await Parser.Language.load(WASM(g))); } catch { this.langs.set(g, null); }
    }
    return this.langs.get(g);
  }

  static defName(n) {
    const nm = n.childForFieldName('name');
    if (nm) return nm.text;
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (ID.has(c.type)) return c.text; }
    return null;
  }

  static calleeName(n) {
    let f = n.childForFieldName('function') || n.childForFieldName('expression') || n.childForFieldName('name') || n.namedChild(0);
    if (!f) return null;
    if (ID.has(f.type)) return f.text;
    const nm = f.childForFieldName('name') || f.childForFieldName('property') || f.childForFieldName('field');
    if (nm && ID.has(nm.type)) return nm.text;
    let last = null;
    (function d(x) { if (ID.has(x.type)) last = x.text; for (let i = 0; i < x.childCount; i++) d(x.child(i)); })(f);
    return last;
  }

  removeFile(file) {
    const prev = this.fileData.get(file); if (!prev) return;
    const drop = (map, list) => { for (const e of list) { const arr = map.get(e.name); if (arr) { const k = arr.filter(x => x.file !== file); if (k.length) map.set(e.name, k); else map.delete(e.name); } } };
    drop(this.defsByName, prev.defs); drop(this.refsByName, prev.refs); drop(this.callsByName, prev.calls);
    this.fileData.delete(file);
  }

  async indexFile(file) {
    let src; try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (src.length > 1_500_000) return;
    const language = await this.langFor(file); if (!language) return;
    this.parser.setLanguage(language);
    let tree; try { tree = this.parser.parse(src); } catch { return; }
    this.removeFile(file);
    const defs = [], refs = [], calls = [];
    const add = (map, list, name, entry) => { if (!name) return; entry.name = name; list.push(entry); const a = map.get(name) || []; a.push(entry); map.set(name, a); };
    const D = this.defsByName, R = this.refsByName, C = this.callsByName;
    (function walk(n, inFunc) {
      const t = n.type;
      if (DEF_RE.test(t) && !DEF_DENY.has(t)) {
        const isDeclarator = t.endsWith('_declarator');
        if (!(isDeclarator && inFunc)) add(D, defs, CodeGraph.defName(n), { file, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1, kind: t });
      }
      if (ID.has(t)) add(R, refs, n.text, { file, line: n.startPosition.row + 1 });
      if (CALL_RE.test(t)) add(C, calls, CodeGraph.calleeName(n), { file, line: n.startPosition.row + 1 });
      const nf = inFunc || FUNC_RE.test(t);
      for (let i = 0; i < n.childCount; i++) walk(n.child(i), nf);
    })(tree.rootNode, false);
    tree.delete?.();
    this.fileData.set(file, { defs, refs, calls });
  }

  * walkFiles() {
    const exc = new Set(this.config.excludeDirs);
    const exts = this.config.extensions;
    const stack = [...this.config.roots];
    while (stack.length) {
      const dir = stack.pop();
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!exc.has(e.name)) stack.push(full); }
        else if (exts.includes(path.extname(e.name).toLowerCase())) yield full;
      }
    }
  }

  async indexAll() { let n = 0; for (const f of this.walkFiles()) { await this.indexFile(f); n++; } return n; }
  stats() { return { files: this.fileData.size, defs: this.defsByName.size, refs: this.refsByName.size, calls: this.callsByName.size }; }

  // Innermost definition whose span [line, endLine] contains hitLine — the "what function
  // am I in?" answer the graph can give but grep can't. Falls back gracefully when a def
  // was indexed before spans existed (endLine missing -> single-line containment only).
  enclosingDef(file, hitLine) {
    const fd = this.fileData.get(file); if (!fd) return null;
    let best = null;
    for (const d of fd.defs) {
      const start = d.line, end = d.endLine || d.line;
      if (start <= hitLine && end >= hitLine && (!best || d.line > best.line)) best = d;
    }
    return best ? { name: best.name, kind: best.kind, line: best.line } : null;
  }

  // Anchored text search: grep the indexed source for a string/literal/JSX-text/class/key
  // that isn't an identifier (so /refs can't find it), and tag each hit with its enclosing
  // symbol — the bridge from "a concept named as a string" to a symbol you can then pivot
  // on with /callers or /refs. Literal substring by default (case-insensitive); regex opt-in.
  textSearch(query, { regex = false, max = 200, ignoreCase = true } = {}) {
    if (!query) return [];
    let re = null;
    if (regex) { try { re = new RegExp(query, ignoreCase ? 'i' : ''); } catch { re = null; } }
    const needle = ignoreCase ? query.toLowerCase() : query;
    const hits = [];
    for (const file of this.walkFiles()) {
      let src; try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (src.length > 1_500_000) continue;
      if (re) { if (!re.test(src)) continue; } else if ((ignoreCase ? src.toLowerCase() : src).indexOf(needle) === -1) continue;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const ok = re ? re.test(ln) : (ignoreCase ? ln.toLowerCase() : ln).includes(needle);
        if (!ok) continue;
        hits.push({ file, line: i + 1, text: ln.trim().slice(0, 200), enclosing: this.enclosingDef(file, i + 1) });
        if (hits.length >= max) return hits;
      }
    }
    return hits;
  }
}
