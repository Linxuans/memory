# AGENTS.md - working on the momery repository

## What this repo is

A DeepSeek Harness (DSH) plugin that provides durable, project-scoped, plain-text memory
for AI coding agents, plus its skill, CLI, and docs.

## Map

- `packages/momery/index.js` - plugin entry: resolves the store root, registers the nine
  `memory_*` tools, the `momery` runtime skill, and the always-on prompt section.
- `packages/momery/lib/note.js` - frontmatter parse/serialize, ids, slugs.
- `packages/momery/lib/store.js` - layout, registry, scan cache, locks, generated indexes.
- `packages/momery/lib/search.js` - tokenizer, weighted lexical scoring, excerpts.
- `packages/momery/lib/tools.js` - the model-facing tool definitions and their text output.
- `packages/momery/lib/project.js` - working directory to project root/slug identity.
- `packages/momery/skill/SKILL.md` - the memory protocol the model loads on demand.
- `packages/momery/cordis.patch.yml` - the bundle patch (`insert` one Host row).
- `bin/momery.mjs` - human CLI over the same store.
- `docs/` - architecture, prior-art comparison, Chinese runbook.

## Rules that bite

- **Every service accessed through `ctx.get()` or `ctx.<name>` must be declared** in
  `export const inject`. Otherwise activation fails with
  `cannot get property "x" without inject`. The empty-object form
  `{ optional: [...] }` makes the Loader wait for a service literally named `optional`.
- **`ctx.workingDirectory.get()` takes a `Session`, not an `Agent`.** Passing the Agent makes
  the Harness throw `session.snapshotEvents is not a function` and, if it is not caught, every
  tool call fails. Resolve directories with `ensure(agent, signal)` only, and treat any failure
  as "unknown directory". `test/working-directory.mjs` reproduces this.
- **Tool `parameters` are raw JSON Schema**, with `required` as an array of property names.
  That is *not* `defineTool`'s author DSL (where each property carries `required: true`);
  `tools.register` uses the supplied schema as-is.
- The plugin runs from `app.asar`-installed DSH next to bundled packages. Do not import
  those packages: use Node built-ins and relative modules only.
- Writes go through `withLock` (30s stale break, 60s timeout). Keep the read-modify-write
  window inside the lock.
- The store root is user data and is **not** in this repo. Tests must use a temp root and
  clean it up.
- A session can cd; the per-agent project cache is keyed on the working directory and must
  be invalidated when it changes.
- Truncation is announced, never silent: card lists end with +N more, the card itself with
  CARD TRUNCATED, and MEMORY.md tables cap at 40 entries per type.
- Byte caps slice encoded bytes, not JS characters, and must not emit U+FFFD.
- Global rule files and pending.md are written under the same lock as notes.

## Verify a change

```powershell
node --check packages/momery/index.js
node --check packages/momery/lib/tools.js
node bin/momery.mjs status --root <temp-store>
node test/working-directory.mjs
```

Then exercise `memory_write` -> `memory_brief` -> `memory_search project="all"` ->
`memory_end` -> `memory_reindex` against the temp root before claiming it works.

## Network

This machine reaches GitHub only through the local Clash proxy on `127.0.0.1:7890`.
Pushing without `http.proxy` configured fails with `RPC failed; curl 56`. The setting is
repo-local (`git config http.proxy http://127.0.0.1:7890`), so a fresh clone needs it again.