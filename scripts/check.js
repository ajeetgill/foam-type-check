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
//   level    optional: "strict" (default) reports every type error in model files, also plain
//            JavaScript ones (isNaN(date), a variable reused with another type, a browser object
//            with no cast), each with a Fix line. "foam" reports only wrong FOAM names and types:
//            the mistakes that otherwise need a build and a test run to find.
//   hook     optional: what the hook checks after an edit. "file": only the edited file (fast).
//            "all": every source folder. Default: "all" up to 100 source files, "file" above that.
// The starting list is foam-check.baseline.json, next to the config file. Commit it.
// Generated files go to .foam-check/ next to the config file. Add that folder to .gitignore.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const T0 = Date.now();

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
  'DAO import does not say what it holds': { group: 'DAO imports with no "of"',       one: 'DAO import with no "of"',        fix: "Add of: '<class id>' to the import." },
  'undeclared field':                     { group: 'undeclared fields',              one: 'undeclared field',               fix: "The code sets this on a FOAM object, but the class does not declare it. Declare it in properties, for example { class: 'Boolean', name: 'x' }." }
};

// TypeScript error kinds that say something about FOAM code. The rest is plain JavaScript
// typing strictness (a variable reused with another type, arithmetic on a Date, ...).
const KEEP = new Set(['TS2339', 'TS2551', 'TS2353', 'TS2561', 'TS2554', 'TS2555', 'TS2345', 'TS2322', 'TS2304', 'TS2552']);
// A type that TypeScript made up from plain JavaScript: an object literal, a function, a union
// of those, a namespace. Not a FOAM class, and not a simple type (string, number) that a FOAM
// property or argument declares. '(...args: any[]) => any' is ours: an import of type Function.
const madeUp = t => t !== '(...args: any[]) => any' &&
  ( /^[{(\[]/.test(t) || / \| [{(]/.test(t) || /^typeof /.test(t) || /[})]\[\]$/.test(t) );
const MODEL = /foam\s*\.\s*(CLASS|ENUM|INTERFACE|RELATIONSHIP|SCRIPT|LIB)\s*\(/;

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
// Plain-JavaScript cleanups that level "strict" reports: how to fix each kind.
const CLEANUP = [
  [/^TS2345$/, /of type 'Date' is not assignable to parameter of type 'number'/, 'Pass a number: date.getTime(). For example isNaN(date.getTime()).'],
  [/^TS(2339|2551)$/, /on type '(Element|Node|EventTarget|Event|CSSRule|Document|Window|CSSStyleDeclaration)'/, "Say the real type with a JSDoc cast: /** @type {HTMLInputElement} */ (el), /** @type {CSSStyleRule} */ (rule), /** @type {KeyboardEvent} */ (e)."],
  [/^TS(2741|2739|2740)$/, /./, 'Give the object every key the other one has. Items in one list should all have the same keys.'],
  [/^TS2403$/, /./, 'Use a new variable name. One variable should keep one type.'],
  [/^TS(2362|2363|2365)$/, /./, 'Do arithmetic on numbers. For a date use date.getTime().'],
  [/^TS2322$/, /is not assignable to type '\(/, 'Use a new variable name. This variable held a function and now gets a value.'],
  [/^TS2538$/, /./, 'Use a string or a number as the key.'],
  [/^TS2810$/, /./, 'Write: /** @type {Promise<void>} */ (new Promise(...)), or call resolve with a value.']
];
const cleanupFix = (code, msg) => { const c = CLEANUP.find(c => c[0].test(code) && c[1].test(msg)); return c ? c[2] : undefined; };

const stop = text => { console.error(hook ? `FTypechecks could not run after editing ${edited}.\n${text}` : text); process.exit(hook ? 2 : 1); };

let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { stop(`${cfgFile} is not valid JSON: ${e.message}`); }
if ( typeof cfg.package !== 'string' || ! Array.isArray(cfg.sources) || ! cfg.sources.length )
  stop(`${cfgFile} needs "package" (a string) and "sources" (a list of folders).`);

const level = cfg.level || 'strict';
if ( level !== 'strict' && level !== 'foam' ) stop(`"level" in ${cfgFile} must be "strict" or "foam".`);
const base = path.dirname(cfgFile);
const app  = path.resolve(base, cfg.app || '.');
const dirs = cfg.sources.map(s => path.resolve(app, s));
const inSources = f => dirs.some(d => f.startsWith(d + path.sep));
// In hook mode only model files inside the checked folders matter.
if ( hook && ! inSources(edited) ) process.exit(0);

for ( const need of ['foam3/src/foam_node.js', 'pom.js'] )
  if ( ! fs.existsSync(path.join(app, need)) ) stop(`${path.join(app, need)} not found. Check "app" in ${cfgFile}.`);

// Every .js file in the checked folders.
const sourceFiles = [];
const walk = d => { for ( const e of fs.readdirSync(d, { withFileTypes: true }) ) { const f = path.join(d, e.name); if ( e.isDirectory() ) walk(f); else if ( e.name.endsWith('.js') ) sourceFiles.push(f); } };
dirs.filter(d => fs.existsSync(d)).forEach(walk);
// After an edit, a big app checks only the edited file: the full check is too slow to run on every edit.
if ( cfg.hook && cfg.hook !== 'file' && cfg.hook !== 'all' ) stop(`"hook" in ${cfgFile} must be "file" or "all".`);
const oneFile = hook && (cfg.hook || (sourceFiles.length > 100 ? 'file' : 'all')) === 'file';

const work = path.join(base, '.foam-check');
fs.mkdirSync(work, { recursive: true });
const relApp = f => f ? path.relative(app, path.resolve(app, f)).split(path.sep).join('/') : '(no file)';

// ---------- 1. types from the live models, plus the style report ----------
const reportFile = path.join(work, 'report.json');
const generator = path.join(__dirname, 'gen-types.js');
// For a FOAM LSP that has the app loaded: which generator, package and level to use.
const genInfo = JSON.stringify({ generator, app, style: cfg.package, level }, null, 1);
const genInfoFile = path.join(work, 'generator.json');
if ( (() => { try { return fs.readFileSync(genInfoFile, 'utf8'); } catch (e) { return ''; } })() !== genInfo ) fs.writeFileSync(genInfoFile, genInfo);

// EXPERIMENT. A FOAM LSP that already has the app loaded writes app.d.ts after each
// edit (lsp.json says which file versions it saw). In hook mode use it, waiting a
// little for it if it is running; otherwise load FOAM here (4-5 s on a big app).
const fromLsp = (() => {
  if ( ! hook || process.env.FTYPECHECKS_NO_LSP ) return false;
  const lspFile = path.join(work, 'lsp.json');
  let mtime; try { mtime = fs.statSync(edited).mtimeMs; } catch (e) { return false; }
  const ready = () => {
    let l; try { l = JSON.parse(fs.readFileSync(lspFile, 'utf8')); } catch (e) { return false; }
    if ( l.generator !== generator || l.level !== level ) return false;
    try { process.kill(l.pid, 0); } catch (e) { return false; }      // that LSP is gone
    return l.seen && l.seen[edited] === mtime ? true : null;          // null: not yet
  };
  const wait = cfg.lspWait != null ? cfg.lspWait : 4000;
  for ( const until = Date.now() + wait; ; ) {
    const r = ready();
    if ( r !== null ) return r;
    if ( Date.now() >= until ) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
})();
if ( ! fromLsp ) {
  try { fs.unlinkSync(reportFile); } catch (e) {}
  const gen = spawnSync(process.execPath, [generator], {
    cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FOAM_APP: app, FOAM_DTS_OUT: path.join(work, 'app.d.ts'), FOAM_STYLE: cfg.package, FOAM_REPORT: reportFile, FOAM_LEVEL: level }
  });
  if ( gen.status !== 0 || ! fs.existsSync(reportFile) )
    stop('The models did not load. Last lines:\n' + ((gen.stdout || '') + (gen.stderr || '')).trim().split('\n').slice(-25).join('\n'));
}
if ( process.env.FTYPECHECKS_TIMES ) console.error(`types ${fromLsp ? 'from the LSP' : 'from a FOAM load'}: ${Date.now() - T0} ms`);
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
const tsconfig = oneFile ? 'tsconfig.hook.json' : 'tsconfig.json';
fs.writeFileSync(path.join(work, tsconfig), JSON.stringify({
  compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: false, target: 'es2022', lib: ['es2022', 'dom'], types: [], skipLibCheck: true },
  ...(oneFile ? { files: ['app.d.ts', rel(edited)] } : { include: ['app.d.ts', ...dirs.map(d => rel(d) + '/**/*.js')] })
}, null, 2) + '\n');

// TypeScript: the config's "tsc", then the app's own install, then the plugin's.
const bin = d => path.join(d, 'node_modules', '.bin', 'tsc');
const tscPath = [
  cfg.tsc && path.resolve(base, cfg.tsc), bin(base), bin(app),
  process.env.CLAUDE_PLUGIN_DATA && bin(process.env.CLAUDE_PLUGIN_DATA), bin(path.dirname(__dirname))
].filter(Boolean).find(p => fs.existsSync(p));
if ( ! tscPath ) stop(`TypeScript not found. Run "npm install --save-dev typescript" in ${base}, or set "tsc" in ${cfgFile}.`);

const tsc = spawnSync(tscPath, ['-p', tsconfig, '--pretty', 'false'], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if ( tsc.error ) stop(`Could not run ${tscPath}: ${tsc.error.message}`);
if ( process.env.FTYPECHECKS_TIMES ) console.error(`TypeScript done: ${Date.now() - T0} ms`);
const texts = new Map();
const sourceText = f => { if ( ! texts.has(f) ) { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) {} texts.set(f, t); } return texts.get(f); };
let last = null;
for ( const l of ((tsc.stdout || '') + (tsc.stderr || '')).split('\n') ) {
  const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if ( m ) {
    const file = relApp(path.resolve(work, m[1]));
    // A plain script with no FOAM model in it (a Node runner, a helper) is not checked.
    if ( ! MODEL.test(sourceText(path.resolve(work, m[1]))) ) { last = null; continue; }
    if ( level === 'foam' ) {
      last = null;
      if ( ! KEEP.has(m[4]) ) continue;
      // Wrong type, where the wanted type was made up from plain JavaScript.
      const want = (m[4] === 'TS2345' || m[4] === 'TS2322') && m[5].match(/assignable to (?:parameter of )?type '(.*?)'\.?$/);
      if ( want && madeUp(want[1]) ) continue;
      const nm = (m[4] === 'TS2339' || m[4] === 'TS2551') && m[5].match(/does not exist on type '(.*?)'\./);
      if ( nm && madeUp(nm[1]) ) continue;
    }
    const un = (m[4] === 'TS2339' || m[4] === 'TS2551') && m[5].match(/^Property '([^']+)' does not exist on type '(.*?)'\./);
    if ( un ) {
      last = null;
      // A plain JavaScript object ({}) that gets fields added later. Not FOAM's business.
      if ( un[2] === '{}' ) continue;
      // The same file assigns this member (x.name = ...): a field that is used but never declared.
      // That is a style point, not a wrong name. One line per field, however often it is used.
      if ( new RegExp('\\.' + un[1].replace(/[$]/g, '\\$&') + '\\s*=(?!=)').test(sourceText(path.resolve(work, m[1]))) ) {
        const key = `field|${file}|${un[2]}.${un[1]}`;
        if ( ! problems.some(p => p.key === key) ) problems.push({
          file, line: 0, kind: 'style', title: `undeclared field ${un[1]}`, member: `${un[1]} (on ${un[2]})`,
          fix: RULES['undeclared field'].fix, group: RULES['undeclared field'].group, key
        });
        continue;
      }
    }
    last = { file, line: +m[2], kind: 'type', title: `${TS_LABEL[m[4]] || 'Type error'} (${m[4]})`, detail: m[5], fix: cleanupFix(m[4], m[5]), group: 'type errors', key: `type|${file}|${m[4]}|${m[5]}` };
    problems.push(last);
  } else if ( last && /^\s+\S/.test(l) ) last.detail += '\n' + l.trim();   // rest of a long message
  else if ( /error TS\d+/.test(l) ) problems.push(last = { file: '(TypeScript)', line: 0, kind: 'type', title: 'TypeScript could not run the check', detail: l.trim(), group: 'type errors', key: `type||${l.trim()}` });
}

// After an edit in "file" mode, only the edited file was type-checked: report only that file.
if ( oneFile ) { const mine = relApp(edited); for ( let i = problems.length - 1; i >= 0; i-- ) if ( problems[i].file !== mine ) problems.splice(i, 1); }

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
const fixed = oneFile ? 0 : Object.keys(listed).reduce((n, k) => n + Math.max(0, listed[k] - (now[k] || 0)), 0);

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
    out.push(`  ${p.line ? `line ${p.line}: ` : ''}${red(p.title)}` + (p.detail ? '\n' + p.detail.split('\n').map(d => pad + d).join('\n') : '') + (p.fix ? `\n${pad}Fix: ${p.fix}` : ''));
  const rules = new Map();
  for ( const p of ps.filter(p => p.kind === 'style') ) { if ( ! rules.has(p.group) ) rules.set(p.group, []); rules.get(p.group).push(p); }
  for ( const [group, list] of rules )
    out.push(`  ${red(named(list.length, group))}: ${list.map(p => p.member).join(', ')}\n${pad}Fix: ${list[0].fix}`);
  return out.join('\n');
};
const show = list => [...byFile(list)].map(([file, ps]) => bold(file) + '\n' + showFile(ps)).join('\n\n');

if ( flags.has('--report') ) {
  const all = sourceFiles.map(relApp);
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
if ( oneFile ) notes.push('Only the edited file was checked. Run the full check before you finish: node check.js');
if ( hasBase && older && ! oneFile ) notes.push(`${plural(older, 'older problem')} on the starting list ${older === 1 ? 'is' : 'are'} not shown. See them with --all.`);
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
