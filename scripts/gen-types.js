/**
 * Write a .d.ts file from the LIVE FOAM models of an app.
 *
 *   FOAM_APP=<app dir> FOAM_DTS_OUT=<file> FOAM_STYLE=<package prefix> node gen-types.js
 *
 * FOAM already knows every class and property at runtime, so we just ask it.
 * The output is only read by the TypeScript checker. No source is rewritten.
 * Normally run through check.js.
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
// Two ways to load FOAM:
//   default        the 29-file grammar slice
//   FOAM_APP=<dir> full FOAM plus the app whose pom.js is in <dir>
let foam;
const LOAD_ASSERTS = [];
let CURRENT = '';     // class being built, so a failed assertion can be tied to it
if ( process.env.FOAM_APP ) {
  const app = path.resolve(process.env.FOAM_APP);
  process.chdir(app);                       // POM paths are relative to the app
  const log = console.log;                  // loading a full app is noisy
  console.log = console.warn = () => {};
  // Keep FOAM's failed assertions: a model can load and still be broken
  // (an import with no key). They are printed at the end.
  const realAssertFn = console.assert;
  console.assert = (ok, ...msg) => {
    if ( ok ) return;
    const text = msg.join(' ');
    // Our own lookup of an id that is not a class (a file that only has "refines:").
    // That is not a problem in the code.
    if ( CURRENT && text === `Could not find any registered class for ${CURRENT}` ) return;
    LOAD_ASSERTS.push(`${CURRENT || (globalThis.foam && globalThis.foam.sourceFile) || ''}: ${text}`);
  };
  require(path.join(app, 'foam3/src/foam_node.js'));
  globalThis.foam.flags.node = true;
  require(path.join(app, 'pom.js'));
  console.log = log; console.assert = realAssertFn;
  foam = globalThis.foam;
} else {
  console.error('gen-types.js: set FOAM_APP to the app folder (it holds foam3/ and pom.js).');
  process.exit(1);
}
const OUT = path.resolve(__dirname, process.env.FOAM_DTS_OUT || 'foam.d.ts');

// Load the user's own model files the same way the slice is loaded.
for ( const f of process.argv.slice(2) ) {
  const file = path.resolve(f);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

// FOAM property class -> TypeScript type. Anything not listed is `any`.
const TYPES = {
  'foam.lang.String':   'string',
  'foam.lang.Boolean':  'boolean',
  'foam.lang.Int':      'number',
  'foam.lang.Long':     'number',
  'foam.lang.Float':    'number',
  'foam.lang.Double':   'number',
  'foam.lang.Function': '(...args: any[]) => any',
  'foam.lang.Array':    'any[]',
  'foam.lang.StringArray': 'string[]',
  'foam.lang.FObjectArray': 'any[]',
};

// Every class id FOAM knows about (loaded, lazy, or cached in the context).
const ids = new Set([
  ...Object.keys(foam.USED || {}),
  ...Object.keys(foam.UNUSED || {}),
  ...Object.keys(foam.__context__.__cache__ || {}),
  'foam.lang.FObject',   // the root class is bootstrapped, so it is in none of the lists
]);

// Bootstrapped classes (FObject, Property, Method, Model) are in none of those
// lists. Find them by walking the package objects: foam.lang, foam.u2, ...
const isPkg = o => o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
(function walk(obj, prefix, depth) {
  if ( depth > 8 ) return;
  for ( const k of Object.keys(obj) ) {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    if ( ! d || ! ('value' in d) || ! d.value ) continue;      // skip lazy getters
    const v = d.value;
    if ( typeof v.create === 'function' && v.id === prefix + k ) ids.add(v.id);
    else if ( isPkg(v) && /^[a-z]/.test(k) ) walk(v, prefix + k + '.', depth + 1);
  }
})(foam, 'foam.', 0);

// Lazy classes that need files outside the slice print warnings. Hide them.
const realAssert = console.assert, realError = console.error;
console.error = () => {};
console.assert = (ok, ...msg) => {
  if ( ok ) return;
  const text = msg.join(' ');
  // Our own lookup of an id that is not a class (a file that only has "refines:").
  // That is not a problem in the code.
  if ( text === `Could not find any registered class for ${CURRENT}` ) return;
  LOAD_ASSERTS.push(`${CURRENT}: ${text}`);
};

const tree = {};      // package tree: { foam: { parse: { Literal: {__cls} } } }
const known = [];     // ids that made it into the output
for ( const id of [...ids].sort() ) {
  let cls;
  CURRENT = id;
  try { cls = foam.lookup(id, true); if ( cls && cls.prototype ) void cls.prototype; } catch (e) { continue; }
  if ( ! cls || typeof cls.create !== 'function' || cls.id !== id ) continue;
  const parts = id.split('.');
  if ( parts.length < 2 ) continue;   // skip classes with no package
  let node = tree;
  for ( const p of parts.slice(0, -1) ) node = node[p] = node[p] || {};
  node[parts[parts.length - 1]] = { __cls: cls };
  known.push(id);
}
console.assert = realAssert; console.error = realError;
const knownSet = new Set(known);

const q = s => JSON.stringify(s);

// TypeScript cannot name a namespace `export` or `function`, but FOAM has
// packages with those names (foam.core.export). Those get a `$` prefix.
const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export ' +
  'extends false finally for function if import in instanceof new null return super switch this throw true ' +
  'try typeof var void while with').split(' '));
const seg  = s => RESERVED.has(s) ? '$' + s : s;
const tsId = id => id.split('.').map(seg).join('.');

// FOAM type name (method args, return types) -> TypeScript type.
const PRIM = { String: 'string', Boolean: 'boolean', Int: 'number', Integer: 'number', Long: 'number',
  Float: 'number', Double: 'number', Short: 'number', Byte: 'number', Function: '(...args: any[]) => any' };
// 'Void' is FOAM's default when a method declares no return type, so it means "unknown" here.
function tsType(t) {
  if ( typeof t !== 'string' || ! t ) return 'any';
  if ( t.endsWith('[]') ) { const e = tsType(t.slice(0, -2)); return e === 'any' ? 'any[]' : e + '[]'; }
  if ( PRIM[t] ) return PRIM[t];
  return knownSet.has(t) ? tsId(t) : 'any';
}

// A property's type. `loose` = FOAM adapts what you assign (a map becomes an
// object, a name becomes an enum value), so reading is typed, writing is any.
const HAS_DAO = knownSet.has('foam.dao.DAO') && knownSet.has('foam.dao.ArraySink');

function propType(p) {
  const k = p.cls_.id;
  let of; try { of = p.of && (typeof p.of === 'string' ? p.of : p.of.id); } catch (e) {}
  if ( of && knownSet.has(of) ) {
    if ( k === 'foam.lang.FObjectProperty' || k === 'foam.lang.Enum' ) return { t: tsId(of), loose: true };
    if ( k === 'foam.lang.FObjectArray' ) return { t: tsId(of) + '[]', loose: true };
    // A DAO that says what it holds: find() and select() give that class back.
    if ( k === 'foam.dao.DAOProperty' && HAS_DAO ) return { t: `foam.$DAO<${tsId(of)}>`, loose: true };
    // A reference holds the id of the other object, not the object.
    if ( k === 'foam.lang.Reference' ) {
      let idp; try { idp = foam.lookup(of).getAxiomByName('id'); } catch (e) {}
      const t = idp && TYPES[idp.cls_.id];
      if ( t === 'string' || t === 'number' ) return { t, loose: true, find: `$JsPromise<${tsId(of)}>` };
    }
  }
  if ( k === 'foam.dao.DAOProperty' && HAS_DAO ) return { t: 'foam.dao.DAO', loose: true };
  if ( k === 'foam.lang.Date' || k === 'foam.lang.DateTime' ) return { t: '$JsDate', loose: true };
  if ( k === 'foam.lang.Map' ) return { t: '{ [key: string]: any }', loose: true };
  return { t: TYPES[k] || 'any' };
}

// Gap 1: FOAM's own methods rarely declare a return type. Two local stand-ins:
// (1) a method whose every `return` is `return this;` (or `return this.other(...)`
//     where other() also returns this) returns `this`, so builder chains stay typed;
// (2) RETURNS: a hand-written list, standing in for return types declared in FOAM.
const RETURNS = {
  'foam.u2.Element.start': 'foam.u2.Element',
  'foam.u2.Element.end':   'foam.u2.Element',
};
const RT = new Map();
function returnsThis(cls, code, depth) {
  if ( RT.has(code) ) return RT.get(code);
  RT.set(code, false);                       // guard against cycles
  const src  = Function.prototype.toString.call(code);
  const rets = src.match(/\breturn\b[^;}]*/g) || [];
  const ok = rets.length > 0 && depth < 6 && rets.every(r => {
    r = r.trim();
    if ( r === 'return this' ) return true;
    const m = /^return this\.([A-Za-z_$][\w$]*)\(/.exec(r);
    if ( ! m ) return false;
    let ax; try { ax = cls.getAxiomByName(m[1]); } catch (e) {}
    return !! ( ax && typeof ax.code === 'function' && ax.code !== code && returnsThis(cls, ax.code, depth + 1) );
  });
  RT.set(code, ok);
  return ok;
}

