// cg — query the code graph.
//   cg status | reindex
//   cg def <Name> | cg refs <Name> | cg callers <Name>
//   cg text <string> [--regex]                               (grep source; each hit tagged with its enclosing symbol)
//   cg refs <Name> --precise | cg callers <Name> --precise   (route C# to the warm Roslyn server)
//   cg impl <Type>                                            (implementations/derived/overrides — Roslyn)
//   cg impact <Name>                                          (refs + cross-language seam scan + checklist)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';

const CFG = loadConfig();
const TREE = CFG.ports.treeSitter, ROSLYN = CFG.ports.roslyn, TSP = CFG.ports.ts;
const argv = process.argv.slice(2);
const precise = argv.includes('--precise');
const [cmd, name] = argv.filter(a => a !== '--precise');
const short = (f) => { const nf = f.replace(/\\/g, '/'); for (const r of CFG.roots) { const nr = r.replace(/\\/g, '/'); if (nf.toLowerCase().startsWith(nr.toLowerCase())) return nf.slice(nr.length + 1); } return nf; };

function get(pathname, port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, timeout: 15000 }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); })
      .on('error', () => reject(new Error(`daemon on :${port} not reachable — run: node daemon.mjs start`)))
      .on('timeout', () => reject(new Error('timeout')));
  });
}

function printList(title, results) {
  console.log(`${title} (${results.length})`);
  const byFile = new Map();
  for (const r of results) { const k = short(r.file); (byFile.get(k) || byFile.set(k, []).get(k)).push(r); }
  for (const [f, rs] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    const kinds = [...new Set(rs.map(r => r.kind).filter(Boolean))];
    console.log(`  ${f}  [${rs.map(r => r.line).slice(0, 12).join(',')}${rs.length > 12 ? ',…' : ''}]${kinds.length ? '  {' + kinds.join(',') + '}' : ''}`);
  }
}

// anchored text search: each hit tagged with its enclosing symbol (string concept -> pivotable symbol)
function printText(query, results) {
  console.log(`Text "${query}" (${results.length}${results.length >= 200 ? '+, capped' : ''})`);
  const byFile = new Map();
  for (const r of results) { const k = short(r.file); (byFile.get(k) || byFile.set(k, []).get(k)).push(r); }
  for (const [f, rs] of byFile) {
    console.log(`  ${f}`);
    for (const r of rs.slice(0, 20)) {
      const enc = r.enclosing ? `   → in ${r.enclosing.name} {${r.enclosing.kind}}` : '';
      console.log(`    ${r.line}: ${r.text}${enc}`);
    }
    if (rs.length > 20) console.log(`    …(${rs.length - 20} more in this file)`);
  }
}

// cross-language seam scan (string/config/schema boundaries the graph can't link)
function* seamFiles() {
  const exc = new Set(CFG.excludeDirs); const want = new Set(CFG.seamExtensions.map(s => s.toLowerCase()));
  const stack = [...CFG.roots];
  while (stack.length) {
    const dir = stack.pop(); let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (!exc.has(e.name)) stack.push(full); } else if (want.has(path.extname(e.name).toLowerCase())) yield full; }
  }
}
function seamScan(term) {
  const hits = [];
  for (const f of seamFiles()) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; } if (!t.includes(term)) continue; t.split('\n').forEach((ln, i) => { if (ln.includes(term)) hits.push({ file: short(f), line: i + 1 }); }); }
  return hits;
}

const DEFAULT_CHECKLIST = `Change-impact checklist — seams the compiler/graph can't auto-link:
  - Data schema: migrations / DDL that must match the model change (compiles fine, fails at runtime)
  - Serialization contracts: DTO / JSON / protobuf / GraphQL types on BOTH sides of an API
  - Client<->server: a renamed field compiles on each side but breaks over the wire
  - Config / feature-flag keys, environment variables
  - i18n / localization keys, generated code, reflection / string-keyed lookups
  - Persisted data / caches keyed by the old shape`;

