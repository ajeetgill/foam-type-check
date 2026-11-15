/**
 * Every rule FTypechecks reports, in one place: what it is called, how a list of
 * them is named, and how to fix it. check.js prints from this table; gen-types.js
 * and journals.js find problems and name the rule by its id.
 *
 * Plain data, no FOAM: check.js reads it without loading FOAM.
 *
 * kind:
 *   style    a style rule; listed per file, grouped by rule, one Fix line per group
 *   line     a problem at a line; listed one by one, each with its Fix line
 */

// Style rules, checked on the live classes of the app's package (gen-types.js).
// Each rule walks one kind of axiom: `axiom` is the axiom class, `bad` says when it breaks the rule.
const STYLE = [
  {
    id: 'property has no class', axiom: 'foam.lang.Property', member: 'property',
    group: 'properties with no class', one: 'property with no class',
    fix: "Add a class, for example class: 'String'.",
    bad: p => p.cls_.id === 'foam.lang.Property'
  },
  {
    id: 'argument has no type', axiom: 'foam.lang.Method', member: 'method',
    group: 'methods with untyped arguments', one: 'method with untyped arguments',
    fix: "Use the object form: { name, args: 'Type name', code: function(name) {...} }.",
    // Only methods written in the class's own file (not ones FOAM generates).
    bad: (m, ctx) => typeof m.code === 'function' && m.code.length && ctx.ownSource().includes(Function.prototype.toString.call(m.code)) &&
      ! ( Array.isArray(m.args) && m.args.length >= m.code.length && m.args.every(x => x && x.type) )
  },
  {
    id: 'import has no type', axiom: 'foam.lang.Import', member: 'import',
    group: 'imports with no type', one: 'import with no type',
    fix: "Use the object form: { name: 'x', key: 'x', type: 'Type' }.",
    bad: im => typeof im.type !== 'string' && typeof im.of !== 'string'
  },
  {
    id: 'DAO import does not say what it holds', axiom: 'foam.lang.Import', member: 'import',
    group: 'DAO imports with no "of"', one: 'DAO import with no "of"',
    fix: "Add of: '<class id>' to the import.",
    bad: im => im.type === 'foam.dao.DAO' && typeof im.of !== 'string'
  },
  {
    // Found in the type check (check.js): an unknown name that the same file assigns.
    id: 'undeclared field', member: 'field',
    group: 'undeclared fields', one: 'undeclared field',
    fix: "The code sets this on a FOAM object, but the class does not declare it. Declare it in properties, for example { class: 'Boolean', name: 'x' }."
  }
].map(r => ({ ...r, kind: 'style' }));

// Journal (.jrl) rules (journals.js).
const JOURNAL = [
  { id: 'row split over lines', title: 'Row split over lines', fix: 'FOAM reads a row over several lines only when its first line is exactly p({ and its last line is exactly }). Put p({ and }) on lines of their own, or write the row on one line. As it is, each line is read as a row: the row loads half-filled or not at all.' },
  { id: 'line read as a row',   title: 'Line read as a row',   fix: 'FOAM reads every line that is not a comment as a row, and fails on this one. Start a comment with // at the very start of the line.' },
  { id: 'row does not parse',   title: 'Row does not parse',   fix: 'FOAM cannot read this row and skips it. Check quotes, commas and brackets.' },
  { id: 'unknown class',        title: 'Unknown class',        fix: 'No class has this id, so FOAM skips the row. Check the spelling and the package.' },
  { id: 'unknown key',          title: 'Unknown key (FOAM silently drops it)', fix: 'The class has no property with this name, so the value is lost with no error. Use a property name of the class, or remove the key.' },
  { id: 'rows with no id',      title: 'Rows with no id',      fix: 'A journal replay gives each of these rows the same empty id, so only the last one survives. Give every row its own "id".' }
].map(r => ({ ...r, kind: 'line', group: 'journal problems', one: 'journal problem' }));

const OTHER = [
  { id: 'foam assertion', kind: 'line', group: 'failed FOAM assertions', one: 'failed FOAM assertion' },
  { id: 'type error',     kind: 'line', group: 'type errors',            one: 'type error' }
];

const RULES = Object.fromEntries([...STYLE, ...JOURNAL, ...OTHER].map(r => [r.id, r]));

// TypeScript errors that say something about FOAM code, with a plain name.
// Level "foam" keeps only these; level "strict" keeps every error in a model file.
const TS = {
  TS2339: 'Unknown name', TS2551: 'Unknown name',
  TS2353: 'Unknown key (FOAM would silently drop it)', TS2561: 'Unknown key (FOAM would silently drop it)',
  TS2554: 'Wrong number of arguments', TS2555: 'Wrong number of arguments',
  TS2345: 'Wrong type', TS2322: 'Wrong type', TS2304: 'Name is not defined', TS2552: 'Name is not defined'
};

// Plain-JavaScript cleanups that level "strict" reports: [error code, message, how to fix].
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

module.exports = { RULES, STYLE, TS, cleanupFix };