// A method's signature: "(a?: string, b?: any): number".
// Every argument is optional, so only wrong types and too many arguments are errors.
function sig(m, cls) {
  const code = typeof m.code === 'function' ? m.code : null;
  if ( ! code ) return '(...args: any[]): any';
  const src  = Function.prototype.toString.call(code);
  const head = src.slice(0, src.indexOf('{') < 0 ? src.length : src.indexOf('{'));
  const open = /\barguments\b/.test(src) || /\.\.\.|=/.test(head.replace(/=>/g, ''));
  let params;
  if ( Array.isArray(m.args) && m.args.length >= code.length && m.args.length ) {
    params = m.args.map((x, i) => `${/^[A-Za-z_$][\w$]*$/.test(x.name || '') && ! RESERVED.has(x.name) ? x.name : 'a' + i}?: ${tsType(x.type)}`);
  } else {
    params = Array.from({ length: code.length }, (_, i) => `a${i}?: any`);
  }
  if ( open ) params.push('...rest: any[]');
  let ret = tsType(m.type);
  if ( ret === 'any' && cls ) {
    if ( RETURNS[cls.id + '.' + m.name] && knownSet.has(RETURNS[cls.id + '.' + m.name]) ) ret = tsId(RETURNS[cls.id + '.' + m.name]);
    else if ( ! /^async\b/.test(src) && returnsThis(cls, code, 0) ) ret = 'this';
  }
  if ( ret !== 'any' && ret !== 'this' && ( m.async || /^async\b/.test(src) ) ) ret = `$JsPromise<${ret}>`;
  return `(${params.join(', ')}): ${ret}`;
}

