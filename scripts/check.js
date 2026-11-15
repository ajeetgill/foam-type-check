#!/usr/bin/env node
// FOAM type check: one command.
//   node check.js [dir]    regenerate the types, run the style rules and the type check
//   node check.js --hook   same, as a Claude Code PostToolUse hook (reads the hook JSON on stdin)
//
// Settings live in the app, in foam-check.config.json:
//   app      the app folder (holds foam3/ and pom.js), relative to the config file. Default "."
//   package  the package prefix the style rules apply to
//   sources  the folders to type-check, relative to the app folder
//   tsc      optional: path to the TypeScript "tsc" program, relative to the config file
// Generated files go to .foam-check/ next to the config file. Add that folder to .gitignore.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const CONFIG = 'foam-check.config.json';
const hook = process.argv.includes('--hook');
const STYLE = /: (property has no class|argument has no type|import has no type|DAO import does not say)/;

// Walk up from a folder until a config file is found.
const findConfig = from => {
  for ( let d = path.resolve(from); ; d = path.dirname(d) ) {
    if ( fs.existsSync(path.join(d, CONFIG)) ) return path.join(d, CONFIG);
    if ( d === path.dirname(d) ) return null;
  }
};

let edited = '';
if ( hook ) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) {}
  edited = (input.tool_input && input.tool_input.file_path) || (input.tool_response && input.tool_response.filePath) || '';
  if ( ! edited.endsWith('.js') ) process.exit(0);
}

const start = hook ? path.dirname(edited) : (process.argv.slice(2).find(a => ! a.startsWith('--')) || process.cwd());
const cfgFile = findConfig(start) || (hook && process.env.CLAUDE_PROJECT_DIR && findConfig(process.env.CLAUDE_PROJECT_DIR));
if ( ! cfgFile ) {
  if ( hook ) process.exit(0);          // not a project that uses this check
  console.error(`No ${CONFIG} found in ${path.resolve(start)} or above it.`); process.exit(1);
}

const fail = text => {
  if ( hook ) { console.error(`FOAM type check failed after editing ${edited}. Fix these:\n${text}`); process.exit(2); }
  console.log(text); process.exit(1);
};

let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { fail(`${cfgFile} is not valid JSON: ${e.message}`); }
if ( typeof cfg.package !== 'string' || ! Array.isArray(cfg.sources) || ! cfg.sources.length )
  fail(`${cfgFile} needs "package" (a string) and "sources" (a list of folders).`);

const base = path.dirname(cfgFile);
const app  = path.resolve(base, cfg.app || '.');
const dirs = cfg.sources.map(s => path.resolve(app, s));
// In hook mode only model files inside the checked folders matter.
if ( hook && ! dirs.some(d => edited.startsWith(d + path.sep)) ) process.exit(0);

for ( const need of ['foam3/src/foam_node.js', 'pom.js'] )
  if ( ! fs.existsSync(path.join(app, need)) ) fail(`${path.join(app, need)} not found. Check "app" in ${cfgFile}.`);

const work = path.join(base, '.foam-check');
fs.mkdirSync(work, { recursive: true });

// 1. Types from the live models (also prints the style report).
const gen = spawnSync(process.execPath, [path.join(__dirname, 'gen-types.js')], {
  cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, FOAM_APP: app, FOAM_DTS_OUT: path.join(work, 'app.d.ts'), FOAM_STYLE: cfg.package }
});
const out = (gen.stdout || '') + (gen.stderr || '');
if ( gen.status !== 0 ) fail('The models did not load.\n' + out.split('\n').slice(-25).join('\n'));

const problems = [];
const lines = out.split('\n');
const at = lines.findIndex(l => l.startsWith('FOAM assertions failed'));
if ( at >= 0 ) { let end = at + 1; while ( end < lines.length && lines[end].startsWith('  ') ) end++; problems.push(lines.slice(at, end).join('\n')); }
const style = lines.filter(l => STYLE.test(l));
if ( style.length ) problems.push('Style rules broken:\n' + style.join('\n'));

// 2. Type check. The tsconfig is written from the config, so there is one place to edit.
const rel = p => path.relative(work, p).split(path.sep).join('/');
fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: false, target: 'es2022', lib: ['es2022', 'dom'], types: [] },
  include: ['app.d.ts', ...dirs.map(d => rel(d) + '/**/*.js')]
}, null, 2) + '\n');

// TypeScript: the config's "tsc", then the app's own install, then the plugin's.
const bin = d => path.join(d, 'node_modules', '.bin', 'tsc');
const tscPath = [
  cfg.tsc && path.resolve(base, cfg.tsc), bin(base), bin(app),
  process.env.CLAUDE_PLUGIN_DATA && bin(process.env.CLAUDE_PLUGIN_DATA), bin(path.dirname(__dirname))
].filter(Boolean).find(p => fs.existsSync(p));
if ( ! tscPath ) fail(`TypeScript not found. Run "npm install --save-dev typescript" in ${base}, or set "tsc" in ${cfgFile}.`);

const tsc = spawnSync(tscPath, ['-p', 'tsconfig.json'], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if ( tsc.error ) fail(`Could not run ${tscPath}: ${tsc.error.message}`);
if ( tsc.status !== 0 ) {
  // Show paths from the app folder, not from .foam-check/.
  const text = ((tsc.stdout || '') + (tsc.stderr || '')).trim().split('\n').slice(0, 40)
    .map(l => l.replace(/^(\S+?)\((\d+),(\d+)\)/, (m, f, a, b) => `${path.relative(app, path.resolve(work, f))}(${a},${b})`)).join('\n');
  problems.push('Type errors:\n' + text);
}

if ( problems.length ) fail(problems.join('\n'));
if ( ! hook ) console.log(`FOAM type check: 0 problems (${cfg.package})`);
