// One-command setup. Detects the target codebase, installs deps, builds the Roslyn
// server if a .sln is present, writes config.local.json, and (with --hooks) installs
// the Claude Code auto start/stop hooks into <root>/.claude/settings.json.
//
//   node setup.mjs [--root <path>] [--no-roslyn] [--hooks]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectRoot, findSolution, findTsConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);

const root = path.resolve(arg('--root') || detectRoot());
const sln = has('--no-roslyn') ? null : findSolution(root);
const tsConfig = has('--no-ts') ? null : findTsConfig([root]);
const dotnetOk = (() => { try { execSync('dotnet --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

console.log(`codegraph setup`);
console.log(`  codebase root : ${root}`);
console.log(`  solution (C#) : ${sln || '(none)'}`);
console.log(`  tsconfig (TS) : ${tsConfig || '(none)'}`);
console.log(`  dotnet SDK    : ${dotnetOk ? 'yes' : 'no'}`);

// 1) local config
const cfg = { roots: [root], dotnetSolution: sln || null, tsConfig: tsConfig || null };
fs.writeFileSync(path.join(HERE, 'config.local.json'), JSON.stringify(cfg, null, 2));
console.log('  wrote config.local.json');

// 2) node deps
console.log('  installing node deps (npm install)…');
execSync('npm install --no-audit --no-fund', { cwd: HERE, stdio: 'inherit' });

// 3) build Roslyn precise server (only if a solution + SDK exist)
if (sln && dotnetOk) {
  console.log('  building Roslyn precise server (dotnet build -c Release)…');
  try { execSync('dotnet build -c Release', { cwd: path.join(HERE, 'roslyn'), stdio: 'inherit' }); }
  catch { console.log('  ! Roslyn build failed — tree-sitter layer still works; fix .NET and re-run.'); }
} else if (sln && !dotnetOk) {
  console.log('  ! .sln found but no .NET SDK — install it to enable the precise C# layer.');
}

// 4) optional Claude Code hooks (auto start/stop per session)
if (has('--hooks')) {
  const dir = path.join(root, '.claude'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  s.hooks ||= {};
  const daemon = path.join(HERE, 'daemon.mjs');
  const mk = (sub) => ({ hooks: [{ type: 'command', command: `node "${daemon}" ${sub}` }] });
  const ensure = (evt, sub) => {
    s.hooks[evt] ||= [];
    const cmd = `node "${daemon}" ${sub}`;
    const present = JSON.stringify(s.hooks[evt]).includes(daemon.replace(/\\/g, '\\\\'));
    if (!present) s.hooks[evt].push(mk(sub));
  };
  ensure('SessionStart', 'start'); ensure('SessionEnd', 'stop');
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  console.log(`  installed Claude hooks -> ${file}`);
} else {
  console.log('  (skip hooks) add --hooks to auto start/stop per Claude session, or run manually:');
}

console.log(`\nDone. Start it:  node "${path.join(HERE, 'daemon.mjs')}" start`);
console.log(`Query it:       node "${path.join(HERE, 'cg.mjs')}" impact <SymbolName>`);
