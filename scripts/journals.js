/**
 * Journal (.jrl) checks, against the live FOAM classes.
 *
 * Mistakes in a journal cost a server restart to find, and some are silent:
 *   - a row over several lines whose first line is not exactly `p({`: FOAM's journal
 *     reader reads each line as its own row, so the row loads half-filled or not at all
 *   - a line that is not a row and not a comment: FOAM reads it as a row and fails
 *   - a row that does not parse: FOAM skips it
 *   - text after the row's closing }: FOAM drops it with no error
 *   - a class that does not exist: FOAM skips the row (a row with no class gets the
 *     class the file's other rows name, if they all name one)
 *   - a key that is not a property of the class: FOAM drops the value, with no error
 *   - two or more rows of one class with no id: a replay gives them all the same empty
 *     id, so only the last one survives
 *
 * The rows are split exactly as foam.dao.AbstractFileJournal.getEntry splits them:
 * a line that is exactly `p({` (or `r({`, `c({`) starts a row that ends at a line that
 * is exactly `})`. Every other line is a row on its own.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execFileSync } = require('child_process');

const OPEN = new Set(['p({', 'r({', 'c({']);
const isRowStart = t => /^[prcv]\(/.test(t);

// FOAM journal JSON: JavaScript object syntax plus """multi-line strings""".
// FOAM's parser (JSONParser.parseString) reads the first object after `p(` and
// ignores what follows. Returns { row, rest }: rest is the text after the object
// other than the closing `)` (and a `;` or // comment after it).
// Plain JSON first (fast); else JavaScript, in one sandbox shared by every row.
let SANDBOX = null;
function objectEnd(t) {
  let depth = 0, quote = null;
  for ( let i = 0; i < t.length; i++ ) {
    const c = t[i];
    if ( quote ) { if ( c === '\\' ) i++; else if ( c === quote ) quote = null; }
    else if ( c === '"' || c === "'" || c === '`' ) quote = c;     // FOAM's StringParser takes all three
    else if ( c === '{' || c === '[' ) depth++;
    else if ( c === '}' || c === ']' ) { if ( --depth === 0 ) return c === '}' ? i : -1; }
    else if ( depth === 0 && ! /\s/.test(c) ) return -1;
  }
  return -1;
}
function parseRow(text) {
  const body = text.slice(2).replace(/"""([\s\S]*?)"""/g, (m, t) => JSON.stringify(t));
  const end = objectEnd(body);
  if ( end === -1 ) return { row: undefined, rest: '' };
  const obj = body.slice(0, end + 1), rest = body.slice(end + 1).replace(/\s*\/\/[^"'`]*$/, '').replace(/\)\s*;?\s*$/, '').trim();
  try { return { row: JSON.parse(obj), rest }; } catch (e) { /* not plain JSON: try JavaScript object syntax */ }
  SANDBOX = SANDBOX || vm.createContext(Object.create(null));
  try { return { row: vm.runInContext('(' + obj + ')', SANDBOX, { timeout: 500 }), rest }; } catch (e) { return { row: undefined, rest }; }
}