const PROPS   = new Map();   // class id -> member types for properties with typed hooks
const METHODS = new Map();   // class id -> member types for methods that declare types
const MEMBERS = new Map();   // class id -> Map(member name -> type), own and inherited

function emitClass(name, cls, ind) {
  const parent = Object.getPrototypeOf(cls);
  const pid    = parent && parent.id !== cls.id && knownSet.has(parent.id) ? parent.id : null;
  const props  = cls.getOwnAxiomsByClass(foam.lang.Property);
  const meths  = cls.getOwnAxiomsByClass(foam.lang.Method);
  const out = [];

  // 1. The instance: what you get back from create(), and what `this` is.
  out.push(`${ind}interface ${name} extends ${pid ? tsId(pid) : 'foam.$Base'} {`);
  // A subclass may reuse a parent's member name for something else
  // (a property named `diff` over the method diff()). Type those as any.
  const inherited = pid ? MEMBERS.get(pid) : new Map();
  const mine = new Map(inherited);
  MEMBERS.set(cls.id, mine);
  const typeOf = (n, t) => { const was = inherited.get(n); const r = was && was !== 'any' && t !== 'any' && was !== t ? 'any' : t; mine.set(n, r); return r; };
  for ( const p of props ) {
    const pt = propType(p);
    const t  = typeOf(p.name, pt.t);
    out.push(pt.loose && t !== 'any'
      ? `${ind}  get ${q(p.name)}(): ${t}; set ${q(p.name)}(v: any);`
      : `${ind}  ${q(p.name)}: ${t};`);
  }
  const own = [], typed = [];
  for ( const m of meths ) {
    if ( props.some(p => p.name === m.name) ) continue;
    const sg = sig(m, cls);
    own.push(m.name);     // every method name, also Java-only and abstract ones
    if ( typeof m.code === 'function' ) {
      const body = sg.replace(/\): this$/, `): ${tsId(cls.id)}`);   // `this` type is not allowed in a type literal
      if ( /\?: (?!any)|\): (?!any$)/.test(sg) ) typed.push(`{ name: ${q(m.name)}; code?(this: ${tsId(cls.id)}, ${body.slice(1).replace(/^\)/, '...none: never[])')}; [key: string]: any } & ThisType<any>`);
    }
    out.push(typeOf(m.name, sg) === sg ? `${ind}  ${q(m.name)}${sg};` : `${ind}  ${q(m.name)}: any;`);
  }
  // Methods that declare types: their bodies are checked against the declaration.
  if ( typed.length ) {
    const rest = own.filter(n => ! typed.some(t => t.startsWith(`{ name: ${q(n)};`)));
    if ( rest.length ) typed.push(`{ name: ${rest.map(q).join(' | ')}; code?: foam.$Fn<${tsId(cls.id)}>; [key: string]: any } & ThisType<any>`);
    METHODS.set(cls.id, typed);
  }
  // requires: this.Literal is the class foam.parse.Literal, so create({...}) on it is checked.
  const reqs = new Map();
  // imports that say their type: { name: 'recipeDAO', type: 'foam.dao.DAO' }
  if ( foam.lang.Import ) for ( const im of cls.getOwnAxiomsByClass(foam.lang.Import) ) {
    const of = typeof im.of === 'string' ? im.of : im.of && im.of.id;
    let t = tsType(typeof im.type === 'string' ? im.type : of || '');
    // { name: 'recipeDAO', key: 'recipeDAO', type: 'foam.dao.DAO', of: 'com.foamdev.cook.Recipe' }
    if ( t === 'foam.dao.DAO' && HAS_DAO && of && knownSet.has(of) ) t = `foam.$DAO<${tsId(of)}>`;
    if ( t !== 'any' ) reqs.set(im.name, t);
  }
  for ( const p of props ) { const pt = propType(p); if ( pt.find ) reqs.set(p.name + '$find', pt.find); }
  if ( foam.lang.Requires ) for ( const r of cls.getOwnAxiomsByClass(foam.lang.Requires) )
    if ( knownSet.has(r.path) ) reqs.set(r.name, `typeof ${tsId(r.path)}`);
  // Everything else FOAM put on the prototype: requires (this.Literal),
  // constants, imports, slots (this.count$). Typed as any, so they are
  // allowed but not checked.
  const done = new Set([...props.map(p => p.name), ...meths.map(m => m.name), 'constructor']);
  for ( const k of Object.getOwnPropertyNames(cls.prototype) ) {
    if ( done.has(k) ) continue;
    done.add(k);
    out.push(`${ind}  ${q(k)}: ${typeOf(k, reqs.get(k) || 'any')};`);
  }
  // Properties with expression / preSet / postSet: FOAM passes typed values in.
  // expression arguments are named after properties, so each gets that property's type.
  const isProp = t => t && t[0] !== '(' && ! t.startsWith('typeof ');
  const C = tsId(cls.id), tp = [];
  for ( const p of props ) {
    const hooks = ['expression', 'preSet', 'postSet'].filter(h => typeof p[h] === 'function');
    if ( ! hooks.length ) continue;
    const P = isProp(mine.get(p.name)) ? mine.get(p.name) : 'any';
    const parts = [];
    if ( hooks.includes('expression') ) {
      let names = []; try { names = foam.Function.argNames(p.expression); } catch (e) {}
      const ok = names.every(n => /^[A-Za-z_$][\w$]*$/.test(n) && ! RESERVED.has(n));
      parts.push(ok ? `expression?: (${names.map(n => `${n}?: ${isProp(mine.get(n)) ? mine.get(n) : 'any'}`).join(', ')}) => any`
                    : 'expression?: (...args: any[]) => any');
    } else parts.push('expression?: (...args: any[]) => any');
    for ( const h of ['preSet', 'postSet'] )
      parts.push(hooks.includes(h) ? `${h}?: (this: ${C}, o?: ${P}, n?: ${P}, ...rest: any[]) => any` : `${h}?: foam.$Fn<${C}>`);
    tp.push(`{ name: ${q(p.name)}; ${parts.join('; ')}; factory?: foam.$Fn<${C}>; getter?: foam.$Fn<${C}>; setter?: foam.$Fn<${C}>; adapt?: foam.$Fn<${C}>; assertValue?: foam.$Fn<${C}>; [key: string]: any } & ThisType<any>`);
  }
  if ( tp.length ) {
    const rest = props.map(p => p.name).filter(n => ! tp.some(t => t.startsWith(`{ name: ${q(n)};`)));
    if ( rest.length ) tp.push(`foam.$Prop<${C}> & { name: ${rest.map(q).join(' | ')} }`);
    PROPS.set(cls.id, tp);
  }
  // Methods promised by an interface (implements: [...]) but not written here,
  // e.g. the abstract parse() on AbstractParser.
  if ( foam.lang.Implements ) for ( const imp of cls.getOwnAxiomsByClass(foam.lang.Implements) ) {
    const intf = foam.lookup(imp.path, true);
    if ( ! intf || ! intf.getOwnAxioms ) continue;
    for ( const ax of intf.getOwnAxioms() ) {
      if ( ! ax || ! ax.name || done.has(ax.name) || typeof ax.code === 'undefined' && ! /Method/.test(ax.cls_ && ax.cls_.id) ) continue;
      done.add(ax.name);
      out.push(typeOf(ax.name, '(...args: any[]): any') !== 'any' ? `${ind}  ${q(ax.name)}(...args: any[]): any;` : `${ind}  ${q(ax.name)}: any;`);
    }
  }
  out.push(`${ind}}`);

  // 2. The args: what you may pass to create({...}). No index signature,
  //    so a wrong key is an error.
  out.push(`${ind}interface ${name}$Args${pid ? ` extends ${tsId(pid)}$Args` : ''} {`);
  for ( const p of props ) {
    out.push(`${ind}  ${q(p.name)}?: ${mine.get(p.name) === 'any' ? 'any' : TYPES[p.cls_.id] || 'any'};`);
    // create({ name$: slot }) binds the property to a slot. FOAM accepts it for every property.
    out.push(`${ind}  ${q(p.name + '$')}?: any;`);
  }
  out.push(`${ind}}`);

  // 3. The class object itself.
  out.push(`${ind}const ${name}: foam.$Class<${name}, ${name}$Args>;`);
  return out;
}

