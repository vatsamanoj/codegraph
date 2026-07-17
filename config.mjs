// Resolves configuration for whatever codebase this tool is dropped into.
// Precedence: config.local.json (written by setup.mjs) > env (CODEGRAPH_ROOT) > auto-detect.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  ports: { treeSitter: 47615, roslyn: 47616, ts: 47617 },
  idleShutdownMinutes: 180,
  excludeDirs: ['node_modules', 'bin', 'obj', 'dist', 'build', '.git', '.svn', '.hg', '.vs', '.vscode',
    '.idea', 'out', 'target', 'vendor', 'venv', '.venv', '__pycache__', '.next', '.nuxt', 'coverage',
    '.codegraph', '.antigravitycli', 'packages', '.gradle', 'Pods', 'DerivedData'],
  extensions: ['.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
    '.kt', '.rb', '.php', '.swift', '.scala', '.c', '.h', '.cpp', '.hpp', '.cc'],
  seamExtensions: ['.json', '.xml', '.yaml', '.yml', '.sql', '.config', '.toml', '.ini', '.proto', '.graphql', '.env'],
};

export function detectRoot() {
  if (process.env.CODEGRAPH_ROOT) return process.env.CODEGRAPH_ROOT;
  // walk up from the tool dir to the enclosing project (first ancestor with a .git)
  let d = path.dirname(HERE);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  return path.dirname(HERE); // fallback: the tool's parent directory
}

export function findSolution(root) {
  const skip = new Set(DEFAULTS.excludeDirs);
  const q = [{ dir: root, depth: 0 }];
  while (q.length) {
    const { dir, depth } = q.shift();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isFile() && e.name.toLowerCase().endsWith('.sln')) return path.join(dir, e.name);
    if (depth < 3) for (const e of ents) if (e.isDirectory() && !skip.has(e.name)) q.push({ dir: path.join(dir, e.name), depth: depth + 1 });
  }
  return null;
}

export function findTsConfig(roots) {
  const skip = new Set(DEFAULTS.excludeDirs);
  for (const root of roots) {
    const q = [{ dir: root, depth: 0 }];
    while (q.length) {
      const { dir, depth } = q.shift();
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) if (e.isFile() && e.name === 'tsconfig.json') return path.join(dir, e.name);
      if (depth < 2) for (const e of ents) if (e.isDirectory() && !skip.has(e.name)) q.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

export function loadConfig() {
  const localPath = path.join(HERE, 'config.local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const roots = (local.roots && local.roots.length) ? local.roots : [detectRoot()];
  const dotnetSolution = 'dotnetSolution' in local ? local.dotnetSolution : findSolution(roots[0]);
  const tsConfig = 'tsConfig' in local ? local.tsConfig : findTsConfig(roots);
  const localSchema = path.join(HERE, 'schema.json');
  const schemaJson = 'schemaJson' in local ? local.schemaJson : (fs.existsSync(localSchema) ? localSchema : null);
  return {
    HERE,
    roots,
    dotnetSolution: dotnetSolution || null,
    tsConfig: tsConfig || null,
    schemaJson: schemaJson || null,
    schemaPatchFiles: local.schemaPatchFiles || null,   // files/dirs holding idempotent ALTER/CREATE DDL for existing DBs
    ports: { ...DEFAULTS.ports, ...(local.ports || {}) },
    idleShutdownMinutes: local.idleShutdownMinutes ?? DEFAULTS.idleShutdownMinutes,
    excludeDirs: local.excludeDirs || DEFAULTS.excludeDirs,
    extensions: local.extensions || DEFAULTS.extensions,
    seamExtensions: local.seamExtensions || DEFAULTS.seamExtensions,
    impactChecklist: local.impactChecklist || null,
  };
}
