# Architecture

## The problem, stated precisely

An agent forgets for four different reasons, and each needs a different answer:

| Cause | What is lost | Answer here |
| --- | --- | --- |
| Context window limit | old turns, tool output, decisions re-litigated | durable files, re-read on demand |
| Compaction / summarisation | detail compressed into prose, exact strings gone | notes hold exact strings; journal holds narrative |
| New session, same project | everything from the previous conversation | project card + index + ranked recall |
| New project | lessons learned elsewhere | global rules + cross-project search |

"Never forget" is not a promise about the model; it is a property of where the truth
lives. momery keeps the truth in files and gives the model a cheap way back to them.

## Non-goals

- Not a transcript archive. Sessions are already logged by the harness; momery keeps
  what a future reader needs, not everything that was said.
- Not a vector database. Embeddings add a model call, a service, and an opaque index
  for a corpus that is usually under a few thousand short notes. Lexical scoring over
  Markdown wins on inspectability, determinism, offline use, and diff-ability.
- Not a chat memory product. One store, one user, many projects; git is the sync
  mechanism if sync is wanted.

## Four layers

```
L0  session log (harness-owned)      raw history, replayable, not model-visible
L1  journal/<YYYY-MM>.md             append-only narrative of what happened
L2  notes/<id>.md                    distilled knowledge: one topic per file
L3  MEMORY.md / CARD.md / catalog    generated indexes over L2 + pending
    global/*.md                      rules that outlive every project
```

Writes flow upward: a session produces a journal block; durable claims are promoted to
notes; the indexes are regenerated from notes. Reads flow downward: the card and index
point at notes; notes point at sources; the journal explains how a decision was reached.

### Why the note is the unit

A note is small enough to read whole (target under ~40 lines), specific enough to be
retrieved by keyword, and independent enough that updating it does not rewrite history.
One topic per note is the single most important discipline: it keeps retrieval precise
and diffs readable.

## File formats

### Note

```markdown
---
id: 20261101-230054-oirg
title: DSH plugin injection must name every service
type: issue
status: active
scope: project
project: f-work-momery
tags:
  - dsh
  - plugin
confidence: 0.9
created: 2026-11-01T23:00
updated: 2026-11-01T23:02
sources:
  - src/loader.ts
relations:
  - supersedes:20261031-101500-abcd
---

## Context
...
## Decision / finding
...
## Consequences
...
```

The frontmatter is YAML-ish on purpose: a small parser handles scalars, inline arrays,
block lists, and quoted strings, so no YAML dependency is needed and every field is
greppable. `id` doubles as the filename stem.

### Card

`CARD.md` is capped at 40 lines / 2400 characters: purpose, up to six rules, up to six
pending items, up to eight key notes with pointers. It is the always-on surface, so a
card that grows stops being a card. Omission is never silent: a truncated list ends with
`... +N more rules in MEMORY.md` or `... +N more in pending.md`, and a card that still
overflows ends with an explicit `CARD TRUNCATED` notice.

### Index

`MEMORY.md` is the human and agent entry point: identity, purpose, durable rules, notes
grouped by type, pending, recent journal. The tables are regenerated; the Purpose and
Durable rules prose is preserved across regeneration (read back from the existing file
before writing). The per-type note tables stop at 40 entries and say how many more exist,
so a long-lived project cannot turn its own index into a context bomb; `memory_search`
reaches the rest.

### Registry and catalog

`index.json` maps slug to `{ name, root, aliases, created, lastActive }`. Aliases are
what make cross-project addressing pleasant: `alpha`, `work/alpha`, and the full path
all resolve to the same record. `catalog.jsonl` is one JSON object per note for scripts.

## Identity

A project's slug is derived from the absolute path of the nearest ancestor holding a
project marker (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`.hg`, `AGENTS.md`, `CLAUDE.md`), normalized to lowercase ASCII with hyphens:
`F:\work\momery` becomes `f-work-momery`. Properties:

- deterministic: the same repo maps to the same folder across machines and profiles;
- human-readable: the folder name tells you which project it is;
- collision-safe in practice: the full path is encoded, not just the basename;
- stable under renames of the working directory only if the root does not move - an
  alias can bridge the difference.

The registry stores the real root path, so a moved checkout can be re-pointed without
renaming the folder. The plugin caches the resolved project per agent and invalidates
that cache when the session directory changes, so cd to another repository mid-session
switches memory targets instead of writing into the old project.

## Retrieval

Lexical, deterministic, no model call:

1. **Tokenize** the query: lowercase ASCII words (split on `_`, `.`, `-`), CJK runs into
   bigrams plus single characters. Stopwords drop out; single-character ASCII tokens are
   ignored as too noisy.
2. **Score** each note: `title x4 + tags x3 + body x2 + type x0.5`, multiplied by a
   recency boost (1.2 under a week, 1.1 under a month, 0.9 over a year), a penalty for
   `superseded`, and a confidence factor.
3. **Excerpt** around the densest match window so the snippet that justified the hit is
   the snippet the model sees.
4. **Bound** the result: default 8 hits, hard cap 25, each hit two lines plus a
   ready-to-paste `memory_read` call.

CJK handling is deliberately crude but effective: bigrams give precision for Chinese
terms and single characters give recall for mixed queries, so `记忆` matches a note
whose title contains `记忆系统存储位置` and an English query still finds a Chinese note
that happens to contain the same identifier.

