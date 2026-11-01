---
name: momery
description: Durable, project-scoped long-term memory that survives context limits. Load before non-trivial work to recall the project card and relevant notes, when a durable fact/decision/constraint appears, when another project's memory is needed, or before a session ends.
whenToUse: Any task in an unfamiliar or resumed project; any decision the next session must not re-derive; any cross-project question; any session close.
---

# momery - memory protocol

Memory lives outside the context window as plain Markdown under the store root
(`~/.momery` by default). The tools are the API; the files are the truth. Recall
costs one bounded call, writing costs one call, and nothing is lost when the
conversation is compacted, resumed, or abandoned.

## The loop

1. **Open with `memory_brief`.** Run it before non-trivial work, after a context
   reset, and whenever the project feels unfamiliar. Pass `query` with the task's
   entities, files, symptoms, or error text - not a generic phrase. It returns the
   project card (purpose, rules, pending) plus ranked notes.
2. **Read what matters.** `memory_read path=...` on the two or three hits that
   change a decision. Do not read every note; the excerpt exists so you can choose.
3. **Write when it is durable.** Call `memory_write` (or `memory_end` at close) as
   soon as a decision, non-obvious constraint, reusable pattern, root-caused bug, or
   user preference appears - while the evidence is fresh, not at the end.
4. **Close with `memory_end`.** One journal block plus the notes the next session
   needs, and the open items that remain.

## What deserves a note

- A **decision** and the reason it beat the alternatives (these are re-litigated
  forever when unrecorded).
- A **constraint** discovered the hard way: platform limits, API quirks, ordering
  requirements, things that look wrong but are intentional.
- A **pattern** worth copying: file layout, naming, test strategy, build steps.
- An **issue** with its root cause and the fix, keyed by the exact symptom text so
  the next search hits it.
- A **preference** the user stated - about tone, tools, process, or scope.
- A **fact** about the project that no file states: ownership, environment, why a
  module exists.

Never write: secrets, tokens, customer data, whole file contents, or a diary of
what you did. Journal is for the story; notes are for the knowledge.

## Note shape

`memory_write` stores one topic per file with frontmatter. A good body:

    ## Context
    What was true before, and the symptom that forced a decision.
    ## Decision / finding
    The one-sentence claim. Then the specifics: paths, versions, commands.
    ## Consequences
    What to do next time, what would invalidate this.

Title it as a claim ("Build uses Vite 6, not esbuild"), not a topic ("Build"). Tags
carry the retrieval handles: module names, technologies, exact error strings.

Update instead of duplicating: search first, then pass `id` to revise. Mark the old
note `status:"superseded"` when a new one replaces it.

## Keep the card sharp (`memory_curate`)

`CARD.md` is what every future session sees first, so it must stay short and current.
After a burst of decisions - or when the card reports truncation - rewrite its two
hand-owned sections in one call:

    memory_curate purpose="<one paragraph: what this project is for, what done means>"
                 rules=["Use pnpm, never npm", "Deploys go to Fly sin", ...]

Rules are imperatives derived from the notes, most important first; six is plenty.
Omit `rules` to let the store synthesize a list from decision/preference/issue titles,
then refine whatever it produced. `dry_run=true` shows the result without writing.

Curation is a judgment step, not a log: drop rules that no longer hold, merge
duplicates, and state the constraint rather than the incident.

## Tidy the history (`memory_distill`)

The journal is narrative and grows forever. `memory_distill` rewrites each month's
short digest footer, writes `journal/YYYY-MM.digest.md` beside the raw log, and with
`promote=true` returns candidates (headline, bullet points, inferred type) that are
worth turning into notes:

    memory_distill promote=true

Promote the two or three blocks that changed how the project works; leave the rest as
history. Write each promotion with `memory_write`, citing the journal month in
`sources`. Re-running distillation is safe: it rewrites only generated digest content.

## Two axes of scope

- **Project notes** (default) answer questions about this repository.
- **Global files** (`memory_write kind="global" file="PREFERENCES.md"`) hold rules
  that apply everywhere; `LESSONS.md` holds transferable lessons. Promote a project
  note to a global rule only when it generalizes.

## Another project's memory

The store is one global directory. Use it deliberately:

- `memory_status` - discover other projects, their roots, and activity.
- `memory_search query="..." project="<slug>"` - search that project only.
- `memory_search query="..." project="all"` - search everything and see which
  project each hit came from.
- `memory_read path="projects/<slug>/MEMORY.md"` - read its index first, then notes.

Borrowing is normal (a shared library, the same deployment target, an earlier
attempt at the same problem). If the borrowed conclusion changes this project, copy
the conclusion into a note here with `sources` naming the origin.

## Hygiene

- The generated files (`MEMORY.md`, `CARD.md`, `catalog.jsonl`, `global/index.md`)
  are rebuilt by `memory_reindex`; hand edits belong in `pending.md`, notes, and the
  Purpose / Durable rules prose of `MEMORY.md`.
- Keep `CARD.md` short: it is the always-on card. Six rules and six pending items
  are plenty; longer means the card is not curating.
- If the store is empty for this project, do not invent history - write the first
  facts and pending list from what is actually true.
- Files are ordinary text: the user can read, diff, commit, and edit them. Prefer a
  format a human can maintain over one only the tool understands.