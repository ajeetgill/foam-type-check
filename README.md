# FOAM Type Check (Claude Code plugin)

Type-checks FOAM3 model code with the TypeScript checker. It rewrites no source
and needs no change to foam3.

Status: an experiment. Tested on one small app.

## What is in the plugin

- A hook: after each Edit or Write to a model file, the check runs. Problems go
  back to Claude as an error, so Claude fixes them in the same turn.
- A skill: the four style rules, how to set up an app, how to read the errors.
- Two scripts: `scripts/check.js` (the one command) and `scripts/gen-types.js`
  (writes the types from the live FOAM models).

## What you need

- Node.
- A FOAM app with foam3 at `<app>/foam3` and a `pom.js` at `<app>/pom.js`.
- TypeScript in the app: `npm install --save-dev typescript`.
- No Java, no build, no running server.

## Install

In Claude Code:

    /plugin marketplace add ajeetgill/foam-type-check
    /plugin install foam-type-check@foam-tools

Or try it without installing, from a clone of this repository:

    claude --plugin-dir /path/to/foam-type-check

## Set up an app

1. Create `foam-check.config.json` in the app folder:

       {
         "app": ".",
         "package": "com.example.myapp",
         "sources": ["src/com/example/myapp"]
       }

   - `app`: the app folder, relative to this file.
   - `package`: the package prefix the style rules apply to.
   - `sources`: the folders to check, relative to the app folder.
   - `tsc` (optional): path to the TypeScript `tsc` program.
2. Add `.foam-check/` to `.gitignore`. Generated files go there.

With no `foam-check.config.json`, the plugin does nothing.

## Run by hand

    node scripts/check.js <app folder>

Exit code 0: no problems. Exit code 1: problems, printed.

## The four style rules

1. Every property has a `class`.
2. A method that takes arguments uses the object form with typed `args`.
3. An import says its type and has a `key`.
4. A DAO import says what it holds (`of`).

Examples are in `skills/foam-type-check/SKILL.md`.

Expect many errors on old code that does not follow the rules. Convert bit by bit.

## Not checked

Null and undefined values, the context, relationship properties, `dynamic(...)`
arguments, listener and action arguments, classes with `refines:` or no package,
Java, CSS, journals.

## How it works

1. `scripts/gen-types.js` loads FOAM and your app in Node and asks the live
   models for every class, property and method. It writes one `.d.ts` file.
2. `scripts/check.js` runs that, reports failed FOAM assertions and broken style
   rules, then runs the TypeScript checker on your sources. Check only.
3. The hook runs `check.js` after each edit and sends problems back to Claude.

It takes about 5 seconds on a small app. A new method or property is known to
the check only after the types are regenerated, so every run regenerates them.

## Tested

- One small tutorial app: 0 problems when clean.
- 21 planted mistakes across the test rounds: 21 caught.
- A project with no config file: the hook does nothing.

Not tested: other apps, other foam3 versions, an app with several `pom.js` files.

## Licence

Apache-2.0. See `LICENSE`.
