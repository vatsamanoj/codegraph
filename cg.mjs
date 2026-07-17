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
const TREE = CFG.ports.treeSitter, ROSLYN = CFG.ports.roslyn;
const argv = process.argv.slice(2);
const precise = argv.includes('--precise');
const [cmd, name] = argv.filter(a => a !== '--precise');
const PORT = precise ? ROSLYN : TREE;
const short = (f) => { for (const r of CFG.roots) { if (f.toLowerCase().startsWith(r.toLowerCase())) return f.slice(r.length + 1).replace(/\\/g, '/'); } return f.replace(/\\/g, '/'); };

function get(pathname, port = PORT) {
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

const run = async () => {
  if (cmd === 'status') { console.log(JSON.stringify(await get('/status', TREE), null, 2)); if (CFG.dotnetSolution) { try { console.log('roslyn: ' + JSON.stringify(await get('/status', ROSLYN))); } catch { console.log('roslyn: not reachable'); } } return; }
  if (cmd === 'reindex') return console.log(JSON.stringify(await get('/reindex'), null, 2));
  if (!name) { console.log('usage: cg def|refs|callers|impl|impact <Name> [--precise]  |  cg status|reindex'); process.exit(1); }
  if (cmd === 'def') return printList(`Definitions of ${name}`, (await get('/def?name=' + encodeURIComponent(name))).results);
  if (cmd === 'refs') return printList(`References to ${name}${precise ? ' [precise]' : ''}`, (await get('/refs?name=' + encodeURIComponent(name))).results);
  if (cmd === 'callers') return printList(`Callers of ${name}${precise ? ' [precise]' : ''}`, (await get('/callers?name=' + encodeURIComponent(name))).results);
  if (cmd === 'impl') return printList(`Implementations/overrides of ${name} [precise]`, (await get('/impl?name=' + encodeURIComponent(name), ROSLYN)).results);
  if (cmd === 'impact') {
    console.log(`=== IMPACT: ${name}${precise ? ' [precise]' : ''} ===\n`);
    printList('Definitions', (await get('/def?name=' + encodeURIComponent(name))).results);
    printList('References', (await get('/refs?name=' + encodeURIComponent(name))).results);
    printList('Callers', (await get('/callers?name=' + encodeURIComponent(name))).results);
    const seams = seamScan(name);
    console.log(`\nCross-language seams (${CFG.seamExtensions.join(',')}) (${seams.length})`);
    for (const s of seams.slice(0, 30)) console.log(`  ${s.file}:${s.line}`);
    console.log('\n' + (CFG.impactChecklist || DEFAULT_CHECKLIST));
    return;
  }
  console.log('unknown command'); process.exit(1);
};
run().catch(e => { console.error(e.message); process.exit(1); });
