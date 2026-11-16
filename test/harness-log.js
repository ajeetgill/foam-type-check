#!/usr/bin/env node
/**
 * The Stop hook's harness log: one JSON line per run in <git common dir>/harness/events.jsonl,
 * only when that folder is there; a log it cannot write never changes the hook's exit code.
 * Builds a small app in a temp git repo (its foam3 is a link to a real foam3 checkout,
 * only read), then runs check.js --stop as Claude Code would.
 *
 *   node test/harness-log.js <foam3 folder>
 *
 * Writes only in the temp folder. Exit 0: every check passed. Exit 1: a check failed.
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const [foamArg] = process.argv.slice(2);
if ( ! foamArg || ! fs.existsSync(path.join(foamArg, 'src', 'foam_node.js')) ) {
  console.error('usage: node test/harness-log.js <foam3 folder>'); process.exit(2);
}
const check = path.join(__dirname, '..', 'scripts', 'check.js');
const app = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftypechecks-harness-log-')));
const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true }); fs.writeFileSync(path.join(app, f), text); };
const git = (...a) => spawnSync('git', a, { cwd: app, encoding: 'utf8' });
// A class with one property; bad = the property has no class (a style problem: the hook blocks).
const model = bad => `foam.CLASS({ package: 'com.t', name: 'A', properties: [ ${bad ? "{ name: 'a' }" : "{ class: 'String', name: 'a' }"} ] });\n`;

fs.symlinkSync(path.resolve(foamArg), path.join(app, 'foam3'));
write('pom.js', "foam.POM({ name: 't', excludes: ['*'], projects: [ { name: 'foam3/pom' }, { name: 'src/com/t/pom' } ] });\n");
write('src/com/t/pom.js', "foam.POM({ name: 't', files: [ { name: 'A', flags: 'js' } ] });\n");
write('foam-check.config.json', JSON.stringify({ package: 'com.t', sources: ['src/com/t'], tsc: false, journals: false, hook: 'batch' }));
write('.gitignore', 'foam3\n.foam-check\n');
write('src/com/t/A.js', model(false));
git('init', '-q', '-b', 'work');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start');
const harness = path.join(app, '.git', 'harness'), log = path.join(harness, 'events.jsonl');

// One end of turn: A.js was edited this turn (pending.json), then the Stop hook runs.
const stopRun = (extra = {}) => {
  write('.foam-check/pending.json', JSON.stringify([path.join(app, 'src/com/t/A.js')]));
  try { fs.unlinkSync(path.join(app, '.foam-check', 'stop-last.json')); } catch (e) {}
  const r = spawnSync(process.execPath, [check, '--stop'], { cwd: app, encoding: 'utf8',
    input: JSON.stringify({ cwd: app, session_id: 'sess-1', ...extra }),
    env: { ...process.env, FTYPECHECKS_NO_LSP: '1', NO_COLOR: '1', CLAUDE_SESSION_ID: 'from-env' } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

let failed = 0;
const expect = (what, ok, extra) => { console.log(`${ok ? 'pass' : 'FAIL'}: ${what}`); if ( ! ok ) { failed++; if ( extra ) console.log('  ' + String(extra).split('\n').join('\n  ')); } };

// No harness folder: nothing is created.
let r = stopRun();
expect('no harness folder: exit 0', r.status === 0, r.out);
expect('no harness folder: no folder, no file made', ! fs.existsSync(harness));

// The folder is there: a pass run writes one line.
fs.mkdirSync(harness);
r = stopRun();
let l = lines();
expect('pass run: exit 0, one line', r.status === 0 && l.length === 1, r.out + '\n' + JSON.stringify(l));
const e = l[0] || {};
expect('line has every key, in order', JSON.stringify(Object.keys(e)) === JSON.stringify(['ts', 'hook', 'result', 'worktree', 'branch', 'head', 'session', 'rules', 'detail']), JSON.stringify(e));
expect('ts is ISO with no milliseconds', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e.ts), e.ts);
expect('hook, result, worktree, branch, head', e.hook === 'ftypechecks' && e.result === 'pass' && e.worktree === path.basename(app) &&
  e.branch === 'work' && e.head === git('rev-parse', '--short', 'HEAD').stdout.trim(), JSON.stringify(e));
expect('session from the hook input', e.session === 'sess-1', e.session);
expect('pass: no rules, the file in detail', JSON.stringify(e.rules) === '{}' && /files: src\/com\/t\/A\.js/.test(e.detail), JSON.stringify(e));

// A blocked run: the rule counts and the finding.
write('src/com/t/A.js', model(true));
r = stopRun();
l = lines();
const b = l[1] || {};
expect('blocked run: exit 2, second line', r.status === 2 && l.length === 2, r.out);
expect('blocked: result and rules', b.result === 'blocked' && b.rules && b.rules['property has no class'] === 1, JSON.stringify(b));
expect('blocked: finding in detail', /src\/com\/t\/A\.js: .*a/.test(b.detail || '') && b.detail.length <= 2000, b.detail);

// Claude went on once and the problems are the same: not blocked, still logged.
r = stopRun();
const seen = fs.readFileSync(path.join(app, '.foam-check', 'stop-last.json'), 'utf8');
write('.foam-check/pending.json', JSON.stringify([path.join(app, 'src/com/t/A.js')]));
write('.foam-check/stop-last.json', seen);
const again = spawnSync(process.execPath, [check, '--stop'], { cwd: app, encoding: 'utf8', input: JSON.stringify({ cwd: app, session_id: 'sess-1', stop_hook_active: true }),
  env: { ...process.env, FTYPECHECKS_NO_LSP: '1', NO_COLOR: '1' } });
l = lines();
expect('let stop after one block: exit 0, logged as pass with its rules', again.status === 0 && l.length === 4 && l[3].result === 'pass' && l[3].rules['property has no class'] === 1, JSON.stringify(l[3]));

// Nothing edited this turn: nothing checked, nothing logged.
try { fs.unlinkSync(path.join(app, '.foam-check', 'pending.json')); } catch (x) {}
const idle = spawnSync(process.execPath, [check, '--stop'], { cwd: app, encoding: 'utf8', input: JSON.stringify({ cwd: app }), env: { ...process.env, FTYPECHECKS_NO_LSP: '1' } });
expect('nothing edited: exit 0, no line', idle.status === 0 && lines().length === 4);

// A log it cannot write: same exit code, no word about the log.
fs.chmodSync(log, 0o444);
r = stopRun();
expect('read-only log: blocked run still exits 2', r.status === 2, r.out);
expect('read-only log: nothing about the log in the output', ! /events\.jsonl|EACCES|harness/i.test(r.out), r.out);
write('src/com/t/A.js', model(false));
r = stopRun();
expect('read-only log: pass run still exits 0', r.status === 0, r.out);
fs.chmodSync(log, 0o644);
fs.unlinkSync(log); fs.mkdirSync(log);              // a folder where the file should be
r = stopRun();
expect('log path is a folder: pass run still exits 0', r.status === 0, r.out);

if ( ! process.env.KEEP ) fs.rmSync(app, { recursive: true, force: true });
console.log(failed ? `harness-log: ${failed} failed` : 'harness-log: all passed');
process.exit(failed ? 1 : 0);
