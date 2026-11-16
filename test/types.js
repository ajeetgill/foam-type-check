#!/usr/bin/env node
/**
 * Types that were missing, and the narrow test-file ignore:
 *   - dao.on.put.sub(...) on an import of type foam.dao.DAO (with or without "of"): no error;
 *     a wrong name (dao.onn, dao.on.putt) still is one
 *   - slot.get() / slot.set() on an argument of type foam.lang.Slot: no error; slot.gett() still is one
 *   - click() on a DOM query's Element: not reported in a test file; reported elsewhere
 * Builds a small app in a temp folder (its foam3 is a link to a real foam3 checkout, only read).
 *
 *   node test/types.js <foam3 folder>
 *
 * Needs TypeScript, found the way check.js finds it (CLAUDE_PLUGIN_DATA, ...), or TSC=<path to tsc>.
 * Writes only in the temp folder. Exit 0: every check passed. Exit 1: a check failed.
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const [foamArg] = process.argv.slice(2);
if ( ! foamArg || ! fs.existsSync(path.join(foamArg, 'src', 'foam_node.js')) ) {
  console.error('usage: node test/types.js <foam3 folder>'); process.exit(2);
}
const check = path.join(__dirname, '..', 'scripts', 'check.js');
const app = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ftypechecks-types-')));
const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true }); fs.writeFileSync(path.join(app, f), text); };

fs.symlinkSync(path.resolve(foamArg), path.join(app, 'foam3'));
write('pom.js', "foam.POM({ name: 't', excludes: ['*'], projects: [ { name: 'foam3/pom' }, { name: 'src/com/t/pom' } ] });\n");
write('src/com/t/pom.js', "foam.POM({ name: 't', files: [ { name: 'Item', flags: 'js' }, { name: 'Uses', flags: 'js' }, { name: 'Clicks', flags: 'js' }, { name: 'test/ClicksTest', flags: 'js' } ] });\n");
write('foam-check.config.json', JSON.stringify({ package: 'com.t', sources: ['src/com/t'], journals: false, ...(process.env.TSC ? { tsc: path.resolve(process.env.TSC) } : {}) }));
write('src/com/t/Item.js', "foam.CLASS({ package: 'com.t', name: 'Item', properties: [ { class: 'String', name: 'id' } ] });\n");
write('src/com/t/Uses.js', `foam.CLASS({
  package: 'com.t',
  name: 'Uses',
  imports: [
    { name: 'itemDAO', key: 'itemDAO', type: 'foam.dao.DAO', of: 'com.t.Item' },
    { name: 'anyDAO', key: 'anyDAO', type: 'foam.dao.DAO' }
  ],
  methods: [
    function init() {
      this.itemDAO.on.put.sub(function() {});
      this.itemDAO.on.remove.sub(function() {});
      this.itemDAO.on.reset.pub();
      this.itemDAO.on.sub(function() {});
      this.anyDAO.on.put.sub(function() {});
      this.itemDAO.onn.sub(function() {});
      this.itemDAO.on.putt.sub(function() {});
    },
    {
      name: 'follow',
      args: 'foam.lang.Slot s',
      code: function(s) {
        s.set(s.get());
        return s.gett();
      }
    }
  ]
});
`);
const clicks = name => `foam.CLASS({
  package: 'com.t',
  name: '${name}',
  methods: [
    function press() { document.querySelector('[data-x]').click(); }
  ]
});
`;
write('src/com/t/Clicks.js', clicks('Clicks'));
write('src/com/t/test/ClicksTest.js', clicks('ClicksTest'));

const r = spawnSync(process.execPath, [check, app, '--all'], { cwd: app, encoding: 'utf8', env: { ...process.env, FTYPECHECKS_NO_LSP: '1', NO_COLOR: '1' } });
const out = (r.stdout || '') + (r.stderr || '');
if ( /TypeScript (is )?not (found|installed)/.test(out) ) { console.error('types: TypeScript not found. Set TSC=<path to tsc> or CLAUDE_PLUGIN_DATA.\n' + out); process.exit(2); }
// The problems of one file, as text.
const fileOut = f => { const i = out.indexOf('\n' + f + '\n'); if ( i < 0 ) return ''; const j = out.indexOf('\n\n', i + 1); return out.slice(i, j < 0 ? out.length : j); };
const uses = fileOut('src/com/t/Uses.js');

let failed = 0;
const expect = (what, ok) => { console.log(`${ok ? 'pass' : 'FAIL'}: ${what}`); if ( ! ok ) failed++; };
expect('dao.on.put / remove / reset / on.sub: no error', ! /Property '(on|put|remove|reset|sub|pub)' does not exist/.test(uses));
expect('a DAO with no "of": dao.on.put: no error', ! /'on' does not exist on type 'DAO'/.test(uses));
expect('dao.onn: still an error', /Property 'onn' does not exist on type/.test(uses));
expect('dao.on.putt: still an error', /Property 'putt' does not exist on type/.test(uses));
expect('slot.get() and slot.set(): no error', ! /Property '(get|set)' does not exist on type 'Slot'/.test(uses));
expect('slot.gett(): still an error', /Property 'gett' does not exist on type 'Slot'/.test(uses));
expect('click() on an Element in a test file: not reported', ! /'click' does not exist/.test(fileOut('src/com/t/test/ClicksTest.js')));
expect('click() on an Element in a model file: reported', /Property 'click' does not exist on type 'Element'/.test(fileOut('src/com/t/Clicks.js')));
if ( failed ) console.log(out);

if ( ! process.env.KEEP ) fs.rmSync(app, { recursive: true, force: true });
console.log(failed ? `types: ${failed} failed` : 'types: all passed');
process.exit(failed ? 1 : 0);
