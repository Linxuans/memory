# momery

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
  journal/YYYY-MM.md      append-only session log
  pending.md              open questions
index.json                project registry (root path, aliases, activity)
catalog.jsonl             one JSON line per note, machine-readable
```

## Install

The bundle is already installed in the `desktop` profile as `include:momery`.
To install it elsewhere:

```
plugin_manager install_bundle F:\work\momery\packages\momery
```

## Tools

| tool | purpose |
| --- | --- |
| `memory_brief` | project card + notes ranked for the current task |
| `memory_search` | lexical search in one project or `all` |
| `memory_read` | full read of any store file, cross-project included |
| `memory_write` | note / pending / journal / global rule |
| `memory_status` | discover projects, counts, activity |
| `memory_end` | session journal + distilled notes in one call |
| `memory_reindex` | rebuild generated indexes |

## Design in one paragraph

Markdown notes with YAML-ish frontmatter are the storage; a generated index and a
bounded card are the always-on surface; lexical scoring with field weights, recency
decay, and CJK bigrams is the retrieval; the seven tools are the API; a system-prompt
section plus the `momery` skill make the capability survive context compaction. No
embeddings, no database, no network - the store stays inspectable, greppable, and
git-able.

See [docs/architecture.md](docs/architecture.md) for the full design and
[docs/comparison.md](docs/comparison.md) for prior art.
## Docs

- [Architecture](docs/architecture.md) - layers, formats, retrieval, context strategy, limits.
- [Prior art](docs/comparison.md) - Claude Code auto memory, Anthropic `memory_20250818`, claude-mem, MCP memory server, and what changed here.
- [Runbook (中文)](docs/runbook.zh.md) - installation, daily use, CLI, manual editing, backup, migration, FAQ.

## CLI

```powershell
node bin/momery.mjs status [--all] [--pending]
node bin/momery.mjs search "<query>" [--project all|<slug>]
node bin/momery.mjs brief ["<query>"]
node bin/momery.mjs read projects/<slug>/MEMORY.md
node bin/momery.mjs write --title "..." --type decision --tags a,b --content "..."
node bin/momery.mjs reindex
```

## Verified

- Bundle installed and active in the `desktop` profile (`include:momery`, `fiberPhase: active`).
- Tool schemas published to the model; `memory_brief`, `memory_search`, `memory_read`,
  `memory_write`, `memory_status`, `memory_end`, `memory_reindex` exercised against a live store.
- Cross-project read verified: a session in `F:\work\momery` read `projects/f-work-download/CARD.md`
  and found its notes with `memory_search project="all"`.
- Card budget, duplicate-title detection, supersession, locks, and reindex covered by local tests.

## Limits

Lexical recall cannot match a paraphrase that shares no vocabulary; write titles as claims and
tags as handles first. The store has no CRDT, so same-note concurrent writers serialize on a lock
but a stale reader can still overwrite. Nothing is encrypted; keep secrets out.