// Things in a package that are not classes: foam.util.equals, foam.json.stringify.
function extras(node, obj, ind) {
  if ( ! obj || typeof obj !== 'object' && typeof obj !== 'function' ) return [];
  return Object.keys(obj).filter(k => ! node[k] && /^[A-Za-z_$][\w$]*$/.test(k) && ! RESERVED.has(k))
    .sort().map(k => `${ind}const ${k}: any;`);
}

function emit(node, ind, obj) {
  const out = extras(node, obj, ind);
  for ( const key of Object.keys(node).sort() ) {
    const v = node[key];
    if ( v.__cls ) { out.push(...emitClass(key, v.__cls, ind)); continue; }
    out.push(`${ind}namespace ${seg(key)} {`, ...emit(v, ind + '  ', obj && Object.getOwnPropertyDescriptor(obj, key) && Object.getOwnPropertyDescriptor(obj, key).value), `${ind}}`);
  }
  return out;
}

// Fill MEMBERS parents-first, so each class can see what it inherits.
(function order(node) {
  const visit = cls => {
    if ( MEMBERS.has(cls.id) ) return;
    const parent = Object.getPrototypeOf(cls);
    if ( parent && parent.id !== cls.id && knownSet.has(parent.id) ) visit(foam.lookup(parent.id));
    emitClass('x', cls, '');
  };
  for ( const id of known ) visit(foam.lookup(id));
})();

