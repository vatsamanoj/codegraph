// Session-scoped code-graph daemon: HTTP query API + live file-watch incremental reindex.
// Manages BOTH the tree-sitter server and (when a .sln is present) the warm Roslyn server.
// Subcommands: serve (run tree-sitter) | start (spawn both, detached) | stop | status
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { CodeGraph } from './graph.mjs';
import { loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = loadConfig();
const META = path.join(HERE, '.daemon.json');
const ROSLYN_META = path.join(HERE, '.roslyn.json');
const ROSLYN_DLL = path.join(HERE, 'roslyn', 'bin', 'Release', 'net10.0', 'CodeGraphRoslyn.dll');
const TS_META = path.join(HERE, '.ts.json');
const TS_SERVER = path.join(HERE, 'ts', 'server.mjs');
const LOG = path.join(HERE, 'daemon.log');
const PORT = CONFIG.ports.treeSitter;
const cmd = process.argv[2] || 'status';

const readMeta = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const httpGet = (port, pathname) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, timeout: 8000 }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b)); })
    .on('error', reject).on('timeout', () => reject(new Error('timeout')));
});

function startRoslyn() {
  if (!CONFIG.dotnetSolution) return;                              // no .NET solution -> tree-sitter only
  const m = readMeta(ROSLYN_META);
  if (m && alive(m.pid)) { console.log(`roslyn already running (pid ${m.pid}, port ${m.port})`); return; }
  if (!fs.existsSync(ROSLYN_DLL)) { console.log('roslyn: dll not built — run setup.mjs (precise C# layer skipped)'); return; }
  const out = fs.openSync(LOG, 'a');
  const child = spawn('dotnet', [ROSLYN_DLL], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
    env: { ...process.env, CODEGRAPH_SLN: CONFIG.dotnetSolution, CODEGRAPH_ROOT: CONFIG.roots[0], CODEGRAPH_ROSLYN_PORT: String(CONFIG.ports.roslyn) },
  });
  child.unref();
  try { fs.writeFileSync(ROSLYN_META, JSON.stringify({ pid: child.pid, port: CONFIG.ports.roslyn, startedAt: Date.now() })); } catch {}
  console.log(`roslyn precise server starting (pid ${child.pid}, port ${CONFIG.ports.roslyn}) — warming solution`);
}
function stopRoslyn() {
  const m = readMeta(ROSLYN_META);
  if (m && alive(m.pid)) { try { process.kill(m.pid); } catch {} console.log(`roslyn stopped (pid ${m.pid})`); }
  try { fs.unlinkSync(ROSLYN_META); } catch {}
}

// Precise TypeScript layer (warm ts-morph server) — spawned when a tsconfig is present.
function startTs() {
  if (!CONFIG.tsConfig) return;
  const m = readMeta(TS_META);
  if (m && alive(m.pid)) { console.log(`ts already running (pid ${m.pid}, port ${m.port})`); return; }
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [TS_SERVER], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
    env: { ...process.env, CODEGRAPH_TSCONFIG: CONFIG.tsConfig, CODEGRAPH_ROOT: CONFIG.roots[0], CODEGRAPH_TS_PORT: String(CONFIG.ports.ts) },
  });
  child.unref();
  try { fs.writeFileSync(TS_META, JSON.stringify({ pid: child.pid, port: CONFIG.ports.ts, startedAt: Date.now() })); } catch {}
  console.log(`ts precise server starting (pid ${child.pid}, port ${CONFIG.ports.ts}) — warming tsconfig`);
}
function stopTs() {
  const m = readMeta(TS_META);
  if (m && alive(m.pid)) { try { process.kill(m.pid); } catch {} console.log(`ts stopped (pid ${m.pid})`); }
  try { fs.unlinkSync(TS_META); } catch {}
}

