#!/usr/bin/env node
// FTypechecks (FOAM Type-Checking): one command.
//
//   node check.js [app dir]             check; fails on problems (new ones only, if there is a starting list)
//   node check.js [app dir] --report    conversion report: what is left to convert, per file
//   node check.js [app dir] --baseline  write the starting list: accept today's problems, fail only on new ones
//   node check.js [app dir] --all       check and ignore the starting list
//   node check.js --hook                Claude Code PostToolUse hook (reads the hook JSON on stdin)
//
// Settings live in the app, in foam-check.config.json:
//   app      the app folder (holds foam3/ and pom.js), relative to the config file. Default "."
//   package  the package prefix the style rules apply to
//   sources  the folders to type-check, relative to the app folder
//   tsc      optional: path to the TypeScript "tsc" program, relative to the config file
// The starting list is foam-check.baseline.json, next to the config file. Commit it.
// Generated files go to .foam-check/ next to the config file. Add that folder to .gitignore.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const CONFIG = 'foam-check.config.json', BASELINE = 'foam-check.baseline.json';
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const hook = flags.has('--hook');
const known = ['--hook', '--report', '--baseline', '--all'];
for ( const f of flags ) if ( ! known.includes(f) ) { console.error(`Unknown option ${f}. Options: ${known.join(' ')}`); process.exit(1); }

// ---------- plain-language text ----------
const color = ! hook && process.stdout.isTTY && ! process.env.NO_COLOR;
const paint = (code, s) => color ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = s => paint(1, s), red = s => paint(31, s), dim = s => paint(2, s), green = s => paint(32, s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

const TS_LABEL = {
  TS2339: 'Unknown name', TS2551: 'Unknown name',
  TS2353: 'Unknown key (FOAM would silently drop it)', TS2561: 'Unknown key (FOAM would silently drop it)',
  TS2554: 'Wrong number of arguments', TS2555: 'Wrong number of arguments',
  TS2345: 'Wrong type', TS2322: 'Wrong type', TS2304: 'Name is not defined', TS2552: 'Name is not defined'
};
const RULES = {
  'property has no class':                { group: 'properties with no class',       one: 'property with no class',         fix: "Add a class, for example class: 'String'." },
  'argument has no type':                 { group: 'methods with untyped arguments', one: 'method with untyped arguments',  fix: "Use the object form: { name, args: 'Type name', code: function(name) {...} }." },
  'import has no type':                   { group: 'imports with no type',           one: 'import with no type',            fix: "Use the object form: { name: 'x', key: 'x', type: 'Type' }." },
  'DAO import does not say what it holds': { group: 'DAO imports with no "of"',       one: 'DAO import with no "of"',        fix: "Add of: '<class id>' to the import." }
};

// ---------- find the app ----------
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

// A failure of the tool itself (not a problem in the code).
const stop = text => { console.error(hook ? `FTypechecks could not run after editing ${edited}.\n${text}` : text); process.exit(hook ? 2 : 1); };

let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { stop(`${cfgFile} is not valid JSON: ${e.message}`); }
if ( typeof cfg.package !== 'string' || ! Array.isArray(cfg.sources) || ! cfg.sources.length )
  stop(`${cfgFile} needs "package" (a string) and "sources" (a list of folders).`);

const base = path.dirname(cfgFile);
const app  = path.resolve(base, cfg.app || '.');
const dirs = cfg.sources.map(s => path.resolve(app, s));
const inSources = f => dirs.some(d => f.startsWith(d + path.sep));
// In hook mode only model files inside the checked folders matter.
if ( hook && ! inSources(edited) ) process.exit(0);

for ( const need of ['foam3/src/foam_node.js', 'pom.js'] )
  if ( ! fs.existsSync(path.join(app, need)) ) stop(`${path.join(app, need)} not found. Check "app" in ${cfgFile}.`);

const work = path.join(base, '.foam-check');
fs.mkdirSync(work, { recursive: true });
const relApp = f => f ? path.relative(app, path.resolve(app, f)).split(path.sep).join('/') : '(no file)';

// ---------- 1. types from the live models, plus the style report ----------
const reportFile = path.join(work, 'report.json');
try { fs.unlinkSync(reportFile); } catch (e) {}
const gen = spawnSync(process.execPath, [path.join(__dirname, 'gen-types.js')], {
  cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, FOAM_APP: app, FOAM_DTS_OUT: path.join(work, 'app.d.ts'), FOAM_STYLE: cfg.package, FOAM_REPORT: reportFile }
});
if ( gen.status !== 0 || ! fs.existsSync(reportFile) )
  stop('The models did not load. Last lines:\n' + ((gen.stdout || '') + (gen.stderr || '')).trim().split('\n').slice(-25).join('\n'));
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

