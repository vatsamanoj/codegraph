// cg — query the code graph.
//   cg status | reindex
//   cg def <Name> | cg refs <Name> | cg callers <Name>
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
function printSchema(t) {
  console.log(`TABLE ${t.table}  (entity ${t.entity || '?'}, ${t.context})`);
  console.log(`  primary key: ${t.primaryKey.join(', ') || '(none)'}`);
  const fkCols = new Set(t.foreignKeys.flatMap(f => f.columns));
  console.log(`  columns (${t.columns.length}):`);
  for (const c of t.columns) console.log(`    ${c.pk ? 'PK' : (fkCols.has(c.name) ? 'FK' : '  ')} ${c.name}: ${c.type}${c.nullable && !c.type.endsWith('?') ? '?' : ''}`);
  if (t.foreignKeys.length) { console.log('  foreign keys (out):'); for (const f of t.foreignKeys) console.log(`    ${f.columns.join(',')} -> ${f.refTable}.${(f.refColumns || ['Id']).join(',')}  ${f.inferred ? '(inferred)' : 'ON DELETE ' + f.onDelete}`); }
  if (t.referencedBy.length) { console.log(`  referenced by (${t.referencedBy.length}):`); for (const r of t.referencedBy) console.log(`    ${r.fromTable}.${r.columns.join(',')}  ${r.onDelete === '(inferred)' ? '(inferred)' : 'ON DELETE ' + r.onDelete}`); }
  if (t.indexes.length) { console.log('  indexes:'); for (const ix of t.indexes) console.log(`    ${ix.columns.join(',')}${ix.unique ? ' UNIQUE' : ''}`); }
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
  if (!name) { console.log('usage: cg def|refs|callers|impl|impact|schema <Name> [--precise]  |  cg status|reindex'); process.exit(1); }
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
    }
    console.log('\n' + (CFG.impactChecklist || DEFAULT_CHECKLIST));
    return;
  }
  console.log('unknown command'); process.exit(1);
};
run().catch(e => { console.error(e.message); process.exit(1); });
