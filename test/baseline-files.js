#!/usr/bin/env node
/**
 * --baseline-files: it may only shrink the starting list, and only for the files it is given.
 * Builds a small app in a temp folder (its foam3 is a link to a real foam3 checkout,
 * only read), writes a starting list, changes the files, then checks what the mode kept.
 *
 *   node test/baseline-files.js <foam3 folder>
 *
 * Writes only in the temp folder. Exit 0: every check passed. Exit 1: a check failed.
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const [foamArg] = process.argv.slice(2);
if ( ! foamArg || ! fs.existsSync(path.join(foamArg, 'src', 'foam_node.js')) ) {
  console.error('usage: node test/baseline-files.js <foam3 folder>'); process.exit(2);
}
const check = path.join(__dirname, '..', 'scripts', 'check.js');
// The real path: FOAM names the files by it (on macOS /var is a link to /private/var).
const app = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftypechecks-baseline-files-')));
const src = path.join(app, 'src', 'com', 't');
const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true }); fs.writeFileSync(path.join(app, f), text); };
// A class with properties; a name in `bad` has no class (a style problem).
const model = (name, props, bad) => `foam.CLASS({
  package: 'com.t',
  name: '${name}',
  properties: [
${props.map(p => bad.includes(p) ? `    { name: '${p}' }` : `    { class: 'String', name: '${p}' }`).join(',\n')}
  ]
});
`;

fs.symlinkSync(path.resolve(foamArg), path.join(app, 'foam3'));
write('pom.js', "foam.POM({ name: 't', excludes: ['*'], projects: [ { name: 'foam3/pom' }, { name: 'src/com/t/pom' } ] });\n");
write('src/com/t/pom.js', "foam.POM({ name: 't', files: [ { name: 'A', flags: 'js' }, { name: 'B', flags: 'js' }, { name: 'C', flags: 'js' } ] });\n");
write('foam-check.config.json', JSON.stringify({ package: 'com.t', sources: ['src/com/t'], tsc: false, journals: false }));
write('src/com/t/A.js', model('A', ['a1', 'a2'], ['a1', 'a2']));
write('src/com/t/B.js', model('B', ['b1'], ['b1']));
write('src/com/t/C.js', model('C', ['c1'], []));

const run = (...args) => {
  const r = spawnSync(process.execPath, [check, app, ...args], { cwd: app, encoding: 'utf8', env: { ...process.env, FTYPECHECKS_NO_LSP: '1', NO_COLOR: '1' } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const listFile = path.join(app, 'foam-check.baseline.json');
const list = () => JSON.parse(fs.readFileSync(listFile, 'utf8')).problems;

let failed = 0;
const expect = (what, ok, extra) => { console.log(`${ok ? 'pass' : 'FAIL'}: ${what}`); if ( ! ok ) { failed++; if ( extra ) console.log('  ' + extra.split('\n').join('\n  ')); } };
const A1 = 'style|com.t.A.a1|property has no class', A2 = 'style|com.t.A.a2|property has no class';
const A3 = 'style|com.t.A.a3|property has no class', B1 = 'style|com.t.B.b1|property has no class';
const C1 = 'style|com.t.C.c1|property has no class';
const TA = 'type|src/com/t/A.js|TS2339|gone', TB = 'type|src/com/t/B.js|TS2339|gone';

// Errors: no list yet, a file that is not there, a file outside the sources.
let r = run('--baseline-files', 'src/com/t/A.js');
expect('no starting list: fails with a clear message', r.status === 1 && /No starting list/.test(r.out), r.out);

r = run('--baseline');
expect('--baseline writes the list', r.status === 0 && [A1, A2, B1].every(k => list()[k] === 1), r.out);
r = run('--baseline-files', 'src/com/t/Nope.js');
expect('a file that is not there: fails with a clear message', r.status === 1 && /no such file/.test(r.out), r.out);
r = run('--baseline-files', 'pom.js');
expect('a file outside the sources: fails with a clear message', r.status === 1 && /not a file the check covers/.test(r.out), r.out);

// Keys the check no longer finds (a type check that is off): one for A, one for B.
const l = JSON.parse(fs.readFileSync(listFile, 'utf8'));
l.problems[TA] = 1; l.problems[TB] = 2;
fs.writeFileSync(listFile, JSON.stringify(l, null, 2));

// The batch fixes a1 in A and adds a new problem a3. Other work on the branch fixes b1
// in B and adds a new problem c1 in C.
write('src/com/t/A.js', model('A', ['a1', 'a2', 'a3'], ['a2', 'a3']));
write('src/com/t/B.js', model('B', ['b1'], []));
write('src/com/t/C.js', model('C', ['c1'], ['c1']));

r = run('--baseline-files', 'src/com/t/A.js');
const after = list();
expect('exit 1: the batch file has a new problem', r.status === 1, r.out);
expect('fixed key of the batch file removed', ! (A1 in after), r.out);
expect('key of the batch file not found now removed (type key)', ! (TA in after));
expect('key of the batch file still there kept', after[A2] === 1);
expect('new problem in the batch file not added', ! (A3 in after));
expect('new problem in the batch file reported', /1 new problem in these files/.test(r.out) && /a3/.test(r.out), r.out);
expect('other file: fixed key kept (style key)', after[B1] === 1);
expect('other file: key not found now kept (type key)', after[TB] === 2);
expect('other file: new problem not added', ! (C1 in after));
expect('summary per file', /src\/com\/t\/A\.js: 2 removed/.test(r.out), r.out);
expect('total matches the list', JSON.parse(fs.readFileSync(listFile, 'utf8')).total === Object.values(after).reduce((a, b) => a + b, 0));

// The batch fixes a3 too: nothing new, exit 0, nothing more removed.
write('src/com/t/A.js', model('A', ['a1', 'a2', 'a3'], ['a2']));
r = run('--baseline-files', 'src/com/t/A.js');
expect('no new problem: exit 0, 0 removed', r.status === 0 && /A\.js: 0 removed/.test(r.out), r.out);

if ( ! process.env.KEEP ) fs.rmSync(app, { recursive: true, force: true });
console.log(failed ? `baseline-files: ${failed} failed` : 'baseline-files: all passed');
process.exit(failed ? 1 : 0);