// Every problem: { file, line, kind, title, detail, fix, group, key }.
// "key" has no line number, so the starting list survives edits above a problem.
const problems = [];
for ( const a of report.asserts ) problems.push({
  file: relApp(a.file), line: 0, kind: 'foam', title: `${a.where.split('.').pop()}: FOAM rejected this while loading`,
  detail: a.message, group: 'failed FOAM assertions', key: `foam|${a.where}|${a.message}`
});
for ( const s of report.style ) problems.push({
  file: relApp(s.file), line: 0, kind: 'style', title: `${s.kind} ${s.member}: ${s.rule}`, member: s.member,
  fix: RULES[s.rule].fix, group: RULES[s.rule].group, key: `style|${s.cls}.${s.member}|${s.rule}`
});

// ---------- 2. type check ----------
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
if ( ! tscPath ) stop(`TypeScript not found. Run "npm install --save-dev typescript" in ${base}, or set "tsc" in ${cfgFile}.`);

const tsc = spawnSync(tscPath, ['-p', 'tsconfig.json', '--pretty', 'false'], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if ( tsc.error ) stop(`Could not run ${tscPath}: ${tsc.error.message}`);
let last = null;
for ( const l of ((tsc.stdout || '') + (tsc.stderr || '')).split('\n') ) {
  const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if ( m ) {
    const file = relApp(path.resolve(work, m[1]));
    last = { file, line: +m[2], kind: 'type', title: `${TS_LABEL[m[4]] || 'Type error'} (${m[4]})`, detail: m[5], group: 'type errors', key: `type|${file}|${m[4]}|${m[5]}` };
    problems.push(last);
  } else if ( last && /^\s+\S/.test(l) ) last.detail += '\n' + l.trim();   // rest of a long message
  else if ( /error TS\d+/.test(l) ) problems.push(last = { file: '(TypeScript)', line: 0, kind: 'type', title: 'TypeScript could not run the check', detail: l.trim(), group: 'type errors', key: `type||${l.trim()}` });
}

// ---------- starting list ----------
const count = list => list.reduce((m, p) => (m[p.key] = (m[p.key] || 0) + 1, m), {});
const baseFile = path.join(base, BASELINE);
const now = count(problems);

if ( flags.has('--baseline') ) {
  const sorted = Object.fromEntries(Object.keys(now).sort().map(k => [k, now[k]]));
  fs.writeFileSync(baseFile, JSON.stringify({ version: 1, package: cfg.package, total: problems.length, problems: sorted }, null, 2) + '\n');
  console.log(`${bold('Starting list written')}: ${plural(problems.length, 'problem')} accepted.\n` +
    `File: ${baseFile}\n` +
    `From now on the check fails only on new problems.\n` +
    `Commit this file. Run --baseline again after you convert code, to shrink the list.`);
  process.exit(0);
}

let listed = {}, hasBase = false;
if ( ! flags.has('--all') && ! flags.has('--report') && fs.existsSync(baseFile) ) {
  try { listed = JSON.parse(fs.readFileSync(baseFile, 'utf8')).problems || {}; hasBase = true; }
  catch (e) { stop(`${baseFile} is not valid JSON: ${e.message}`); }
}
// A problem is new when there are more of its kind now than on the starting list.
const fresh = hasBase ? problems.filter(p => now[p.key] > (listed[p.key] || 0)) : problems;
const older = problems.length - fresh.length;
const fixed = Object.keys(listed).reduce((n, k) => n + Math.max(0, listed[k] - (now[k] || 0)), 0);

// ---------- output ----------
const byFile = list => { const m = new Map(); for ( const p of list ) { if ( ! m.has(p.file) ) m.set(p.file, []); m.get(p.file).push(p); } return m; };
const pad = '      ';
const ONE = { 'failed FOAM assertions': 'failed FOAM assertion', 'type errors': 'type error' };
for ( const r of Object.values(RULES) ) ONE[r.group] = r.one;
const named = (n, group) => `${n} ${n === 1 ? ONE[group] : group}`;
// One file: type errors and FOAM assertions one by one, style problems grouped by rule.
const showFile = ps => {
  const out = [];
  for ( const p of ps.filter(p => p.kind !== 'style').sort((a, b) => a.line - b.line) )
    out.push(`  ${p.line ? `line ${p.line}: ` : ''}${red(p.title)}` + (p.detail ? '\n' + p.detail.split('\n').map(d => pad + d).join('\n') : ''));
  const rules = new Map();
  for ( const p of ps.filter(p => p.kind === 'style') ) { if ( ! rules.has(p.group) ) rules.set(p.group, []); rules.get(p.group).push(p); }
  for ( const [group, list] of rules )
    out.push(`  ${red(named(list.length, group))}: ${list.map(p => p.member).join(', ')}\n${pad}Fix: ${list[0].fix}`);
  return out.join('\n');
};
const show = list => [...byFile(list)].map(([file, ps]) => bold(file) + '\n' + showFile(ps)).join('\n\n');

if ( flags.has('--report') ) {
  const all = [];
  const walk = d => { for ( const e of fs.readdirSync(d, { withFileTypes: true }) ) { const f = path.join(d, e.name); if ( e.isDirectory() ) walk(f); else if ( e.name.endsWith('.js') ) all.push(relApp(f)); } };
  dirs.filter(d => fs.existsSync(d)).forEach(walk);
  const files = byFile(problems), groups = count(problems.map(p => ({ key: p.group })));
  const clean = all.filter(f => ! files.has(f)).length;
  const out = [bold(`FTypechecks conversion report: ${cfg.package}`), ''];
  const row = (label, n) => out.push(`  ${String(n).padStart(5)}  ${label}`);
  row('files checked', all.length);
  row('files with 0 problems', clean);
  row('files to convert', all.length - clean);
  row('problems in total', problems.length);
  if ( problems.length ) {
    out.push('', bold('By kind'));
    for ( const g of Object.keys(groups).sort((a, b) => groups[b] - groups[a]) ) row(groups[g] === 1 ? ONE[g] : g, groups[g]);
    out.push('', bold('By file') + dim('  (most problems first)'));
    for ( const [file, ps] of [...files].sort((a, b) => b[1].length - a[1].length) ) {
      const g = count(ps.map(p => ({ key: p.group })));
      out.push('', `${bold(file)}  ${dim('—')} ${plural(ps.length, 'problem')}`);
      for ( const k of Object.keys(g).sort((a, b) => g[b] - g[a]) ) row(g[k] === 1 ? ONE[k] : k, g[k]);
    }
    out.push('', 'To see every problem with its line: run with --all', 'To accept these and fail only on new ones: run with --baseline');
  } else out.push('', green('Every checked file follows the rules.'));
  if ( fs.existsSync(baseFile) ) out.push('', `A starting list exists: ${baseFile}`);
  console.log(out.join('\n'));
  process.exit(0);
}

const notes = [];
if ( hasBase && older ) notes.push(`${plural(older, 'older problem')} on the starting list ${older === 1 ? 'is' : 'are'} not shown. See them with --all.`);
if ( hasBase && fixed ) notes.push(`${plural(fixed, 'problem')} from the starting list ${fixed === 1 ? 'is' : 'are'} fixed. Run --baseline to shrink the list.`);

if ( ! fresh.length ) {
  if ( hook ) process.exit(0);
  console.log(green(bold(`FTypechecks: 0 ${hasBase ? 'new ' : ''}problems`)) + ` (${cfg.package})` + (notes.length ? '\n' + notes.join('\n') : ''));
  process.exit(0);
}

const head = `FTypechecks: ${plural(fresh.length, hasBase ? 'new problem' : 'problem')} in ${plural(byFile(fresh).size, 'file')}`;
const text = [bold(head), '', show(fresh), ...(notes.length ? ['', ...notes] : [])].join('\n');
if ( hook ) { console.error(`You edited ${relApp(edited)}. Fix these before going on.\n${text}`); process.exit(2); }
console.log(text);
process.exit(1);