// Class ids declared in source files, also those FOAM does not load in Node
// (Java-only classes, tests). A journal row naming one of them is not an error.
// Cached per app: a long-running process (the FOAM LSP) scans once.
const DECLARED = new Map();
function declaredClasses(app) {
  if ( DECLARED.has(app) ) return DECLARED.get(app);
  const ids = new Set();
  DECLARED.set(app, ids);
  const scan = f => {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
    for ( const at of t.matchAll(/foam\.(?:CLASS|ENUM|INTERFACE)\(\s*\{/g) ) {
      const chunk = t.slice(at.index, at.index + 4000);
      const pk = /\bpackage\s*:\s*['"]([\w.]+)['"]/.exec(chunk), nm = /\bname\s*:\s*['"](\w+)['"]/.exec(chunk);
      if ( nm ) ids.add((pk ? pk[1] + '.' : '') + nm[1]);
    }
  };
  const walk = d => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for ( const x of es ) {
      const f = path.join(d, x.name);
      if ( x.isDirectory() ) { if ( x.name !== 'node_modules' && x.name !== 'build' && x.name[0] !== '.' ) walk(f); }
      else if ( x.name.endsWith('.js') ) scan(f);
    }
  };
  let tracked = null;
  try { tracked = execFileSync('git', ['ls-files', '-z', '*.js'], { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch (e) {}
  if ( tracked ) tracked.forEach(f => scan(path.join(app, f))); else walk(app);
  walk(path.join(app, 'foam3', 'src'));
  return ids;
}

function checkJournals({ foam, app, files }) {
  const found = [];
  let declared = null;
  const add = (file, line, rule, detail, key) => found.push({ file, line, rule, detail, key: key || detail });

  for ( const file of files ) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    const noId = new Map();             // class id -> line numbers of rows with no id
    const rows = [];                    // { lineNo, row } of the p(...) rows that parse
    let inBlock = false;
    for ( let i = 0; i < lines.length; i++ ) {
      const lineNo = i + 1;
      let t = lines[i];
      if ( OPEN.has(t) ) { while ( lines[i] !== '})' && i + 1 < lines.length ) t += '\n' + lines[++i]; }
      if ( ! t.trim() ) continue;
      if ( inBlock ) { if ( t.includes('*/') ) inBlock = false; continue; }
      if ( t[0] === '/' ) { inBlock = t.startsWith('/*') && ! t.includes('*/'); continue; }
      if ( ! isRowStart(t) ) { add(file, lineNo, 'line read as a row', t.trim().slice(0, 60)); continue; }

      const { row, rest } = parseRow(t);
      if ( row && typeof row === 'object' && rest ) add(file, lineNo, 'text after the row', rest.slice(0, 60));
      if ( ! row || typeof row !== 'object' ) {
        const next = lines.slice(i + 1).find(l => l.trim());
        if ( ! t.includes('\n') && next !== undefined && ! isRowStart(next) && next[0] !== '/' ) {
          add(file, lineNo, 'row split over lines', t.trim().slice(0, 60));
          // The rest of this row: FOAM reads each line as a row too. Reported once, here.
          while ( i + 1 < lines.length && ! isRowStart(lines[i + 1]) && lines[i + 1][0] !== '/' ) {
            i++;
            if ( /^\s*\}\)\s*$/.test(lines[i]) ) break;
          }
        } else add(file, lineNo, 'row does not parse', t.split('\n')[0].trim().slice(0, 60));
        continue;
      }
      if ( t[0] === 'r' ) continue;        // a remove names an id only
      rows.push({ lineNo, row, text: t });
    }

    // A row with no class gets the class of the store it is replayed into (the DAO's
    // "of"). The file does not say which; when every other row names one class, use it.
    const named = new Set(rows.map(r => r.row.class).filter(c => typeof c === 'string'));
    const fileClass = named.size === 1 ? [...named][0] : null;
    for ( const { lineNo, row, text } of rows ) {
      const cid = typeof row.class === 'string' ? row.class : fileClass;
      if ( ! cid ) continue;
      let cls; try { cls = foam.lookup(cid, true); } catch (e) {}
      if ( ! cls ) {
        declared = declared || declaredClasses(app);
        if ( ! declared.has(cid) ) add(file, lineNo, 'unknown class', cid);
        continue;
      }
      // Keys, also of nested objects that name their own class (FOAM drops those too).
      // Each at the first line of the row that writes it, as the FOAM LSP places it.
      const keyLine = k => {
        const re = new RegExp('(?:"' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"|' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\s*:');
        const i = text.split('\n').findIndex(l => re.test(l));
        return lineNo + Math.max(i, 0);
      };
      const checkKeys = (obj, c, id) => {
        const props = c.getAxiomsByClass(foam.lang.Property);
        for ( const k of Object.keys(obj) ) {
          if ( k === 'class' ) continue;
          const ax = c.getAxiomByName(k);
          const known = ( ax && foam.lang.Property.isInstance(ax) ) || props.some(p => p.shortName === k || (p.aliases || []).includes(k));
          if ( ! known ) add(file, keyLine(k), 'unknown key', `${id}.${k}`);
          for ( const v of Array.isArray(obj[k]) ? obj[k] : [obj[k]] ) {
            if ( ! v || typeof v !== 'object' || Array.isArray(v) || typeof v.class !== 'string' ) continue;
            let inner; try { inner = foam.lookup(v.class, true); } catch (e) { /* not a class: not checked */ }
            if ( inner ) checkKeys(v, inner, v.class);
          }
        }
      };
      checkKeys(row, cls, cid);
      if ( ! ('id' in row) ) {
        // Ask FOAM: a class may compute its id from other properties.
        let id;
        try {
          const args = Object.assign({}, row); delete args.class;
          id = cls.create(args, foam.__context__).id;
        } catch (e) { id = 'unknown'; }
        if ( id === '' || id === 0 || id == null ) {
          if ( ! noId.has(cid) ) noId.set(cid, []);
          noId.get(cid).push(lineNo);
        }
      }
    }
    for ( const [cid, ls] of noId ) if ( ls.length > 1 )
      add(file, ls[0], 'rows with no id', `${ls.length} rows of ${cid} have no id (lines ${ls.slice(0, 6).join(', ')}${ls.length > 6 ? ', ...' : ''})`, cid);
  }
  return found;
}

module.exports = { checkJournals };