if (cmd === 'serve') {
  const log = (m) => fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);
  const g = new CodeGraph(CONFIG);
  let ready = false, lastActivity = Date.now();
  await g.init();
  const t0 = Date.now();
  const n = await g.indexAll();
  log(`indexed ${n} files in ${Date.now() - t0}ms -> ${JSON.stringify(g.stats())}`);
  ready = true;

  const isExcluded = (p) => p.split(/[\\/]/).some(seg => CONFIG.excludeDirs.includes(seg));
  const matches = (p) => CONFIG.extensions.includes(path.extname(p).toLowerCase());
  const watcher = chokidar.watch(CONFIG.roots, { ignoreInitial: true, ignored: (p) => isExcluded(p), awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  const onChange = async (p) => { if (!matches(p) || isExcluded(p)) return; lastActivity = Date.now(); await g.indexFile(p); };
  watcher.on('add', onChange).on('change', onChange).on('unlink', (p) => { if (matches(p)) { lastActivity = Date.now(); g.removeFile(p); } });

  const send = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    const u = new URL(req.url, 'http://x'); const name = u.searchParams.get('name') || ''; const p = u.pathname;
    if (p === '/status') return send(res, { ready, ...g.stats(), roots: CONFIG.roots, pid: process.pid, port: PORT });
    if (p === '/def') return send(res, { name, results: g.defsByName.get(name) || [] });
    if (p === '/refs') return send(res, { name, results: g.refsByName.get(name) || [] });
    if (p === '/callers') return send(res, { name, results: g.callsByName.get(name) || [] });
    if (p === '/reindex') { g.defsByName.clear(); g.refsByName.clear(); g.callsByName.clear(); g.fileData.clear(); const c = await g.indexAll(); return send(res, { reindexed: c, ...g.stats() }); }
    res.writeHead(404); res.end('{}');
  });
  server.listen(PORT, '127.0.0.1', () => { fs.writeFileSync(META, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now() })); log(`listening on 127.0.0.1:${PORT}`); });
  const idleMs = (CONFIG.idleShutdownMinutes || 180) * 60000;
  setInterval(() => { if (Date.now() - lastActivity > idleMs) { log('idle shutdown'); process.exit(0); } }, 300000).unref();
  process.on('SIGTERM', () => process.exit(0));

} else if (cmd === 'start') {
  const m = readMeta(META);
  if (m && alive(m.pid)) console.log(`codegraph already running (pid ${m.pid}, port ${m.port})`);
  else {
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    console.log(`codegraph daemon started (pid ${child.pid}, port ${PORT}) — indexing in background`);
  }
  startRoslyn();
  startTs();

} else if (cmd === 'stop') {
  const m = readMeta(META);
  if (m && alive(m.pid)) { try { process.kill(m.pid); } catch {} console.log(`codegraph stopped (pid ${m.pid})`); } else console.log('codegraph not running');
  try { fs.unlinkSync(META); } catch {}
  stopRoslyn();
  stopTs();

} else if (cmd === 'status') {
  const m = readMeta(META);
  if (!m || !alive(m.pid)) console.log('codegraph (tree-sitter): not running');
  else { try { console.log('tree-sitter: ' + await httpGet(PORT, '/status')); } catch { console.log(`tree-sitter: pid ${m.pid} up, HTTP warming`); } }
  const rm = readMeta(ROSLYN_META);
  if (CONFIG.dotnetSolution) {
    if (!rm || !alive(rm.pid)) console.log('roslyn: not running');
    else { try { console.log('roslyn:      ' + await httpGet(CONFIG.ports.roslyn, '/status')); } catch { console.log(`roslyn: pid ${rm.pid} up, warming solution`); } }
  }
  const tm = readMeta(TS_META);
  if (CONFIG.tsConfig) {
    if (!tm || !alive(tm.pid)) console.log('ts: not running');
    else { try { console.log('ts:          ' + await httpGet(CONFIG.ports.ts, '/status')); } catch { console.log(`ts: pid ${tm.pid} up, warming tsconfig`); } }
  }
}