// Fan a precise query out to whichever precise servers exist (Roslyn=C#, ts-morph=TS), merged + deduped.
async function preciseQuery(sub, sym) {
  const ports = [];
  if (CFG.dotnetSolution) ports.push(ROSLYN);
  if (CFG.tsConfig) ports.push(TSP);
  const all = [];
  for (const p of ports) { try { const r = await get(`${sub}?name=${encodeURIComponent(sym)}`, p); (r.results || []).forEach(x => all.push(x)); } catch {} }
  const seen = new Set();
  return all.filter(x => { const k = x.file + ':' + x.line; if (seen.has(k)) return false; seen.add(k); return true; });
}
const q = (sub) => precise ? preciseQuery(sub, name) : get(`${sub}?name=${encodeURIComponent(name)}`, TREE).then(r => r.results);

// --- relational schema layer (schema.json produced by an EF/DB reflector) ---
let SCHEMA = null;
if (CFG.schemaJson) { try { SCHEMA = JSON.parse(fs.readFileSync(CFG.schemaJson, 'utf8')); } catch {} }
function findTable(n) {
  if (!SCHEMA) return null;
  const k = String(n).toLowerCase();
  return SCHEMA.tables.find(t => t.table.toLowerCase() === k || String(t.entity || '').toLowerCase() === k) || null;
}
function findColumn(n) {
  if (!SCHEMA) return [];
  const k = String(n).toLowerCase();
  return SCHEMA.tables.filter(t => t.columns.some(c => c.name.toLowerCase() === k)).map(t => t.table);
}
// schema-patch coverage: which columns/tables have an idempotent ALTER/CREATE so EXISTING (live) DBs upgrade
let PATCH = '';
function patchFilesOf(entry) {
  try { const st = fs.statSync(entry); if (st.isDirectory()) return fs.readdirSync(entry).filter(n => /\.(cs|sql)$/i.test(n)).map(n => path.join(entry, n)); return [entry]; } catch { return []; }
}
if (CFG.schemaPatchFiles) for (const e of CFG.schemaPatchFiles) for (const f of patchFilesOf(e)) { try { PATCH += fs.readFileSync(f, 'utf8') + '\n'; } catch {} }
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasColumnPatch = (col) => !!PATCH && new RegExp('ADD\\s+COLUMN\\s+["\'\\[\\\\]*' + reEsc(col) + '\\b', 'i').test(PATCH);
const hasTablePatch = (tbl) => !!PATCH && new RegExp('CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+["\'\\[\\\\]*' + reEsc(tbl) + '\\b', 'i').test(PATCH);
function printSchema(t) {
  console.log(`TABLE ${t.table}  (entity ${t.entity || '?'}, ${t.context})`);
  console.log(`  primary key: ${t.primaryKey.join(', ') || '(none)'}`);
  const fkCols = new Set(t.foreignKeys.flatMap(f => f.columns));
  console.log(`  columns (${t.columns.length}):`);
  for (const c of t.columns) console.log(`    ${c.pk ? 'PK' : (fkCols.has(c.name) ? 'FK' : '  ')} ${c.name}: ${c.type}${c.nullable && !c.type.endsWith('?') ? '?' : ''}`);
  if (t.foreignKeys.length) { console.log('  foreign keys (out):'); for (const f of t.foreignKeys) console.log(`    ${f.columns.join(',')} -> ${f.refTable}.${(f.refColumns || ['Id']).join(',')}  ${f.inferred ? '(inferred)' : 'ON DELETE ' + f.onDelete}`); }
  if (t.referencedBy.length) { console.log(`  referenced by (${t.referencedBy.length}):`); for (const r of t.referencedBy) console.log(`    ${r.fromTable}.${r.columns.join(',')}  ${r.onDelete === '(inferred)' ? '(inferred)' : 'ON DELETE ' + r.onDelete}`); }
  if (t.indexes.length) { console.log('  indexes:'); for (const ix of t.indexes) console.log(`    ${ix.columns.join(',')}${ix.unique ? ' UNIQUE' : ''}`); }
  if (PATCH) {
    const patched = t.columns.filter(c => hasColumnPatch(c.name)).map(c => c.name);
    const noPatch = t.columns.filter(c => !hasColumnPatch(c.name) && !t.primaryKey.includes(c.name)).map(c => c.name);
    console.log('  existing-DB schema patch (idempotent ALTER/CREATE — for LIVE customer DBs):');
    console.log(`    table CREATE-IF-NOT-EXISTS: ${hasTablePatch(t.table) ? 'FOUND' : 'not found (a NEW table needs one, or existing DBs won\'t have it)'}`);
    console.log(`    columns WITH an ALTER patch (${patched.length}): ${patched.join(', ') || '(none)'}`);
    console.log(`    columns with NO ALTER patch (${noPatch.length}): ${noPatch.slice(0, 40).join(', ')}${noPatch.length > 40 ? ', …' : ''}`);
    console.log('    ! a column added AFTER release must appear in the WITH list, else live DBs fail "no such column".');
  }
}

