// Warm TypeScript precise server — type-resolved refs/callers/impls/defs via ts-morph
// (the TS compiler's language service). Loads a tsconfig project once, keeps it warm,
// live-refreshes changed .ts/.tsx, serves on 127.0.0.1:47617. Managed by the Node daemon.
import http from 'node:http';
import path from 'node:path';
import chokidar from 'chokidar';
import { Project, Node, SyntaxKind } from 'ts-morph';

const TSCONFIG = process.env.CODEGRAPH_TSCONFIG || '';
const PORT = Number(process.env.CODEGRAPH_TS_PORT) || 47617;
if (!TSCONFIG) { console.error('[ts] no CODEGRAPH_TSCONFIG — nothing to do'); process.exit(0); }

let ready = false, loadedAt = null, project = null;

function load() {
  const t0 = Date.now();
  project = new Project({ tsConfigFilePath: TSCONFIG });
  loadedAt = new Date().toISOString();
  ready = true;
  console.error(`[ts] loaded ${project.getSourceFiles().length} files in ${Date.now() - t0}ms`);
}

// declarations (and class/interface members) whose name === X → their name nodes
function declNameNodes(name) {
  const nodes = [];
  const push = (d) => { try { if (d.getName && d.getName() === name) { const nn = d.getNameNode?.(); if (nn && Node.isIdentifier(nn)) nodes.push(nn); } } catch {} };
  for (const sf of project.getSourceFiles()) {
    sf.getClasses().forEach(push); sf.getFunctions().forEach(push); sf.getInterfaces().forEach(push);
    sf.getTypeAliases().forEach(push); sf.getEnums().forEach(push); sf.getModules().forEach(push);
    sf.getVariableDeclarations().forEach(push);
    for (const c of sf.getClasses()) { c.getMethods().forEach(push); c.getProperties().forEach(push); c.getGetAccessors().forEach(push); c.getSetAccessors().forEach(push); }
    for (const i of sf.getInterfaces()) { i.getMethods().forEach(push); i.getProperties().forEach(push); }
  }
  return nodes;
}
const loc = (n, extra = {}) => ({ file: n.getSourceFile().getFilePath(), line: n.getStartLineNumber(), ...extra });

function defs(name) { return declNameNodes(name).map(n => loc(n, { kind: n.getParent()?.getKindName?.() })); }

function refNodes(name) {
  const seen = new Set(), out = [];
  for (const nn of declNameNodes(name)) {
    let syms; try { syms = nn.findReferences(); } catch { continue; }
    for (const s of syms) for (const e of s.getReferences()) {
      const n = e.getNode(); const key = n.getSourceFile().getFilePath() + ':' + n.getStartLineNumber();
      if (!seen.has(key)) { seen.add(key); out.push({ node: n, isDef: e.isDefinition() }); }
    }
  }
  return out;
}
function refs(name) { return refNodes(name).map(r => loc(r.node, { isDef: r.isDef })); }

function isCallSite(node) {
  const p = node.getParent(); if (!p) return false;
  if (Node.isCallExpression(p) && p.getExpression() === node) return true;
  if (Node.isPropertyAccessExpression(p) || Node.isElementAccessExpression(p)) {
    const gp = p.getParent(); return !!gp && Node.isCallExpression(gp) && gp.getExpression() === p;
  }
  return false;
}
function callers(name) {
  return refNodes(name).filter(r => isCallSite(r.node)).map(r => {
    const fn = r.node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)
      || r.node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration)
      || r.node.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
    return loc(r.node, { caller: fn?.getName?.() || fn?.getKindName?.() || '' });
  });
}
function impls(name) {
  const out = [];
  for (const nn of declNameNodes(name)) {
    let list; try { list = nn.getImplementations(); } catch { continue; }
    for (const im of list) { const n = im.getNode(); out.push(loc(n, { kind: 'impl' })); }
  }
  return out;
}

function refreshFile(fp) {
  try {
    const sf = project.getSourceFile(fp);
    if (sf) sf.refreshFromFileSystemSync();
    else project.addSourceFileAtPathIfExists(fp);
  } catch {}
}
function forgetFile(fp) { try { const sf = project.getSourceFile(fp); if (sf) project.removeSourceFile(sf); } catch {} }

// --- boot: load (blocking) then serve + watch ---
load();
const root = path.dirname(TSCONFIG);
chokidar.watch(root, { ignoreInitial: true, ignored: (p) => /[\\/](node_modules|dist|build|\.git|coverage)[\\/]/.test(p) })
  .on('add', p => { if (/\.(ts|tsx)$/i.test(p)) refreshFile(p); })
  .on('change', p => { if (/\.(ts|tsx)$/i.test(p)) refreshFile(p); })
  .on('unlink', p => { if (/\.(ts|tsx)$/i.test(p)) forgetFile(p); });

const send = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); const name = u.searchParams.get('name') || ''; const p = u.pathname;
    if (p === '/status') return send(res, { ready, files: project?.getSourceFiles().length || 0, loadedAt, pid: process.pid, port: PORT });
    if (p === '/reindex') { load(); return send(res, { reindexed: true, files: project.getSourceFiles().length }); }
    if (!ready) return send(res, { error: 'warming up' });
    if (p === '/def') return send(res, { name, precise: true, results: defs(name) });
    if (p === '/refs') return send(res, { name, precise: true, results: refs(name) });
    if (p === '/callers') return send(res, { name, precise: true, results: callers(name) });
    if (p === '/impl') return send(res, { name, precise: true, results: impls(name) });
    res.writeHead(404); res.end('{}');
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, '127.0.0.1', () => console.error(`[ts] listening on 127.0.0.1:${PORT}`));