const lines = [
  '// GENERATED by gen-types.js from live FOAM models. Do not edit.',
  '',
  '// Class id -> instance type. This is how foam.CLASS finds the type of `this`.',
  'interface $Instances {',
  ...known.map(id => `  ${q(id)}: ${tsId(id)};`),
  '}',
  '',
  '// Class id -> its methods, for classes where at least one method declares types.',
  'interface $Methods {',
  ...[...METHODS].map(([id, ts]) => `  ${q(id)}:\n    ${ts.join(' |\n    ')};`),
  '}',
  '',
  '// Class id -> its properties, for classes where a property has expression / preSet / postSet.',
  'interface $Props {',
  ...[...PROPS].map(([id, ts]) => `  ${q(id)}:\n    ${ts.join(' |\n    ')};`),
  '}',
  '',
  '// FOAM has classes named Date and Promise. These always mean the JavaScript ones.',
  'type $JsDate = Date;',
  'type $JsPromise<T> = Promise<T>;',
  '',
  '// DOM elements: querySelector() gives a plain Element, and FOAM code then reads',
  '// .value, .checked and so on. Plain JavaScript cannot cast, so allow any member.',
  'interface Element { [name: string]: any; }',
  '',
  'declare namespace foam {',
  ...(HAS_DAO ? [
  '  // A DAO that is known to hold T.',
  "  type $DAO<T> = Omit<foam.dao.DAO, 'put' | 'remove' | 'find' | 'select' | 'where' | 'orderBy' | 'skip' | 'limit' | 'inX'> & {",
  '    put(obj: T, ...rest: any[]): $JsPromise<T>;',
  '    remove(obj: T, ...rest: any[]): $JsPromise<T>;',
  '    find(id: any, ...rest: any[]): $JsPromise<T>;',
  "    select(): $JsPromise<Omit<foam.dao.ArraySink, 'array'> & { array: T[] }>;",
  '    select<S>(sink: S, ...rest: any[]): $JsPromise<S>;',
  '    where(...args: any[]): $DAO<T>; orderBy(...args: any[]): $DAO<T>;',
  '    skip(n: number): $DAO<T>; limit(n: number): $DAO<T>; inX(x: any): $DAO<T>;',
  '  };' ] : []),
  '  // Things every FOAM object has that are not axioms.',
  '  interface $Base {',
  '    SUPER(...args: any[]): any;',
  '    cls_: any;',
  '    model_: any;',
  '    __context__: any;',
  '    __subContext__: any;',
  '    instance_: any;',
  '    private_: any;',
  '  }',
  '  interface $Class<T, A> {',
  '    id: string;',
  '    name: string;',
  '    create(args?: A, ctx?: any): T;',
  '    isInstance(o: any): o is T;',
  '    [key: string]: any;',
  '  }',
  '',
  '  // `this` for a model = the generated instance type for "<package>.<name>".',
  '  // Unknown class -> any (no checking, no false errors).',
  '  type $This<P, N> =',
  '    `${P & string}.${N & string}` extends keyof $Instances',
  '      ? $Instances[`${P & string}.${N & string}`] : any;',
  '  type $Fn<T> = (this: T, ...args: any[]) => any;',
  '  // ThisType<any>: any other function in the object gets `this: any` (not checked).',
  '  type $Member<T> = { name: string; code?: $Fn<T>; [key: string]: any; } & ThisType<any>;',
  '  type $Prop<T> = {',
  '    name: string;',
  '    factory?: $Fn<T>; getter?: $Fn<T>; setter?: $Fn<T>; expression?: (...args: any[]) => any;',
  '    preSet?: $Fn<T>; postSet?: $Fn<T>; adapt?: $Fn<T>; assertValue?: $Fn<T>;',
  '    [key: string]: any;',
  '  } & ThisType<any>;',
  '  type $MethodsOf<P, N, T> =',
  '    `${P & string}.${N & string}` extends keyof $Methods',
  '      ? $Methods[`${P & string}.${N & string}`] : $Member<T>;',
  '  type $PropsOf<P, N, T> =',
  '    `${P & string}.${N & string}` extends keyof $Props',
  '      ? $Props[`${P & string}.${N & string}`] : $Prop<T>;',
  '  interface $Model<T, M = $Member<T>, PR = $Prop<T>> {',
  '    properties?: Array<string | [string, any] | PR>;   // [name, default] shorthand',
  '    methods?:    Array<$Fn<T> | M>;',
  '    listeners?:  Array<$Fn<T> | $Member<T>>;',
  '    actions?:    Array<$Fn<T> | $Member<T>>;',
  '    [key: string]: any;',
  '  }',
  '  function CLASS<const P extends string, const N extends string>(',
  '    model: { package?: P; name?: N } & $Model<$This<P, N>, $MethodsOf<P, N, $This<P, N>>, $PropsOf<P, N, $This<P, N>>>): void;',
  '  function lookup(id: string, opt?: boolean): any;',
  '  function assert(cond: any, ...msg: any[]): void;',
  // Other things on the foam object (foam.Function, foam.INTERFACE, ...).
  ...emit(tree.foam, '  ', foam).filter(l => ! /^  const (CLASS|lookup|assert): any;$/.test(l)),
  '}',
  ...Object.keys(tree).filter(k => k !== 'foam').sort().flatMap(k =>
    [ '', `declare namespace ${seg(k)} {`, ...emit(tree[k], '  ', globalThis[k]), '}' ]),
  '',
];
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${path.basename(OUT)}: ${known.length} classes, ${lines.length} lines`);
// FOAM_STYLE=<package prefix>: report on the classes of that package.
//   - failed FOAM assertions: a model can load and still be broken (an import with no key)
//   - the style rules the type check relies on
// FOAM_REPORT=<file> also writes the findings as JSON, for check.js.
if ( process.env.FOAM_STYLE ) {
  const PKG = process.env.FOAM_STYLE;
  const sourceOf = id => { try { const c = foam.lookup(id, true); return (c && c.model_ && c.model_.source) || ''; } catch (e) { return ''; } };

  const asserts = [...new Set(LOAD_ASSERTS.filter(a => a.startsWith(PKG) || a.split(': ')[0].includes(PKG.replace(/\./g, '/'))))]
    .map(a => { const i = a.indexOf(': '), where = a.slice(0, i); return { where, message: a.slice(i + 2).trim(), file: where.includes('/') ? where : sourceOf(where) }; });

  const found = [], files = new Map();
  const ownSource = cls => {
    const f = cls.model_ && cls.model_.source;
    if ( ! f ) return '';
    if ( ! files.has(f) ) { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (e) {} files.set(f, t); }
    return files.get(f);
  };
  for ( const id of known.filter(i => i.startsWith(PKG)) ) {
    const cls = foam.lookup(id), file = (cls.model_ && cls.model_.source) || '';
    const add = (kind, member, rule) => found.push({ cls: id, kind, member, rule, file });
    for ( const p of cls.getOwnAxiomsByClass(foam.lang.Property) )
      if ( p.cls_.id === 'foam.lang.Property' ) add('property', p.name, 'property has no class');
    for ( const m of cls.getOwnAxiomsByClass(foam.lang.Method) )
      // Only methods written in the class's own file (not ones FOAM generates).
      if ( typeof m.code === 'function' && m.code.length && ownSource(cls).includes(Function.prototype.toString.call(m.code)) &&
           ! ( Array.isArray(m.args) && m.args.length >= m.code.length && m.args.every(x => x && x.type) ) )
        add('method', m.name, 'argument has no type');
    if ( foam.lang.Import ) for ( const im of cls.getOwnAxiomsByClass(foam.lang.Import) )
      if ( typeof im.type !== 'string' && typeof im.of !== 'string' ) add('import', im.name, 'import has no type');
      else if ( im.type === 'foam.dao.DAO' && typeof im.of !== 'string' ) add('import', im.name, 'DAO import does not say what it holds');
  }
  if ( process.env.FOAM_REPORT ) fs.writeFileSync(process.env.FOAM_REPORT, JSON.stringify({ package: PKG, asserts, style: found }, null, 2));
  for ( const a of asserts ) console.log(`${a.where}: FOAM assertion failed: ${a.message}`);
  for ( const f of found ) console.log(`${f.cls}.${f.member}: ${f.rule}`);
  console.log(`style: ${found.length} findings, ${asserts.length} failed assertions in ${PKG}`);
}

// Browser-only classes start async work that fails in Node. The file is written, so stop here.
process.exit(0);
