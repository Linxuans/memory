# momery

[![GitHub release](https://img.shields.io/github/v/release/Linxuans/memory)](https://github.com/Linxuans/memory/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Durable, project-scoped, plain-text long-term memory for AI coding agents, shipped as a
DeepSeek Harness plugin plus a `momery` skill.

## Why

A conversation's context window is bounded; a project's knowledge is not. momery moves
knowledge out of the window and into files that survive compaction, resume, new sessions,
and switching between projects.

## Layout

```
packages/momery/          the DSH plugin + skill (installable bundle)
docs/                     architecture, comparison, and operations notes
bin/momery.mjs            human CLI over the same store
```

Store (default `~/.momery`):

```
global/PREFERENCES.md     user-wide rules
global/LESSONS.md         transferable lessons
projects/<slug>/
  MEMORY.md               generated index (entry point)
  CARD.md                 <=40 line always-on card
  notes/<id>.md           durable knowledge, one topic per file
  journal/YYYY-MM.md      append-only session log + generated digest footer
  journal/YYYY-MM.digest.md  one-line-per-session digest
  pending.md              open questions
index.json                project registry (root path, aliases, activity)
catalog.jsonl             one JSON line per note, machine-readable
```

## Install

Current release: **[v1.1.0](https://github.com/Linxuans/memory/releases/tag/v1.1.0)**.

Installed in this profile from git, pinned to the tag:

```
plugin_manager install_bundle "git+https://github.com/Linxuans/memory.git#path:packages/momery&semver:1.1.0"
```

A local checkout can be linked instead while developing, which hot-reloads code changes:

```
plugin_manager install_bundle F:\work\momery\packages\momery
```

Replacing an installed package takes effect after the Harness restarts; a fresh install
can activate immediately.

### Network note (this machine)

GitHub is only reachable through the local Clash proxy. The plugin manager runs `git`
itself, so the proxy must be configured for GitHub globally, not only per repository:

```powershell
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```

Without it, `install_bundle` fails with `Failed to connect to github.com port 443`.

## Tools

| tool | purpose |
| --- | --- |
| `memory_brief` | project card + notes ranked for the current task |
| `memory_search` | lexical search in one project or `all` |
| `memory_read` | full read of any store file, cross-project included |
| `memory_write` | note / pending / journal / global rule |
| `memory_status` | discover projects, counts, activity |
| `memory_end` | session journal + distilled notes in one call |
| `memory_curate` | rewrite purpose and durable rules from accumulated notes |
| `memory_distill` | journal digests + promotion candidates |
| `memory_reindex` | rebuild generated indexes |

## CLI

```powershell
node bin/momery.mjs status [--all] [--pending]
node bin/momery.mjs search "<query>" [--project all|<slug>]
node bin/momery.mjs brief ["<query>"]
node bin/momery.mjs read projects/<slug>/MEMORY.md
node bin/momery.mjs write --title "..." --type decision --tags a,b --content "..."
node bin/momery.mjs curate --purpose "..." --rules "Use pnpm,Deploy to sin"
node bin/momery.mjs distill --promote
node bin/momery.mjs reindex
```

## Design in one paragraph

Markdown notes with YAML-ish frontmatter are the storage; a generated index and a
bounded card are the always-on surface; lexical scoring with field weights, recency
decay, and CJK bigrams is the retrieval; the nine tools are the API; a system-prompt
section plus the `momery` skill make the capability survive context compaction. No
embeddings, no database, no network - the store stays inspectable, greppable, and
git-able.

## Docs

- [Architecture](docs/architecture.md) - layers, formats, retrieval, context strategy, limits.
- [Prior art](docs/comparison.md) - Claude Code auto memory, Anthropic `memory_20250818`, claude-mem, MCP memory server, and what changed here.
- [Runbook (中文)](docs/runbook.zh.md) - installation, daily use, CLI, manual editing, backup, migration, FAQ.

## Verified

- Installed from git (`git+https://github.com/Linxuans/memory.git#path:packages/momery&semver:1.1.0`)
  and active in the `desktop` profile.
- All nine tools published to the model; `memory_curate`, `memory_distill`, cross-project
  reads, supersession, locks, card budget, and reindex exercised against a live store.
- `v1.0.0` and `v1.1.0` tagged and released on GitHub.

## Limits

Lexical recall cannot match a paraphrase that shares no vocabulary; write titles as claims and
tags as handles first. The store has no CRDT, so same-note concurrent writers serialize on a lock
but a stale reader can still overwrite. Nothing is encrypted; keep secrets out.