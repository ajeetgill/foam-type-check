#!/usr/bin/env node
// FTypechecks (FOAM Type-Checking): one command.
//
//   node check.js [app dir]             check; fails on problems (new ones only, if there is a starting list)
//   node check.js [app dir] --report    conversion report: what is left to convert, per file
//   node check.js [app dir] --baseline  write the starting list: accept today's problems, fail only on new ones
//   node check.js [app dir] --all       check and ignore the starting list
//   node check.js [app dir] --editor    write jsconfig.json in the app, so VS Code (and other editors
//                                       that use TypeScript) know the FOAM types while you type
//   node check.js --hook                Claude Code PostToolUse hook (reads the hook JSON on stdin)
//   node check.js --stop                Claude Code Stop hook: in "batch" mode, checks the files edited this turn
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
//            "batch": nothing after an edit; when Claude finishes its turn, every file edited
//            in that turn, in one run (the Stop hook).
//   journals optional: the folders whose .jrl files are checked, relative to the app folder.
//            Default: every .jrl file in git (git ls-files), else the sources and journals/.
//            false: do not check journals.
//   lspWait  optional: how long the hook waits for a FOAM LSP's types file, in ms. Default 4000.
// A file can set its own level in its first lines, like Sorbet's sigils:
//   // ftypechecks: off      not checked at all
//   // ftypechecks: foam     level "foam" for this file
//   // ftypechecks: strict   level "strict" for this file
// The starting list is foam-check.baseline.json, next to the config file. Commit it.
// Generated files go to .foam-check/ next to the config file. Add that folder to .gitignore.
//
// How it runs:
//   1. settings    read the config once, into one object with every default filled in
//   2. types       the first type provider that can answer writes app.d.ts and report.json
//   3. problems    every problem source turns its findings into problems (rules.js names them)
//   4. scope       keep the target files' problems (the edited file, or this turn's files), then the new ones
//   5. output      the mode prints: check, --report or --baseline
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const { RULES, TS, cleanupFix } = require('./rules');
const T0 = Date.now();
const time = what => { if ( process.env.FTYPECHECKS_TIMES ) console.error(`${what}: ${Date.now() - T0} ms`); };

const CONFIG = 'foam-check.config.json', BASELINE = 'foam-check.baseline.json';
const OPTIONS = ['--hook', '--stop', '--report', '--baseline', '--all', '--editor'];
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
for ( const f of flags ) if ( ! OPTIONS.includes(f) ) { console.error(`Unknown option ${f}. Options: ${OPTIONS.join(' ')}`); process.exit(1); }
const hook = flags.has('--hook'), stopHook = flags.has('--stop');
const asHook = hook || stopHook;          // run by Claude Code: talk on stderr, exit 2 on problems

// ---------- plain-language text ----------
const color = ! asHook && process.stdout.isTTY && ! process.env.NO_COLOR;
const paint = (code, s) => color ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = s => paint(1, s), red = s => paint(31, s), dim = s => paint(2, s), green = s => paint(32, s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const ONE = Object.fromEntries(Object.values(RULES).map(r => [r.group, r.one]));   // group name -> name of one
const named = (n, group) => `${n} ${n === 1 ? ONE[group] : group}`;

// ---------- small file helpers ----------
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const filesUnder = (d, ext, skip = () => false) => {
  const out = [];
  const walk = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for ( const e of es ) { const f = path.join(d, e.name); if ( e.isDirectory() ) { if ( ! skip(e.name) ) walk(f); } else if ( e.name.endsWith(ext) ) out.push(f); } };
  walk(d);
  return out;
};
const findUp = (from, name) => {
  for ( let d = path.resolve(from); ; d = path.dirname(d) ) {
    if ( fs.existsSync(path.join(d, name)) ) return path.join(d, name);
    if ( d === path.dirname(d) ) return null;
  }
};

