---
name: foam-type-check
description: Use when writing or editing FOAM3 model code (foam.CLASS files) in a project that has a foam-check.config.json, when the "FOAM type check" hook reports problems, or when asked to set up or run the FOAM type check. Gives the four style rules the check needs and how to read and fix its errors.
---

# FOAM type check

A check for FOAM3 model code. It loads the live FOAM models, writes one file of
types, and runs the TypeScript checker on the plain `.js` files. It rewrites no
source and needs no change to foam3.

A hook runs it after each edit to a `.js` file inside the checked folders. If it
finds a problem, the edit comes back with an error. Fix the problem, do not work
around it.

## Run it by hand

    node "${CLAUDE_PLUGIN_ROOT}/scripts/check.js" <app folder>

Exit code 0: no problems. Exit code 1: problems, printed. It takes a few seconds.

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

## Read the errors

- `FOAM assertions failed`: FOAM itself rejected something while loading. Most
  often `No key for import`. Fix the model.
- `Style rules broken`: one of the four rules. The line names the class and member.
- `Type errors`: TypeScript errors, as `file(line,column): error TS....`. Typical ones:
  - `Property 'x' does not exist on type 'Y'`: a wrong property or method name,
    or a member that is not declared on the class. Check the spelling first.
  - `Object literal may only specify known properties`: a `create({...})` key
    that is not a property. FOAM would silently drop it.
  - `Expected N arguments` / `not assignable to parameter`: a wrong call to a typed method.
- `The models did not load`: a syntax error or a load error. Read the last lines.

A new method or property is known to the check only after the types are
regenerated. The check does that itself on every run.

## What it does not check

Null and undefined values, anything read from the context, relationship
properties, `dynamic(...)` arguments, listener and action arguments, classes
with `refines:` or with no package, Java, CSS, journals.

0 problems means no wrong names and no wrong types in the checked parts. It does
not mean the app works.
