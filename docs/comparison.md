# Prior art and what momery borrows

Written 2026-11-01 after a survey of agent-memory systems. Links are the load-bearing
sources; star counts were read the same day and will drift.

## The systems that matter

**Claude Code auto memory + CLAUDE.md** - the closest sibling. `CLAUDE.md` files are
concatenated root-first into context, `@path` imports expand eagerly (so imports organize
but do not save context), and subdirectory files load on first read/write in that subtree.
Auto memory adds `~/.claude/projects/<project>/memory/`: a `MEMORY.md` index truncated to
the first 200 lines or 25KB, one topic file per memory, frontmatter `type:` of
`user|feedback|project|reference`, read on demand with ordinary file tools. The project
`CLAUDE.md` is re-read and re-injected after `/compact`.
[mode.claude.com/docs/en/memory.md](https://code.claude.com/docs/en/memory.md)

What momery borrows: index + one-topic-file layering, a hard byte budget, frontmatter
typing, on-demand reads, and the "re-attach after compaction" idea (realized here as a
per-step prompt section instead of a hook).

**Anthropic memory tool `memory_20250818`** - the canonical directory-memory command set:
`view{path,view_range}`, `create{path,file_text}`, `str_replace{path,old_str,new_str}`,
`insert{path,insert_line,insert_text}`, `delete{path}`, `rename{old_path,new_path}`, over a
client-side `/memories` prefix with mandatory path-traversal protection.
[platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

What momery borrows: files as the unit of truth, a small fixed command vocabulary, and
path containment. What it adds: typed notes, ranking, and cross-project addressing, which a
raw filesystem tool cannot express.

**Agent Skills progressive disclosure** - discovery exposes only name + description;
activation reads `SKILL.md`; execution loads `references/`, `scripts/`, `assets/` only if
needed. The published caveat is honest: the description listing itself is a per-turn tax.
[agentskills.io](https://agentskills.io/home) -
[code.claude.com/docs/en/skills.md](https://code.claude.com/docs/en/skills.md)

What momery borrows: the `momery` skill is the protocol, loaded only when the model wants
it; the tools work without it.

**Cline memory bank** - six fixed Markdown files (`projectbrief`, `productContext`,
`activeContext`, `systemPatterns`, `techContext`, `progress`) maintained by ritual prompts.
Zero infrastructure, all discipline. [docs.cline.bot/best-practices/memory-bank](https://docs.cline.bot/best-practices/memory-bank)

What momery borrows: the card (`CARD.md`) is the `activeContext` idea with a byte budget;
what it rejects: six hand-maintained files with no retrieval, which rot silently.

**Cursor rules** - `.cursor/rules/*.mdc` with frontmatter `{description, globs,
alwaysApply}` selecting one of four activation modes (always, agent-decided by
description, path match, explicit mention). [cursor.com/docs/rules](https://cursor.com/docs/rules)

What momery borrows: scope predicates exist in the skill's `whenToUse` and in tags; the
project slug is the scope key.

**MCP memory server (reference implementation)** - `create_entities`, `create_relations`,
`add_observations`, `delete_entities`, `delete_observations`, `delete_relations`,
`read_graph`, `search_nodes`, `open_nodes`, plus a `memory://knowledge-graph` resource.
Storage is JSONL (`memory.jsonl`), one entity or relation per line, atomic save, an
exclusive `<file>.lock` with a 30s stale break and 60s timeout.
[README](https://unpkg.com/@modelcontextprotocol/server-memory@2.0.1/README.md)

What momery borrows: the lock protocol verbatim (`withLock`), and JSONL as a
machine-readable sidecar (`catalog.jsonl`). What it rejects: `read_graph`, a context-bomb
with no page cap, and a graph as the only structure, since most project knowledge is
hierarchical prose rather than entities and edges.

**claude-mem** - hooks capture sessions, an AI compresses them into observations, and
retrieval is three-tiered: `search` returns a compact index with ids (tens of tokens per
hit), then `timeline`, then `get_observations(ids)` for full text. The clearest published
"filter before fetch" contract. [docs.claude-mem.ai](https://docs.claude-mem.ai/)

What momery borrows: the three-tier shape (`memory_search` excerpt then `memory_read`
full), and the lesson that the compact index is what makes "no context until needed"
real. What it rejects: mandatory AI compression and SQLite + vector infrastructure, which
turn every write into a model call and lose exact strings.

**Others surveyed, not adopted:** mem0 (vector + optional graph), cognee, Graphiti/Zep
(bi-temporal knowledge graph on Neo4j or FalkorDB - the `valid_from`/`valid_until`
fields here are a two-field echo of that idea), supermemory, Letta/MemGPT (memory blocks +
archival + sleep-time compute), txtai, claude-context (vector code search, not durable
memory), basic-memory (Markdown-as-truth + SQLite index - closest to this design, but
AGPL-3.0 blocks reuse), memobase, mcp-memory-service (consolidation and a token-budgeted
bootstrap profile), MemoryOS, A-MEM. In the Chinese ecosystem, TencentDB-Agent-Memory and
MemTensor/MemOS are the notable ones.

## Reuse versus build

Reused ideas: the memory-tool command vocabulary (read/write/delete/rename over a
directory), index + topic-file layering with a hard budget, index -> detail retrieval, the
lock/atomic-save protocol, `sources` provenance, `schema_version`, and supersession.

Built here, because no surveyed project does them well: a cross-project catalog with
one-line addressing and explicit cross-reads; a bounded always-on prompt section that
survives compaction without a hook; deterministic lexical ranking that needs no model
call and works offline; and a single plain-text store that an agent and a human can both
operate.

## What the survey changed in this implementation

- `schema_version` in frontmatter, so a format change is detectable.
- `valid_from` / `valid_until` and `superseded_by`, so stale facts lose to fresh ones
  and default recall skips them.
- `supersedes` on write: the new note marks its predecessors superseded in one call.
- Duplicate-title detection on write, with the exact `id=` retry, instead of silent sprawl.
- A loud card budget: exceeding it raises with the project and the fix, rather than
  silently truncating the always-on surface.
- Lock files with a 30s stale break around every read-modify-write, so two agents cannot
  lose an update.
- Cross-project reads gated behind an explicit tool call (`project="all"` or a slug),
  never injected by default, because another repository's text is untrusted input.

## Known gaps

- Lexical recall misses paraphrases. The fix is better titles, tags, and aliases before it
  is embeddings; `catalog.jsonl` is the seam if an external index is ever wanted.
- The journal is append-only and never compacted, so it grows. Month sharding keeps reads
  cheap; a `journal` distillation pass is future work.
- No CRDT: concurrent edits to the same note serialize on the lock, but a stale reader can
  still overwrite a newer write. Per-note content hashing would detect that.