// ---------- 1. settings ----------
let input = {}, edited = '';
if ( asHook ) try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) {}
if ( hook ) {
  edited = (input.tool_input && input.tool_input.file_path) || (input.tool_response && input.tool_response.filePath) || '';
  if ( ! /\.(js|jrl)$/.test(edited) ) process.exit(0);
  edited = path.resolve(edited);
}

// A failure of the tool itself (not a problem in the code).
const stop = text => {
  console.error(hook ? `FTypechecks could not run after editing ${edited}.\n${text}` : stopHook ? `FTypechecks could not run the end-of-turn check.\n${text}` : text);
  process.exit(asHook ? 2 : 1);
};

function settings() {
  const start = hook ? path.dirname(edited) : stopHook ? (input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()) :
    (process.argv.slice(2).find(a => ! a.startsWith('--')) || process.cwd());
  const file = findUp(start, CONFIG) || (asHook && process.env.CLAUDE_PROJECT_DIR && findUp(process.env.CLAUDE_PROJECT_DIR, CONFIG));
  if ( ! file ) {
    if ( asHook ) process.exit(0);        // not a project that uses this check
    stop(`No ${CONFIG} found in ${path.resolve(start)} or above it.`);
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { stop(`${file} is not valid JSON: ${e.message}`); }
  if ( typeof c.package !== 'string' || ! Array.isArray(c.sources) || ! c.sources.length )
    stop(`${file} needs "package" (a string) and "sources" (a list of folders).`);
  const level = c.level || 'strict';
  if ( level !== 'strict' && level !== 'foam' ) stop(`"level" in ${file} must be "strict" or "foam".`);
  if ( c.hook && ! ['file', 'all', 'batch'].includes(c.hook) ) stop(`"hook" in ${file} must be "file", "all" or "batch".`);

  const base = path.dirname(file), app = path.resolve(base, c.app || '.');
  const dirs = c.sources.map(s => path.resolve(app, s));
  return {
    file, base, app, dirs, level, package: c.package, hook: c.hook, tsc: c.tsc,
    lspWait: c.lspWait != null ? c.lspWait : 4000,
    work: path.join(base, '.foam-check'),
    journals: journalsOf(c.journals, app, dirs)
  };
}

// The journals (.jrl) to check: the configured folders, else every .jrl in git,
// else the sources and journals/.
function journalsOf(setting, app, dirs) {
  const jrl = d => filesUnder(d, '.jrl', n => n === 'node_modules' || n[0] === '.');
  if ( setting === false ) return [];
  if ( Array.isArray(setting) ) return setting.flatMap(d => jrl(path.resolve(app, d)));
  const git = spawnSync('git', ['ls-files', '-z', '*.jrl'], { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = git.status === 0 ? git.stdout.split('\0').filter(Boolean).map(f => path.join(app, f)) : [];
  return tracked.length ? tracked : [...dirs, path.join(app, 'journals')].flatMap(jrl);
}

const cfg = settings();
const inSources = f => cfg.dirs.some(d => f.startsWith(d + path.sep));
const checked = f => f.endsWith('.jrl') ? cfg.journals.includes(f) : inSources(f);
fs.mkdirSync(cfg.work, { recursive: true });
const relApp = f => f ? path.relative(cfg.app, path.resolve(cfg.app, f)).split(path.sep).join('/') : '(no file)';
const inWork = name => path.join(cfg.work, name);

// Batch mode: the files edited this turn wait in pending.json for the Stop hook.
const PENDING = inWork('pending.json');
const readPending = () => { try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')).filter(f => fs.existsSync(f)); } catch (e) { return []; } };
// In hook mode only model files inside the checked folders, and the checked journals, matter.
if ( hook && ! checked(edited) ) process.exit(0);
if ( hook && cfg.hook === 'batch' ) {
  fs.writeFileSync(PENDING, JSON.stringify([...new Set([...readPending(), edited])], null, 1));
  process.exit(0);
}
const pending = stopHook ? readPending().filter(checked) : [];
if ( stopHook && ! pending.length ) process.exit(0);    // nothing edited, or not batch mode
for ( const need of ['foam3/src/foam_node.js', 'pom.js'] )
  if ( ! fs.existsSync(path.join(cfg.app, need)) ) stop(`${path.join(cfg.app, need)} not found. Check "app" in ${cfg.file}.`);

const sourceFiles = cfg.dirs.flatMap(d => filesUnder(d, '.js'));
// The files to check, or null for all of them. After an edit a big app checks only the
// edited file (the full check is too slow for every edit); a journal edit checks that
// journal; the Stop hook checks the files edited this turn.
const targets = stopHook ? pending :
  hook && ( edited.endsWith('.jrl') || (cfg.hook || (sourceFiles.length > 100 ? 'file' : 'all')) === 'file' ) ? [edited] : null;
const targetJs = targets && targets.filter(f => f.endsWith('.js'));

// ---------- 2. types: app.d.ts and report.json, from the live models ----------
const generator = path.join(__dirname, 'gen-types.js');
fs.writeFileSync(inWork('journals.json'), JSON.stringify(targets ? targets.filter(f => f.endsWith('.jrl')) : cfg.journals));
fs.writeFileSync(inWork('journals-all.json'), JSON.stringify(cfg.journals));
// For a FOAM LSP that has the app loaded: which generator, package, level and journals to use.
const genInfo = JSON.stringify({ generator, app: cfg.app, style: cfg.package, level: cfg.level, journals: inWork('journals-all.json') }, null, 1);
if ( readText(inWork('generator.json')) !== genInfo ) fs.writeFileSync(inWork('generator.json'), genInfo);

// Each provider returns true when app.d.ts and report.json are ready, false to pass.
// The fast one goes first; the last one always works.
const PROVIDERS = [
  {
    // EXPERIMENT. A FOAM LSP that already has the app loaded writes the files after each
    // edit; lsp.json says which file versions it saw. Waits a little for it.
    name: 'the LSP',
    get() {
      // The files whose current version the LSP must have seen.
      const files = targets || (hook ? [edited] : null);
      if ( ! files || files.some(f => ! f.endsWith('.js')) || process.env.FTYPECHECKS_NO_LSP ) return false;
      let mtimes; try { mtimes = files.map(f => fs.statSync(f).mtimeMs); } catch (e) { return false; }
      const ready = () => {
        let l; try { l = JSON.parse(fs.readFileSync(inWork('lsp.json'), 'utf8')); } catch (e) { return false; }
        if ( l.generator !== generator || l.level !== cfg.level ) return false;
        try { process.kill(l.pid, 0); } catch (e) { return false; }      // that LSP is gone
        return l.seen && files.every((f, i) => l.seen[f] === mtimes[i]) ? true : null;   // null: not yet
      };
      for ( const until = Date.now() + cfg.lspWait; ; ) {
        const r = ready();
        if ( r !== null ) return r;
        if ( Date.now() >= until ) return false;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  },
  {
    name: 'a FOAM load',
    get() {
      try { fs.unlinkSync(inWork('report.json')); } catch (e) {}
      const gen = spawnSync(process.execPath, [generator], {
        cwd: cfg.work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, FOAM_APP: cfg.app, FOAM_DTS_OUT: inWork('app.d.ts'), FOAM_STYLE: cfg.package,
               FOAM_REPORT: inWork('report.json'), FOAM_LEVEL: cfg.level, FOAM_JOURNALS: inWork('journals.json') }
      });
      if ( gen.status !== 0 || ! fs.existsSync(inWork('report.json')) )
        stop('The models did not load. Last lines:\n' + ((gen.stdout || '') + (gen.stderr || '')).trim().split('\n').slice(-25).join('\n'));
      return true;
    }
  }
];
const provider = PROVIDERS.find(p => p.get());
time(`types from ${provider.name}`);
const report = JSON.parse(fs.readFileSync(inWork('report.json'), 'utf8'));

// When a class in a target file changed shape (a property, a method signature, a rename),
// the files that use it may break: check them too. A change inside a method body does not
// change the shape, so it adds nothing. Shapes are compared with the last run's.
const MAX_USERS = 40;
const shapes = Object.fromEntries(Object.entries(report.shapes || {}).map(([id, s]) => [id, { ...s, file: path.resolve(cfg.app, s.file) }]));
let users = [], moreUsers = 0;
if ( targetJs && targetJs.length ) {
  let before = null; try { before = JSON.parse(fs.readFileSync(inWork('shapes-seen.json'), 'utf8')); } catch (e) {}
  if ( before ) {
    const changed = Object.keys(before).filter(id => targetJs.includes(before[id].file) && ( ! shapes[id] || shapes[id].hash !== before[id].hash ));
    // The whole id, not the start of a longer one (com.x.Chip, not com.x.ChipGroup).
    const uses = changed.map(id => new RegExp(id.replace(/[.$]/g, '\\$&') + '(?![\\w$])'));
    const all = uses.length ? sourceFiles.filter(f => ! targets.includes(f) && uses.some(re => re.test(readText(f)))) : [];
    users = all.slice(0, MAX_USERS); moreUsers = all.length - users.length;
  }
}
fs.writeFileSync(inWork('shapes-seen.json'), JSON.stringify(shapes));
// What TypeScript checks and what is reported: the targets and their users, or everything.
const scope = targets && [...targets, ...users];

// ---------- 3. problems ----------
// Every problem: { rule, file, line, title, detail, fix, member, key }. The rule (rules.js)
// gives its group and, unless the problem says otherwise, its title and fix.
// "key" has no line number, so the starting list survives edits above a problem.
const problem = (rule, p) => {
  const r = RULES[rule];
  if ( ! r ) throw new Error(`FTypechecks: no rule "${rule}" in rules.js`);
  return { rule, line: 0, title: r.title, fix: r.fix, ...p, kind: r.kind, group: r.group };
};

// Each source turns one kind of finding into problems.
const SOURCES = [
  // FOAM rejected a model while loading it (gen-types.js).
  () => report.asserts.map(a => problem('foam assertion', {
    file: relApp(a.file), title: `${a.where.split('.').pop()}: FOAM rejected this while loading`,
    detail: a.message, key: `foam|${a.where}|${a.message}`
  })),
  // Style rules on the live classes (gen-types.js).
  () => report.style.map(s => problem(s.rule, {
    file: relApp(s.file), member: s.member, key: `style|${s.cls}.${s.member}|${s.rule}`
  })),
  // Journal rows (journals.js).
  () => (report.journal || []).map(j => problem(j.rule, {
    file: relApp(j.file), line: j.line, detail: j.detail, key: `journal|${relApp(j.file)}|${j.rule}|${j.key}`
  })),
  // The type check (TypeScript), when there is a .js file to check.
  () => targetJs && ! targetJs.length ? [] : typeProblems()
];

// TypeScript output -> problems.
const MODEL = /foam\s*\.\s*(CLASS|ENUM|INTERFACE|RELATIONSHIP|SCRIPT|LIB)\s*\(/;
// A type that TypeScript made up from plain JavaScript: an object literal, a function, a union
// of those, a namespace. Not a FOAM class, and not a simple type (string, number) that a FOAM
// property or argument declares. '(...args: any[]) => any' is ours: an import of type Function.
const madeUp = t => t !== '(...args: any[]) => any' &&
  ( /^[{(\[]/.test(t) || / \| [{(]/.test(t) || /^typeof /.test(t) || /[})]\[\]$/.test(t) );

function typeProblems() {
  const rel = p => path.relative(cfg.work, p).split(path.sep).join('/');
  const tsconfig = targets ? 'tsconfig.hook.json' : 'tsconfig.json';
  fs.writeFileSync(inWork(tsconfig), JSON.stringify({
    compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: false, target: 'es2022', lib: ['es2022', 'dom'], types: [], skipLibCheck: true },
    ...(scope ? { files: ['app.d.ts', ...scope.filter(f => f.endsWith('.js')).map(rel)] } : { include: ['app.d.ts', ...cfg.dirs.map(d => rel(d) + '/**/*.js')] })
  }, null, 2) + '\n');

  // TypeScript: the config's "tsc", then the app's own install, then the plugin's.
  const bin = d => path.join(d, 'node_modules', '.bin', 'tsc');
  const tscPath = [
    cfg.tsc && path.resolve(cfg.base, cfg.tsc), bin(cfg.base), bin(cfg.app),
    process.env.CLAUDE_PLUGIN_DATA && bin(process.env.CLAUDE_PLUGIN_DATA), bin(path.dirname(__dirname))
  ].filter(Boolean).find(p => fs.existsSync(p));
  if ( ! tscPath ) stop(`TypeScript not found. Run "npm install --save-dev typescript" in ${cfg.base}, or set "tsc" in ${cfg.file}.`);
  const tsc = spawnSync(tscPath, ['-p', tsconfig, '--pretty', 'false'], { cwd: cfg.work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if ( tsc.error ) stop(`Could not run ${tscPath}: ${tsc.error.message}`);
  time('TypeScript done');

  const texts = new Map();
  const sourceText = f => { if ( ! texts.has(f) ) texts.set(f, readText(f)); return texts.get(f); };
  const out = [];
  let last = null;
  for ( const l of ((tsc.stdout || '') + (tsc.stderr || '')).split('\n') ) {
    const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if ( ! m ) {
      if ( last && /^\s+\S/.test(l) ) last.detail += '\n' + l.trim();   // rest of a long message
      else if ( /error TS\d+/.test(l) ) out.push(last = problem('type error', { file: '(TypeScript)', title: 'TypeScript could not run the check', detail: l.trim(), key: `type||${l.trim()}` }));
      continue;
    }
    last = null;
    const [, where, line, /* column */, code, msg] = m, abs = path.resolve(cfg.work, where), file = relApp(abs);
    // A plain script with no FOAM model in it (a Node runner, a helper) is not checked.
    if ( ! MODEL.test(sourceText(abs)) ) continue;
    if ( levelOf(abs) === 'foam' ) {
      if ( ! TS[code] ) continue;
      // Wrong type, where the wanted type was made up from plain JavaScript.
      const want = (code === 'TS2345' || code === 'TS2322') && msg.match(/assignable to (?:parameter of )?type '(.*?)'\.?$/);
      if ( want && madeUp(want[1]) ) continue;
      const nm = (code === 'TS2339' || code === 'TS2551') && msg.match(/does not exist on type '(.*?)'\./);
      if ( nm && madeUp(nm[1]) ) continue;
    }
    const un = (code === 'TS2339' || code === 'TS2551') && msg.match(/^Property '([^']+)' does not exist on type '(.*?)'\./);
    if ( un ) {
      // A plain JavaScript object ({}) that gets fields added later. Not FOAM's business.
      if ( un[2] === '{}' ) continue;
      // The same file assigns this member (x.name = ...): a field that is used but never declared.
      // That is a style point, not a wrong name. One line per field, however often it is used.
      if ( new RegExp('\\.' + un[1].replace(/[$]/g, '\\$&') + '\\s*=(?!=)').test(sourceText(abs)) ) {
        const key = `field|${file}|${un[2]}.${un[1]}`;
        if ( ! out.some(p => p.key === key) ) out.push(problem('undeclared field', { file, member: `${un[1]} (on ${un[2]})`, key }));
        continue;
      }
    }
    out.push(last = problem('type error', { file, line: +line, title: `${TS[code] || 'Type error'} (${code})`, detail: msg, fix: cleanupFix(code, msg), key: `type|${file}|${code}|${msg}` }));
  }
  return out;
}

// A file's own level, from a marker in its first lines; else the config's.
const LEVELS = new Map();
function levelOf(file) {
  if ( ! LEVELS.has(file) ) {
    const m = readText(file).slice(0, 2000).match(/^[ \t]*\/\/[ \t]*ftypechecks:[ \t]*(off|foam|strict)\b/m);
    LEVELS.set(file, m ? m[1] : cfg.level);
  }
  return LEVELS.get(file);
}

let problems = SOURCES.flatMap(source => source())
  .filter(p => levelOf(path.resolve(cfg.app, p.file)) !== 'off');

// ---------- 4. scope ----------
// Only the target files and their users were checked: report only those.
if ( scope ) { const mine = new Set(scope.map(relApp)); problems = problems.filter(p => mine.has(p.file)); }

// Each run remembers the problems of the files it checked (seen.json). A user file shows
// only what is new since then: its old problems are not caused by this edit. A user file
// never checked before shows only its type errors.
let seenBefore = {}; try { seenBefore = JSON.parse(fs.readFileSync(inWork('seen.json'), 'utf8')); } catch (e) {}
const seenNow = Object.assign({}, seenBefore);
for ( const f of (scope || [...sourceFiles, ...cfg.journals]).map(relApp) ) seenNow[f] = [];
for ( const p of problems ) if ( seenNow[p.file] ) seenNow[p.file].push(p.key);
fs.writeFileSync(inWork('seen.json'), JSON.stringify(seenNow));
if ( users.length ) {
  const isUser = new Set(users.map(relApp));
  problems = problems.filter(p => ! isUser.has(p.file) ||
    ( seenBefore[p.file] ? ! seenBefore[p.file].includes(p.key) : p.rule === 'type error' ));
}

const count = list => list.reduce((m, p) => (m[p.key] = (m[p.key] || 0) + 1, m), {});
const baseFile = path.join(cfg.base, BASELINE);
const now = count(problems);
let listed = {}, hasBase = false;
if ( ! flags.has('--all') && ! flags.has('--report') && ! flags.has('--baseline') && fs.existsSync(baseFile) ) {
  try { listed = JSON.parse(fs.readFileSync(baseFile, 'utf8')).problems || {}; hasBase = true; }
  catch (e) { stop(`${baseFile} is not valid JSON: ${e.message}`); }
}
// A problem is new when there are more of its kind now than on the starting list.
const fresh = hasBase ? problems.filter(p => now[p.key] > (listed[p.key] || 0)) : problems;
const older = problems.length - fresh.length;
const fixed = targets ? 0 : Object.keys(listed).reduce((n, k) => n + Math.max(0, listed[k] - (now[k] || 0)), 0);

// ---------- 5. output ----------
const byFile = list => { const m = new Map(); for ( const p of list ) { if ( ! m.has(p.file) ) m.set(p.file, []); m.get(p.file).push(p); } return m; };
const pad = '      ';
// One file: line problems one by one, style problems grouped by rule.
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

const MODES = {
  // Editors read jsconfig.json in the app folder. Types for autocomplete and hover everywhere;
  // red underlines in the files that start with // @ts-check. app.d.ts is rewritten by every
  // check (and by a FOAM LSP after every save), so the editor stays current.
  editor() {
    const jsconfig = path.join(cfg.app, 'jsconfig.json');
    const fromApp = p => path.relative(cfg.app, p).split(path.sep).join('/');
    const want = {
      compilerOptions: { checkJs: false, strict: false, target: 'es2022', lib: ['es2022', 'dom'], types: [] },
      include: [fromApp(inWork('app.d.ts')), ...cfg.dirs.map(d => fromApp(d) + '/**/*.js')]
    };
    const text = JSON.stringify(want, null, 2) + '\n';
    if ( fs.existsSync(jsconfig) && readText(jsconfig) !== text ) {
      console.log(`${jsconfig} exists, so it was not changed. Add this to its "include" list:\n  "${want.include[0]}"`);
      process.exit(0);
    }
    fs.writeFileSync(jsconfig, text);
    console.log(`${bold('Wrote')} ${jsconfig}\n` +
      `Editors now know the FOAM types: autocomplete and hover in every model file.\n` +
      `Red underlines: put // @ts-check on the first line of a file.\n` +
      `The types come from ${fromApp(inWork('app.d.ts'))}: every check rewrites it. Add .foam-check to .gitignore.`);
    process.exit(0);
  },

  baseline() {
    const sorted = Object.fromEntries(Object.keys(now).sort().map(k => [k, now[k]]));
    fs.writeFileSync(baseFile, JSON.stringify({ version: 1, package: cfg.package, total: problems.length, problems: sorted }, null, 2) + '\n');
    console.log(`${bold('Starting list written')}: ${plural(problems.length, 'problem')} accepted.\n` +
      `File: ${baseFile}\n` +
      `From now on the check fails only on new problems.\n` +
      `Commit this file. Run --baseline again after you convert code, to shrink the list.`);
    process.exit(0);
  },

  report() {
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
  },

  check() {
    const notes = [];
    if ( users.length ) notes.push(`Also checked ${plural(users.length, 'file')} that use${users.length === 1 ? 's' : ''} a class whose shape changed: ` +
      users.slice(0, 5).map(f => path.basename(f)).join(', ') + (users.length > 5 ? ', ...' : '') +
      (moreUsers ? `. ${moreUsers} more not checked: run the full check.` : ''));
    if ( targets ) notes.push(`Only ${targets.length === 1 ? 'the edited file was' : `the ${targets.length} edited files were`} checked. Run the full check before you finish: node check.js`);
    if ( hasBase && older && ! targets ) notes.push(`${plural(older, 'older problem')} on the starting list ${older === 1 ? 'is' : 'are'} not shown. See them with --all.`);
    if ( hasBase && fixed ) notes.push(`${plural(fixed, 'problem')} from the starting list ${fixed === 1 ? 'is' : 'are'} fixed. Run --baseline to shrink the list.`);
    if ( ! fresh.length ) {
      if ( stopHook ) { try { fs.unlinkSync(PENDING); fs.unlinkSync(inWork('stop-last.json')); } catch (e) {} }
      if ( asHook ) process.exit(0);
      console.log(green(bold(`FTypechecks: 0 ${hasBase ? 'new ' : ''}problems`)) + ` (${cfg.package})` + (notes.length ? '\n' + notes.join('\n') : ''));
      process.exit(0);
    }
    const head = `FTypechecks: ${plural(fresh.length, hasBase ? 'new problem' : 'problem')} in ${plural(byFile(fresh).size, 'file')}`;
    const text = [bold(head), '', show(fresh), ...(notes.length ? ['', ...notes] : [])].join('\n');
    if ( hook ) { console.error(`You edited ${relApp(edited)}. Fix these before going on.\n${text}`); process.exit(2); }
    if ( stopHook ) {
      // Claude already went on once because of this check, and the problems are the same:
      // let it stop, so the turn cannot loop. The files stay on the list for next time.
      const seen = fresh.map(p => p.key).sort().join('\n');
      if ( input.stop_hook_active && readText(inWork('stop-last.json')) === seen ) process.exit(0);
      fs.writeFileSync(inWork('stop-last.json'), seen);
      console.error(`You edited ${plural(targets.length, 'file')} this turn. Fix these before you finish.\n${text}`);
      process.exit(2);
    }
    console.log(text);
    process.exit(1);
  }
};
MODES[flags.has('--editor') ? 'editor' : flags.has('--baseline') ? 'baseline' : flags.has('--report') ? 'report' : 'check']();
