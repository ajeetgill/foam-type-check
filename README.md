# FTypechecks: FOAM Type-Checking

A Claude Code plugin. It type-checks FOAM3 model code with the TypeScript checker.

- It rewrites no source.
- It needs no change to foam3.
- It works on new code and on existing code.

Status: an experiment. Tested on one small app and tried once on one big app.

## Why

FOAM accepts many mistakes without a word. A wrong property name, a wrong key
in `create({...})`, an import with no `key`: the app loads, and the mistake
shows up later in the browser, or never.

This check finds those mistakes in a few seconds, with no build and no server.

## What is in the plugin

- **A hook.** After each Edit or Write to a model file, the check runs. Problems
  go back to Claude as an error, so Claude fixes them in the same turn.
- **A skill.** The four style rules, how to convert existing code, how to read the errors.
- **Two scripts.** `scripts/check.js` is the one command. `scripts/gen-types.js`
  writes the types from the live FOAM models.

## What you need

- Node.
- A FOAM app with foam3 at `<app>/foam3` and a `pom.js` at `<app>/pom.js`.
- TypeScript. If it is missing, the hook tells Claude to ask you before it installs it.
- No Java, no build, no running server.

## Install

In Claude Code:

    /plugin marketplace add ajeetgill/foam-type-check
    /plugin install foam-type-check@foam-tools

Or try it without installing, from a clone of this repository:

    claude --plugin-dir /path/to/foam-type-check

## Set up an app