No embedding fallback is planned by default. The escape hatch is the `catalog.jsonl`
file: any external indexer (ripgrep, sqlite FTS, a vector store) can be layered on top
without changing the write path.

### Why not embeddings first

- cost: every write needs a model call or a local model;
- opacity: a cosine score cannot be inspected or diffed the way a matching term can;
- false confidence: semantic search returns plausible neighbours for a query that has
  no answer, while a lexical miss is an honest miss;
- corpus size: personal project memory is small; lexical recall is excellent there.

Add a semantic re-ranker only when the corpus demonstrably outgrows lexical recall.

## Context strategies

Three mechanisms, in order of preference:

1. **Always-on section** (`system-prompt.section`): about 120 words that state the
   store root, the current project root, the three-call loop, and the cross-project
   entry point. It is rebuilt on every step, so it survives compaction, resume, and
   session switches. This is the only thing that must never be absent.
2. **Bounded call** (`memory_brief`): the card plus ranked notes, typically 400-900
   tokens. Called at task start, after a reset, or when the project feels unfamiliar.
3. **Full read** (`memory_read`): exact file content, with offset and byte caps for
   large files. Called only for hits that change a decision. The byte cap is applied to
   the encoded bytes, not characters, and never emits a half-decoded multi-byte character.

The skill (`momery/SKILL.md`) is progressive disclosure: the catalog shows a one-line
description, and the full protocol loads only when the model decides it needs the
discipline. The tools remain usable without ever loading it.

## Curation and distillation

Two maintenance operations keep the store from rotting, and both separate the mechanical
part (which the tool does) from the judgment (which the model or the human does).

**Curation** rewrites the two hand-owned sections of `MEMORY.md` - Purpose and Durable
rules - and rebuilds the card. Rules can be supplied (the model's synthesis) or derived
from decision, preference, and issue titles as a starting point. Curation is a *replace*,
not an append: dropping a rule that no longer holds is the point, and the card's byte
budget is what forces the choice. `dry_run` renders the would-be card without writing.

**Distillation** compresses the narrative without deleting it. Each journal month keeps
its raw blocks and gains a generated `## Digest` footer of one line per session; a
`YYYY-MM.digest.md` beside it holds the untruncated digest. `promote=true` returns
candidates - headline, bullet points, inferred type - that the model can turn into notes.
Re-running is idempotent: only generated content is rewritten, never the raw blocks.

The division of labour matters. A deterministic pass cannot decide that "we tried X and it
failed" deserves a note while "we renamed a variable" does not; an LLM pass cannot be
trusted to preserve raw history. So the tool writes structure, the model writes meaning,
and the raw journal stays append-only either way.

## Surviving compaction

- The prompt section is regenerated per step, so it is present after compaction.
- Notes and journals are outside the window; a compaction cannot touch them.
- `memory_end` writes the journal block and notes before the session closes, so the
  distilled form exists even if the conversation is later truncated.
- The generated card is capped, so the recovery path is a fixed cost, not a function of
  how much happened.

## Cross-project

The store is one directory. Cross-project access is therefore a parameter, not a
federation:

- `memory_status` lists projects with roots and activity;
- `memory_search project="<slug>"` searches one, `project="all"` searches everything;
- `memory_read` accepts any store-relative path, including another project's notes;
- `memory_brief other_projects=true` mixes the best foreign hits into the current
  project's brief.

Borrowing is explicit: a note copied into this project must carry `sources` naming the
origin, so the next reader can tell inherited knowledge from local knowledge.

## Write discipline

What earns a note: decisions with reasons, constraints discovered the hard way,
reusable patterns, root-caused issues keyed by their symptom text, stated preferences,
and facts no file states. What does not: secrets, personal data, file contents, or a
diary of actions. The journal absorbs narrative so notes can stay claims.

Update instead of duplicating: search first, revise by `id`, mark the old note
`superseded`. Archived and superseded notes stay on disk and out of the default recall.

## Operations

- `memory_reindex` rebuilds every generated file; safe to run at any time.
- `bin/momery.mjs` gives the same operations on the command line, so a human can search,
  read, and write without an agent.
- `index.json` plus a generated `global/index.md` make the whole store navigable in an
  editor or on a git forge.
- The store is a plain directory: back it up with `git`, sync it with any file sync, or
  delete a project folder to forget it.
- The plugin scans notes with an mtime + size cache, so repeated recalls cost one stat
  per file rather than one parse per file. First scan of a large store is linear; steady
  state is proportional to what actually changed.

## Security and privacy

- Nothing leaves the machine: no network calls, no telemetry, no model calls.
- The store path is fixed at the plugin root; `memory_read` refuses paths outside it
  (`..`, absolute paths, drive changes).
- Secrets must never be written; the skill says so explicitly. A `.gitignore` in the
  store root is recommended if the store is committed anywhere shared.
- `memory_write` can target another project, which is intentional; the tool description
  says so rather than hiding it.

## Limits and the next step

- Lexical recall degrades when a query shares no vocabulary with the note. Mitigation:
  write titles as claims and tags as handles; add a semantic re-ranker if this bites.
- The card is hand-curated only through the Purpose / Durable rules prose; pending and
  key notes are generated. A future `memory_curate` could rewrite the card's rule list
  from the highest-confidence decisions.
- The store has no CRDT or locking. Concurrent writers to the same note would lose an
  update; concurrent note creation is safe because ids are unique. A lock file or
  per-session staging directory would be the fix if parallel agents ever share a store.
- Multi-user or multi-machine sharing is git's job, not this plugin's.