const run = async () => {
  if (cmd === 'status') {
    try { console.log('tree-sitter: ' + JSON.stringify(await get('/status', TREE))); } catch { console.log('tree-sitter: not reachable'); }
    if (CFG.dotnetSolution) { try { console.log('roslyn:      ' + JSON.stringify(await get('/status', ROSLYN))); } catch { console.log('roslyn: not reachable'); } }
    if (CFG.tsConfig) { try { console.log('ts:          ' + JSON.stringify(await get('/status', TSP))); } catch { console.log('ts: not reachable'); } }
    return;
  }
  if (cmd === 'reindex') {
    const out = { treeSitter: await get('/reindex', TREE).catch(() => null) };
    if (CFG.dotnetSolution) out.roslyn = await get('/reindex', ROSLYN).catch(() => null);
    if (CFG.tsConfig) out.ts = await get('/reindex', TSP).catch(() => null);
    return console.log(JSON.stringify(out, null, 2));
  }
  if (!name) { console.log('usage: cg def|refs|callers|impl|impact|schema|text <Name> [--precise]  |  cg status|reindex'); process.exit(1); }
  if (cmd === 'text') {
    const r = await get(`/text?name=${encodeURIComponent(name)}${argv.includes('--regex') ? '&regex=1' : ''}`, TREE);
    return printText(name, r.results);
  }
  const tag = precise ? ' [precise]' : '';
  if (cmd === 'schema') { const t = findTable(name); return t ? printSchema(t) : console.log(`no table/entity '${name}' (${SCHEMA ? SCHEMA.tables.length + ' tables loaded' : 'schema.json not configured — see README'})`); }
  if (cmd === 'def') return printList(`Definitions of ${name}${tag}`, await q('/def'));
  if (cmd === 'refs') return printList(`References to ${name}${tag}`, await q('/refs'));
  if (cmd === 'callers') return printList(`Callers of ${name}${tag}`, await q('/callers'));
  if (cmd === 'impl') return printList(`Implementations/overrides of ${name} [precise]`, await preciseQuery('/impl', name));
  if (cmd === 'impact') {
    console.log(`=== IMPACT: ${name}${tag} ===\n`);
    printList('Definitions', await q('/def'));
    printList('References', await q('/refs'));
    printList('Callers', await q('/callers'));
    const seams = seamScan(name);
    console.log(`\nCross-language seams (${CFG.seamExtensions.join(',')}) (${seams.length})`);
    for (const s of seams.slice(0, 30)) console.log(`  ${s.file}:${s.line}`);
    const t = findTable(name);
    if (t) {
      console.log('\n=== Schema ripple (relational) ===');
      printSchema(t);
      console.log('  NOTE: adding/altering a column needs the EF model AND an idempotent ALTER TABLE for existing DBs; a delete cascades per the FKs above.');
    } else if (PATCH) {
      const inTables = findColumn(name);
      if (inTables.length) {
        console.log('\n=== Schema-patch check (column) ===');
        console.log(`  '${name}' is a column on: ${inTables.join(', ')}`);
        console.log(`  idempotent ALTER patch for '${name}': ${hasColumnPatch(name) ? 'FOUND ✓' : "MISSING — if you just added this column, LIVE customer DBs need an ALTER TABLE ADD COLUMN or they fail \"no such column\""}`);
      }
    }
    console.log('\n' + (CFG.impactChecklist || DEFAULT_CHECKLIST));
    return;
  }
  console.log('unknown command'); process.exit(1);
};
run().catch(e => { console.error(e.message); process.exit(1); });