The example is [FOAM-Recipes](https://github.com/foam-foundation/FOAM-Recipes),
the FOAM tutorial app. Its layout:

    FOAM-Recipes/
      foam3/                      FOAM itself
      pom.js                      the app's POM
      src/com/foamdev/cook/       the model files (Recipe.js, RecipeStep.js, ...)

1. Create `foam-check.config.json` in the app folder, here `FOAM-Recipes/`:

       {
         "app": ".",
         "package": "com.foamdev.cook",
         "sources": ["src/com/foamdev/cook"]
       }

   - `app`: the app folder, relative to this file. It holds `foam3/` and `pom.js`.
   - `package`: the package prefix the style rules apply to. All FOAM-Recipes
     classes are `com.foamdev.cook.<Name>`.
   - `sources`: the folders to check, relative to the app folder.
   - `tsc` (optional): path to the TypeScript `tsc` program, if it is not in the app's `node_modules`.
     `false` skips the type check; the other checks still run.
   - `level` (optional): `"strict"` (default) or `"foam"`. See "Two levels" below.
   - `hook` (optional): what the hook checks after an edit. `"file"`: only the
     edited file. `"all"`: every source folder. Default: `"all"` up to 100
     source files, `"file"` above that.
2. Install TypeScript in the app folder: `npm install --save-dev typescript`.
3. Add `.foam-check/` to `.gitignore`. Generated files go there.
4. Run the check from the app folder:

       node /path/to/foam-type-check/scripts/check.js

       FTypechecks: 0 problems (com.foamdev.cook)

For your own app, change `package` and `sources`.

With no `foam-check.config.json`, the plugin does nothing.

## Commands

Run from the app folder, or give the app folder as the first argument.

| Command | What it does |
| :- | :- |
| `node scripts/check.js` | Check. Exit code 0: no problems. Exit code 1: problems, printed. |
| `node scripts/check.js --report` | Conversion report: what is left to convert, per file. |
| `node scripts/check.js --baseline` | Write the starting list: accept today's problems. |
| `node scripts/check.js --all` | Check and ignore the starting list. |
| `node scripts/check.js --editor` | Write `jsconfig.json` in the app, so VS Code knows the FOAM types while you type. |

## The four style rules, with examples

The check can only find what FOAM knows. These four rules tell FOAM the types.

### 1. Every property has a `class`

Bad. FOAM does not know what `title` holds:

    properties: [
      'title',
      { name: 'servings' }
    ]

Good:

    properties: [
      { class: 'String', name: 'title' },
      { class: 'Int',    name: 'servings' }
    ]

What you gain: `recipe.servings = 'four'` is now reported.

### 2. A method that takes arguments uses the object form with `args`

Bad. FOAM ignores type comments in an argument list, so `index` has no type:

    methods: [
      async function removeStep(/* Int */ index) {
        ...
      }
    ]

Good:

    methods: [
      {
        name: 'removeStep',
        args: 'Int index',
        async: true,
        code: async function(index) {
          ...
        }
      }
    ]

What you gain: `this.removeStep('two')` is now reported.

Not reported: `this.removeStep()` with the argument left out. Every argument is treated as optional.

A method with no arguments can stay short: `function render() { ... }`.

### 3. An import says its type and has a `key`

Bad. `notify` could be anything:

    imports: [
      'notify',
      'recipeDAO'
    ]

Also bad. This loads, but FOAM reports "No key for import" and the import is broken:

    imports: [
      { name: 'notify', type: 'Function' }
    ]

Good:

    imports: [
      { name: 'notify', key: 'notify', type: 'Function' }
    ]

What you gain: `this.notfy(...)` was always an error. Now `this.notify.foo` is too.

### 4. A DAO import says what it holds

Bad. The check knows it is a DAO, but not a DAO of what:

    { name: 'recipeDAO', key: 'recipeDAO', type: 'foam.dao.DAO' }

Good:

    { name: 'recipeDAO', key: 'recipeDAO', type: 'foam.dao.DAO', of: 'com.foamdev.cook.Recipe' }

What you gain: after `var r = await this.recipeDAO.find(id)`, `r.titel` is reported.

## Mistakes it finds, with no rule needed

These are found in any code, because FOAM already knows the classes:

    this.Recipe.create({ nmae: 'Soup' })   // unknown key. FOAM would silently drop it.
    recipe.titel                           // unknown name
    this.removeStepp(2)                    // unknown name. Did you mean 'removeStep'?
    this.start().addClas('x')              // unknown name in a builder chain

## What the output looks like

A check with problems:

    FTypechecks: 2 problems in 1 file

    src/com/foamdev/cook/RecipeView.js
      line 158: Unknown name (TS2551)
          Property 'removeStepp' does not exist on type 'RecipeView'. Did you mean 'removeStep'?
      1 method with untyped arguments: brandNew
          Fix: Use the object form: { name, args: 'Type name', code: function(name) {...} }.

A clean check:

    FTypechecks: 0 problems (com.foamdev.cook)

In a terminal, file names are bold and problems are red. Set `NO_COLOR=1` to turn that off.

## Existing code: convert bit by bit

Old code does not follow the four rules. Without help, every check would fail
with all the old problems. The starting list solves that.

### Step 1. See how much there is

    node scripts/check.js --report

    FTypechecks conversion report: com.foamdev.cook

         21  files checked
         12  files with 0 problems
          9  files to convert
         32  problems in total

    By kind
         17  methods with untyped arguments
         15  imports with no type

    By file  (most problems first)

    src/com/foamdev/cook/RecipeCreateView.js  — 11 problems
          6  imports with no type
          5  methods with untyped arguments

### Step 2. Accept today's problems

    node scripts/check.js --baseline

This writes `foam-check.baseline.json` next to the config file. Commit it.

From now on the check, and the hook, fail only on **new** problems:

    FTypechecks: 0 new problems (com.foamdev.cook)
    32 older problems on the starting list are not shown. See them with --all.

### Step 3. Convert, one file at a time

Pick a file from the report. Convert it. Run the check. Then:

    FTypechecks: 0 new problems (com.foamdev.cook)
    26 older problems on the starting list are not shown. See them with --all.
    6 problems from the starting list are fixed. Run --baseline to shrink the list.

Run `--baseline` again. The list only gets shorter. A problem that comes back is reported as new.

### Step 4. Finish

When `--report` shows 0 problems, delete `foam-check.baseline.json`.

### Two ways to work

- **Bit by bit.** Keep the starting list. Convert a file when you touch it.
- **All at once.** Convert a whole package, then delete the starting list.

### An order that worked

1. Imports (rule 3). Small and mechanical.
2. Methods (rule 2). You must look up each argument type.
3. DAO imports (rule 4).
4. Properties (rule 1).

### Traps we hit

- **An object-form import with no `key`.** It loads and is broken. The check reports it.
- **Find-and-replace run twice.** It turned an import into
  `{ name: { name: ... } }`. FOAM accepted it. The check caught it. Convert by hand or check after each file.
- **A wrong type guess.** We wrote a class where the value was a name string. The check caught it at the call.
- **The check is not a test.** After converting, run the app and click through the changed screens.

## Big apps: the main blocker

The biggest blocker is the work, not the tool: old code has to be converted by
hand, file by file, and the check finds little in a file until that file
follows the four rules. Speed was the second blocker, because a full check
re-reads every source file. So on a big app the hook checks only the edited
file, and you run the full check yourself before you finish.

Measured on one big app (1,144 source files):

- Full check: about 35 seconds.
- Hook after an edit, one file: 7 to 11 seconds.
- First report at level `strict`: 2,668 problems. 2,524 of them are the four style rules, 109 are type errors, 35 are undeclared fields.
- At level `foam`: 8 type errors, 24 undeclared fields.

### A change that breaks another file

After an edit, the check also looks at the files that **use** a class you
changed. It compares each class's shape (its properties and method signatures)
with the last run. A change inside a method body changes no shape, so it adds
nothing. A rename does.

Example: rename the property `removeLabel` of `Chip` to `removeLabelX`. The check
then also checks the 23 files that name `Chip`, and reports the 2 that still pass
`removeLabel` in `start(this.Chip, { removeLabel: ... })`.

In those other files it shows only problems that are new since the last run.
Their old problems are not caused by your edit.

### Batch mode: one check per turn

`"hook": "batch"` in the config: after an edit, the hook only notes the file.
When Claude finishes its turn, one run checks every file edited in that turn
(the Stop hook). If there are problems, Claude goes on and fixes them. If the
same problems come back a second time, Claude may stop; the files stay on the
list for the next turn.

Measured on the big app: 3 edits checked one by one, 14.8 seconds. The same 3
edits in batch mode: 0.2 seconds for the edits, then one check of 5.6 seconds.
The more edits in a turn, the bigger the saving.

### Faster with the FOAM LSP (experiment)

The hook spends half its time loading FOAM. A [FOAM LSP](https://github.com/foam-foundation/FOAM-LSP)
already has FOAM loaded. An experimental LSP branch (`experiment/ftypechecks-types`,
not published yet) watches the source folders. After an edit it writes the
types file in about half a second, and the hook uses that file.

- Measured on the same big app: hook 2.2 to 2.8 seconds (4.3 to 4.8 without the LSP). Same problems reported.
- Nothing to set up in the plugin. The LSP finds `foam-check.config.json` at the workspace root.
- No LSP running: the hook loads FOAM itself, as before.
- `"lspWait"` in the config: how long the hook waits for the LSP, in milliseconds (default 4000).

## Undeclared fields

Code sometimes sets a field that the class never declares:

    this.opening_ = true;            // no property named opening_
    var dao = this.ProxyDAO.create();
    dao.refuseWith = '';             // ProxyDAO has no refuseWith

This is reported as its own line, once per field:

      2 undeclared fields: opening_ (on ReaderView), refuseWith (on ProxyDAO)
          Fix: ... Declare it in properties, for example { class: 'Boolean', name: 'x' }.

## Two levels

The aim: cleaner code, and mistakes caught by a type check, not by a build and
a server start.

**`"level": "strict"` (default).** Every type error in a model file is
reported, also the ones that are valid JavaScript. Each of these has a `Fix:` line:

    isNaN(date)                       Fix: isNaN(date.getTime())
    el.value  (el from querySelector) Fix: /** @type {HTMLInputElement} */ (el)
    rule.selectorText                 Fix: /** @type {CSSStyleRule} */ (rule)
    list items with different keys    Fix: give every item the same keys
    var x = 1; ... var x = 'a';       Fix: use a new variable name

**`"level": "foam"`.** Only wrong FOAM names and wrong FOAM types: a wrong
property or method name, a wrong `create({...})` key, a wrong argument, a
broken import. These are the mistakes that otherwise need a build and a test
run to find. Plain JavaScript findings are dropped, and browser objects accept
any member. Use this to start on a big code base with less noise.

**One file can set its own level** in its first lines, like Sorbet's sigils:

    // ftypechecks: off       not checked at all
    // ftypechecks: foam      level "foam" for this file
    // ftypechecks: strict    level "strict" for this file

So a big app can run at level `foam` and turn files to `strict` one by one, or
turn off a file it cannot convert yet.

## Journals (.jrl)

Every `.jrl` file in git is checked against the live classes (or the folders in
`"journals"` in the config; `false` turns this off). Each of these costs a server
restart to find, and some fail with no error:

| Problem | What FOAM does |
| :- | :- |
| A row over several lines whose first line is not exactly `p({` | reads each line as a row: the row loads half-filled |
| A line that is not a row and not a comment | fails on it |
| A row that does not parse | skips it |
| An unknown class | skips the row |
| An unknown key | drops the value, no error |
| Two or more rows of a class with no id | gives them all the same empty id: only the last survives |

A row with no `class` is checked as the class the file's other rows name. A
class that FOAM does not load in Node (Java-only, tests) is found in the source
files, so it is not reported as unknown. After you edit a journal, the hook
checks that journal only.

## Types in your editor

`node scripts/check.js --editor` writes `jsconfig.json` in the app. VS Code (and
other editors that use TypeScript) then know every FOAM class: autocomplete and
hover types in every model file. For red underlines in a file, put `// @ts-check`
on its first line. Every check rewrites the types, so the editor stays current.
Note: VS Code ships its own, older TypeScript; this was tested with TypeScript 7.

## Mixins

A class that another class takes in with `mixins: [...]` is checked as its
host: inside the mixin, `this` is the host class. With several hosts, `this`
is not checked.

## Not flagged, at both levels

- A file that only has `refines:`. Refinements are not checked.
- `create({ name$: slot })`. FOAM binds the property to the slot.
- A plain script with no FOAM model in it, such as a Node runner.
- Fields added to a plain JavaScript object (`var o = {}; o.x = 1`).

## Not checked

Null and undefined values, a missing argument, the context, relationship properties, `dynamic(...)`
arguments, listener and action arguments, classes with `refines:` or no package,
Java, CSS.

0 problems means no wrong names and no wrong types in the checked parts. It does
not mean the app works.

## How it works

1. `scripts/gen-types.js` loads FOAM and your app in one Node process and asks
   the live models for every class, property and method. It writes one `.d.ts` file.
2. `scripts/check.js` runs that, collects failed FOAM assertions and broken style
   rules, then runs the TypeScript checker on your sources. Check only.
3. The hook runs `check.js` after each edit (or, in batch mode, once per turn)
   and sends problems back to Claude.

Inside `check.js`: the settings are read once; then the first **type provider**
that can answer writes the types (a running FOAM LSP, else a FOAM load); then each
**problem source** (FOAM assertions, style rules, journals, TypeScript) adds its
problems; then the scope is applied; then the mode prints. Every rule, its name
and its fix, is in one table: `scripts/rules.js`.

It takes about 5 seconds on a small app. Every run regenerates the types, so a
new method or property is known at once.

## Tested

- One small tutorial app: 0 problems when converted.
- An unconverted copy of that app: 32 problems reported; with a starting list, 0 new.
- New mistakes on top of a starting list: reported. Old ones: not reported.
- 21 planted mistakes across the test rounds: 21 caught.
- Every example in this README was planted and run: 9 are reported, and the 1 marked "not reported" is not.
- A project with no config file: the hook does nothing.

- One big app (1,144 files), read-only: the numbers above. Three groups of
  false alarms found there are fixed (refinement files, `name$` keys, mixins).
  The remaining type errors are not sorted into real bugs and cleanups.

Not tested: other foam3 versions, an app with several `pom.js` files, a full conversion of a big app.

## Licence

Apache-2.0. See `LICENSE`.
