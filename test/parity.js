#!/usr/bin/env node
/**
 * Parity: the plugin's own checks (used when no FOAM LSP is running) and the
 * FOAM LSP's checks must report the same problems. Each lives in its own repo,
 * so this runs both on one app and compares their report.json:
 *   - style:   class.member + rule
 *   - journal: file + line + rule
 *
 *   node test/parity.js <app folder> <FOAM-LSP folder>
 *
 * The app needs a foam-check.config.json. Writes only inside <app>/.foam-check.
 * Exit 0: the same. Exit 1: they differ (each difference is listed). Exit 2: could not run.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const [appArg, lspArg] = process.argv.slice(2);
if ( ! appArg || ! lspArg ) { console.error('usage: node test/parity.js <app folder> <FOAM-LSP folder>'); process.exit(2); }
const app = path.resolve(appArg), lspDir = path.resolve(lspArg);
const check = path.join(__dirname, '..', 'scripts', 'check.js');
const work = path.join(app, '.foam-check');
const fail = msg => { console.error('parity: ' + msg); process.exit(2); };

// 1. The plugin, loading FOAM itself. --report checks every source file and journal.
const cli = spawnSync(process.execPath, [check, '--report'], { cwd: app, encoding: 'utf8', env: { ...process.env, FTYPECHECKS_NO_LSP: '1' }, maxBuffer: 64 * 1024 * 1024 });
if ( ! fs.existsSync(path.join(work, 'report.json')) ) fail('the plugin wrote no report:\n' + (cli.stdout + cli.stderr).slice(-2000));
const plugin = JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8'));
fs.unlinkSync(path.join(work, 'report.json'));

// 2. The LSP, on the same app: it writes report.json after it starts.
const lsp = spawn(process.execPath, [path.join(lspDir, 'bin', 'lsp-start.js'), path.join(app, 'pom')], { cwd: app });
let log = '';
lsp.stdout.on('data', () => {});
lsp.stderr.on('data', d => {
  log += d;
  if ( String(d).includes('[FTypechecks] wrote types') ) compare(JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8')));
  if ( String(d).includes('[FTypechecks] write failed') ) { lsp.kill(); fail('the LSP could not write:\n' + log.slice(-2000)); }
});
lsp.on('exit', code => fail(`the LSP stopped (exit ${code}):\n` + log.slice(-2000)));
const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: 'file://' + app, capabilities: {} } });
lsp.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
setTimeout(() => { lsp.kill(); fail('no report from the LSP after 4 minutes:\n' + log.slice(-2000)); }, 240000).unref();

function compare(fromLsp) {
  lsp.removeAllListeners('exit');
  lsp.kill();
  const rel = f => path.relative(app, f);
  const sets = {
    style:   r => (r.style || []).map(s => `${s.cls}.${s.member} | ${s.rule}`),
    journal: r => (r.journal || []).map(j => `${rel(j.file)}:${j.line} | ${j.rule}`)
  };
  let differ = 0;
  for ( const [name, of] of Object.entries(sets) ) {
    const a = new Set(of(plugin)), b = new Set(of(fromLsp));
    const onlyPlugin = [...a].filter(k => ! b.has(k)).sort(), onlyLsp = [...b].filter(k => ! a.has(k)).sort();
    console.log(`${name}: plugin ${a.size}, LSP ${b.size}, both ${[...a].filter(k => b.has(k)).length}`);
    for ( const k of onlyPlugin ) console.log(`  only the plugin: ${k}`);
    for ( const k of onlyLsp )    console.log(`  only the LSP:    ${k}`);
    differ += onlyPlugin.length + onlyLsp.length;
  }
  console.log(differ ? `parity: ${differ} difference(s)` : 'parity: the same');
  process.exit(differ ? 1 : 0);
}
