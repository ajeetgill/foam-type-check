---
name: foam-type-check
description: Use when writing or editing FOAM3 model code (foam.CLASS files) in a project that has a foam-check.config.json, when the "FTypechecks" hook (FOAM type check) reports problems, when asked to set up or run the FOAM type check, or when asked to convert existing FOAM code to typed imports, typed method arguments and property classes. Gives the four style rules, the conversion steps for existing code, and how to read and fix the errors.
---

# FTypechecks: FOAM Type-Checking

A check for FOAM3 model code. It loads the live FOAM models, writes one file of
types, and runs the TypeScript checker on the plain `.js` files. It rewrites no
source and needs no change to foam3.

A hook runs it after each edit to a `.js` file inside the checked folders. If it
finds a problem, the edit comes back with an error. Fix the problem, do not work
around it.

## Commands

    node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js" <app folder>             check
    node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js" <app folder> --report    what is left to convert, per file
    node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js" <app folder> --baseline  accept today's problems (starting list)
    node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js" <app folder> --all       check, ignoring the starting list

Exit code 0: no problems (or no new ones). Exit code 1: problems, printed. It takes a few seconds.

## Set it up in an app

1. The app needs foam3 at `<app>/foam3` and a `pom.js` at `<app>/pom.js`.
2. Create `foam-check.config.json` in the app folder:

       {
         "app": ".",
         "package": "com.example.myapp",
         "sources": ["src/com/example/myapp"]
       }

   - `app`: the app folder, relative to this file.
   - `package`: the package prefix the style rules apply to.
   - `sources`: the folders to check, relative to the app folder.
   - `tsc` (optional): path to the TypeScript `tsc` program.
3. TypeScript must be installed: `npm install --save-dev typescript` in the app folder.
4. Add `.foam-check/` to `.gitignore`. The check writes its generated files there.

With no `foam-check.config.json`, the hook does nothing.

## The four style rules

Follow these in every model file. The check reports each one that is broken.

1. Every property has a `class`.

       { class: 'String', name: 'title' }

2. A method that takes arguments uses the object form with typed `args`.
   FOAM ignores `/* Type */` comments in an argument list.

       {
         name: 'removeStep',
         args: 'Int index',
         async: true,
         code: async function(index) { ... }
       }

   A method with no arguments can stay `function name() { ... }`.

3. An import says its type and has a `key`. An object-form import with no `key`
   loads but is broken.

       { name: 'notify', key: 'notify', type: 'Function' }

4. A DAO import says what it holds.

       { name: 'recipeDAO', key: 'recipeDAO', type: 'foam.dao.DAO', of: 'com.example.myapp.Recipe' }

Argument types are FOAM type names: `String`, `Boolean`, `Int`, `Long`, `Float`,
`Double`, `Function`, or a full class id such as `com.example.myapp.Recipe`.

## Existing code: convert it

Old code does not follow the rules. Do not try to fix everything in one edit.

1. Run `--report`. It lists the files and how many problems each has.
2. If there is no `foam-check.baseline.json` yet, ask the user before writing one
   with `--baseline`. It accepts today's problems, so the check and the hook
   fail only on new ones.
3. Convert one file at a time. Run the check after each file.
4. When the check says problems from the starting list are fixed, run
   `--baseline` again. The list only gets shorter.
5. When `--report` shows 0 problems, tell the user the starting list can be deleted.

Never run `--baseline` to make a new problem go away. Fix the problem.

Order that works inside a file: imports (rule 3), then methods (rule 2), then
DAO imports (rule 4), then properties (rule 1).

How to find the right types:

- Method arguments: read how the method is called and how the argument is used.
  Do not guess a class when the value is a name or an id. If unsure, ask.
- Imports: find the matching `exports` or the service the context provides.
  A function is `type: 'Function'`. A DAO is `type: 'foam.dao.DAO'` plus `of`.
- DAO `of`: the class the DAO stores. Check the DAO's definition or a `find`/`put` call.
- Properties: pick the FOAM property class that matches the stored value
  (`String`, `Int`, `Boolean`, `Date`, `FObjectProperty` with `of`, `Reference` with `of`, ...).

Traps:

- Every object-form import needs `key`. Without it the import loads and is broken.
- Do not run a bulk find-and-replace twice. It can produce `{ name: { name: ... } }`,
  which FOAM accepts silently.
- A method changed to the object form keeps its behaviour only if `async: true`
  is set for an `async function`, and the `code` function is otherwise unchanged.
- The check is not a test. After converting, tell the user which screens to click through.

## Read the errors

Problems are grouped by file. Each has a plain-language title.

- `FOAM rejected this while loading`: a failed FOAM assertion. Most often
  `No key for import`. Fix the model.
- `N methods with untyped arguments: a, b` (and the other three rule lines): a
  style rule is broken. The line names the members. A `Fix:` line follows.
- `line N: Unknown name (TS2339 / TS2551)`: a wrong property or method name, or
  a member that is not declared on the class. Check the spelling first.
- `line N: Unknown key (TS2353 / TS2561)`: a `create({...})` key that is not a
  property. FOAM would silently drop it.
- `line N: Wrong number of arguments` / `Wrong type`: a wrong call to a typed method.
- `The models did not load`: a syntax error or a load error. Read the last lines.
- `N undeclared fields: x (on Y)`: the code sets a field that class Y does not
  declare. Declare it in `properties`.
- `N older problems on the starting list are not shown`: not an error. Old code
  that is still to be converted.
- `Only the edited file was checked`: on a big app the hook checks one file, to
  stay fast. Before you say the work is done, run the full check with the
  command above. It finds problems the edit caused in other files.

A new method or property is known to the check only after the types are
regenerated. The check does that itself on every run.

## What it does not check

Null and undefined values, a missing argument, anything read from the context, relationship
properties, `dynamic(...)` arguments, listener and action arguments, classes
with `refines:` or with no package, Java, CSS, journals.

0 problems means no wrong names and no wrong types in the checked parts. It does
not mean the app works.
