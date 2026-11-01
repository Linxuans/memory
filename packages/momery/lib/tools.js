/**
 * Model-facing memory tools. Each tool is a plain object accepted by
 * `ctx.tools.register`: raw JSON Schema for input, `output.schema` + `output.render`
 * for the canonical JSON value, and `execute(args, exec)` for the body.
 *
 * Every tool answers with bounded, pointer-bearing text. Deep content is read on
 * demand with memory_read, so recall never floods the context window.
 */

import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { slugify } from './note.js'
import {
  appendJournal,
  curateProject,
  discoverProjects,
  distillJournal,
  ensureGlobalFiles,
  ensureProject,
  loadRegistry,
  notesDir,
  patchNotes,
  readStoreFile,
  renderGlobalIndex,
  renderProject,
  reindexAll,
  resolveProjectRef,
  scanNotes,
  writeCatalog,
  writeNote,
} from './store.js'
import { search } from './search.js'

function text(value) {
  return [{ type: 'text', text: value }]
}

function storePath(root, rel) {
  const base = String(root).replace(/[\\\\/]+$/, '')
  const tail = String(rel).replace(/^[\\\\/]+/, '')
  return tail.length === 0 ? base : base + '/' + tail
}

function relPath(root, file) {
  return String(file).slice(String(root).replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/')
}

function allSlugs(root) {
  void discoverProjects
  return Object.keys(loadRegistry(root).records)
}

/** Resolve the current project for a call, registering it on first touch. */
function currentProject(root, info, ref) {
  if (ref && ref !== 'current') {
    const record = resolveProjectRef(root, ref)
    if (!record) throw new Error('unknown project reference "' + ref + '"; call memory_status to list known projects')
    ensureProject(root, { slug: record.slug, rootPath: record.root, name: record.name })
    return loadRegistry(root).records[record.slug]
  }
  ensureProject(root, { slug: info.slug, rootPath: info.rootPath, name: info.name, aliases: [info.name] })
  return loadRegistry(root).records[info.slug]
}

/** Existing note id whose normalized title matches, for duplicate detection on write. */
function findSameTitle(root, slug, title) {
  const wanted = String(title).trim().toLowerCase()
  for (const note of scanNotes(root, slug)) {
    if (note.title.trim().toLowerCase() === wanted) return note.id
  }
  return null
}

function renderHits(hits) {
  if (hits.length === 0) return '_No matching notes._'
  return hits
    .map((hit) => {
      const tags = hit.tags && hit.tags.length > 0 ? ' tags:' + hit.tags.join(',') : ''
      return (
        '- [' + hit.type + '] **' + hit.title + '** (' + hit.project + ')' + tags + ' score:' + hit.score + '\n' +
        '  ' + hit.excerpt + '\n' +
        '  memory_read path="' + hit.path + '"'
      )
    })
    .join('\n')
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readCard(root, slug) {
  try {
    return readStoreFile(root, 'projects/' + slug + '/CARD.md', 8000).text.trim()
  } catch {
    return ''
  }
}

function readPendingText(root, slug) {
  try {
    return readStoreFile(root, 'projects/' + slug + '/pending.md', 6000).text.trim()
  } catch {
    return '_no pending.md_'
  }
}

function pendingCount(root, slug) {
  return readPendingText(root, slug)
    .split(/\r?\n/)
    .filter((line) => /^[-*]\s+/.test(line.trim())).length
}

function journalMonths(root, slug) {
  try {
    return readdirSync(storePath(root, 'projects/' + slug + '/journal')).filter((name) => name.endsWith('.md')).length
  } catch {
    return 0
  }
}

/**
 * Build the tool definitions.
 * @param root the resolved store root
 * @param resolveAgent async (exec) => { slug, name, rootPath }
 */
export function buildTools(root, resolveAgent) {
  const tools = []

  tools.push({
    name: 'memory_brief',
    description:
      'Recall durable project memory before non-trivial work and after any context reset: the always-on card (purpose, rules, pending) plus ranked notes relevant to `query`. Bounded and cheap; safe to call at the start of every task.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What the task needs: entities, symptoms, module names, filenames.' },
        project: { type: 'string', description: 'Project slug, alias, or absolute path. Omit for the current session project.' },
        other_projects: { type: 'boolean', description: 'Also rank notes from other projects. Default false.' },
        limit: { type: 'integer', description: 'Maximum ranked notes. Default 6, capped at 12.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      const info = await resolveAgent(exec)
      const record = currentProject(root, info, args.project)
      const limit = Math.min(Math.max(args.limit ?? 6, 1), 12)
      const notes = scanNotes(root, record.slug)
      const hits = search(root, [record.slug], args.query ?? '', { limit })
      const otherSlugs = allSlugs(root).filter((slug) => slug !== record.slug)
      const otherHits = args.other_projects ? search(root, otherSlugs, args.query ?? '', { limit: 4 }) : []
      const card = readCard(root, record.slug)
      const lines = []
      lines.push('<memory project="' + record.slug + '" root="' + escapeAttr(record.root ?? '') + '" notes="' + notes.length + '">')
      lines.push(card || '_No card yet. Write notes, then call memory_reindex._')
      lines.push('')
      lines.push('## Relevant notes' + (args.query ? ' for "' + String(args.query).slice(0, 120) + '"' : ''))
      lines.push(renderHits(hits))
      if (otherHits.length > 0) {
        lines.push('')
        lines.push('## Borrowed from other projects')
        lines.push(renderHits(otherHits))
      }
      lines.push('')
      lines.push('## Memory protocol')
      lines.push('- deeper read: memory_read path="projects/' + record.slug + '/notes/<id>.md" (also MEMORY.md, pending.md, journal/YYYY-MM.md)')
      lines.push('- record knowledge: memory_write kind="note" title="..." type="decision|pattern|issue|fact|preference|task" tags=[...] content="..."')
      lines.push('- close a session: memory_end summary="..." notes=[{title,type,tags,content}]')
      lines.push('- keep the card sharp: memory_curate rules=[...] purpose="..." (omit rules to synthesize from notes)')
      lines.push('- tidy the history: memory_distill promote=true, then turn candidates into notes')
      lines.push('- another project: memory_search query="..." project="<slug>" or project="all"')
      lines.push('</memory>')
      lines.push('')
      lines.push(
        'store: ' +
          storePath(root, '') +
          ' | projects: ' + allSlugs(root).length +
          ' | this project journal: ' + journalMonths(root, record.slug) + ' month file(s)' +
          (notes.length === 0 ? ' | EMPTY - seed this project with memory_write' : ' | notes: ' + storePath(root, 'projects/' + record.slug + '/notes/')),
      )
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'memory_search',
    description:
      'Search durable memory lexically across one project, several projects, or every project. Returns ranked hits with excerpts and store-relative paths; follow up with memory_read for full text. This is the cross-project entry point.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, identifiers, error text, or a natural-language question.' },
        project: { type: 'string', description: 'Project slug, alias, path, or `all` / `*` for every project.' },
        projects: { type: 'array', items: { type: 'string' }, description: 'Several project references; overrides `project`.' },
        type: { type: 'array', items: { type: 'string' }, description: 'Restrict to note types, e.g. ["decision","issue"].' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Restrict to notes carrying at least one of these tags.' },
        limit: { type: 'integer', description: 'Maximum hits. Default 8, capped at 25.' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      if (typeof args.query !== 'string' || args.query.trim().length === 0) throw new Error('query must be a non-empty string')
      const info = await resolveAgent(exec)
      const limit = Math.min(Math.max(args.limit ?? 8, 1), 25)
      const refs = Array.isArray(args.projects) && args.projects.length > 0 ? args.projects : args.project ? [args.project] : []
      const slugs = []
      for (const ref of refs) {
        if (ref === 'all' || ref === '*') {
          slugs.push(...allSlugs(root))
          continue
        }
        const record = resolveProjectRef(root, ref)
        if (!record) throw new Error('unknown project reference "' + ref + '"; call memory_status to list known projects')
        slugs.push(record.slug)
      }
      if (slugs.length === 0) slugs.push(currentProject(root, info).slug)
      const uniqueSlugs = [...new Set(slugs)]
      const hits = search(root, uniqueSlugs, args.query, { limit, types: args.type, tags: args.tags })
      const lines = []
      lines.push('<memory_search query="' + escapeAttr(args.query.slice(0, 120)) + '" projects="' + uniqueSlugs.join(',') + '" hits="' + hits.length + '">')
      lines.push(renderHits(hits))
      lines.push('</memory_search>')
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'memory_read',
    description:
      'Read one memory file in full: a note, MEMORY.md, CARD.md, pending.md, a journal month, or a global file. Paths are store-relative exactly as returned by memory_brief / memory_search. Cross-project reads are allowed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Store-relative path, e.g. projects/f-work-momery/notes/2026-11-01-120000-ab12.md' },
        max_bytes: { type: 'integer', description: 'Byte cap. Default 24000, capped at 120000.' },
        offset: { type: 'integer', description: '1-based first line to return. Default 1.' },
        limit: { type: 'integer', description: 'Maximum lines to return. Default 400.' },
      },
      required: ['path'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      const maxBytes = Math.min(Math.max(args.max_bytes ?? 24000, 200), 120000)
      const { text: body, truncated, bytes } = readStoreFile(root, args.path.trim(), maxBytes)
      const lines = body.split(/\r?\n/)
      const offset = Math.max(args.offset ?? 1, 1)
      const limit = Math.min(Math.max(args.limit ?? 400, 1), 2000)
      const window = lines.slice(offset - 1, offset - 1 + limit)
      const endLine = offset - 1 + window.length
      const footer = [
        truncated ? '(byte cap reached: showing a prefix of ' + bytes + ' bytes)' : '',
        endLine < lines.length
          ? '(showing lines ' + offset + '-' + endLine + ' of ' + lines.length + '; pass offset=' + (endLine + 1) + ' to continue)'
          : '(end of file, ' + lines.length + ' lines)',
      ]
        .filter(Boolean)
        .join(' ')
      return '<path>' + args.path.trim() + '</path>\n<memory>\n' + window.join('\n') + '\n\n' + footer + '\n</memory>'
    },
  })

  tools.push({
    name: 'memory_write',
    description:
      'Write durable memory. kind="note" creates or updates one knowledge note; kind="pending" replaces the project pending list; kind="journal" appends a dated session block; kind="global" appends a rule to global/PREFERENCES.md or global/LESSONS.md. Use it whenever a fact, decision, or constraint should survive a context reset. One topic per note.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'pending', 'journal', 'global'], description: 'What to write. Default note.' },
        title: { type: 'string', description: 'Short specific title, e.g. "Web build uses Vite 6 and pnpm".' },
        type: { type: 'string', enum: ['fact', 'decision', 'pattern', 'issue', 'preference', 'task', 'observation', 'reference'], description: 'Note type. Default fact.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Retrieval tags: module names, technologies, symptoms.' },
        content: { type: 'string', description: 'Markdown body. For pending: the full list as bullets. For journal: the session block.' },
        id: { type: 'string', description: 'Existing note id to update instead of creating a new note.' },
        status: { type: 'string', enum: ['active', 'superseded', 'archived'], description: 'Use superseded when a newer note replaces this one.' },
        confidence: { type: 'number', description: '0..1 confidence. Default 0.8; use 0.5 for guesses.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Where this came from: file paths, URLs, session ids.' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Existing note ids this new note replaces; they are marked superseded and point at the new note.' },
        project: { type: 'string', description: 'Write into another project by slug or alias. Default: current project.' },
        file: { type: 'string', enum: ['PREFERENCES.md', 'LESSONS.md'], description: 'For kind=global.' },
        replace: { type: 'boolean', description: 'For kind=global: replace the file instead of appending. Default false.' },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      if (typeof args.content !== 'string' || args.content.trim().length === 0) throw new Error('content must be a non-empty string')
      const kind = args.kind ?? 'note'
      if (kind === 'global') {
        ensureGlobalFiles(root)
        const file = args.file === 'LESSONS.md' ? 'LESSONS.md' : 'PREFERENCES.md'
        const target = storePath(root, 'global/' + file)
        if (args.replace === true) writeFileSync(target, args.content.trim() + '\n', 'utf8')
        else appendFileSync(target, '\n- ' + args.content.trim().replace(/^\s*[-*]\s*/, '').replace(/\n+/g, ' ') + '\n', 'utf8')
        renderGlobalIndex(root)
        return 'wrote global/' + file + ' (' + target + '). Global rules apply to every project; the global index was refreshed.'
      }
      const info = await resolveAgent(exec)
      const record = currentProject(root, info, args.project)
      if (kind === 'journal') {
        const file = appendJournal(root, record.slug, args.content)
        renderProject(root, record.slug)
        return 'journaled to ' + relPath(root, file) + ' for project ' + record.slug + '. Call memory_end at session close to also distill notes.'
      }
      if (kind === 'pending') {
        writeFileSync(storePath(root, 'projects/' + record.slug + '/pending.md'), '# Pending\n\n' + args.content.trim() + '\n', 'utf8')
        const rendered = renderProject(root, record.slug)
        return 'pending list replaced for ' + record.slug + ' (' + rendered.pending + ' open items). CARD.md and MEMORY.md refreshed.'
      }
      const duplicate = !args.id && typeof args.title === 'string' ? findSameTitle(root, record.slug, args.title) : null
      const written = writeNote(root, record.slug, {
        id: args.id ? slugify(args.id) : undefined,
        title: args.title,
        type: args.type,
        status: args.status,
        tags: args.tags,
        confidence: typeof args.confidence === 'number' ? Math.min(Math.max(args.confidence, 0), 1) : undefined,
        body: args.content,
        sources: args.sources,
      })
      const replaced = Array.isArray(args.supersedes) ? patchNotes(root, record.slug, args.supersedes, { status: 'superseded', superseded_by: written.id }) : []
      const rendered = renderProject(root, record.slug)
      writeCatalog(root)
      const notes = []
      notes.push((written.created ? 'created' : 'updated') + ' note projects/' + record.slug + '/notes/' + written.id + '.md (' + (args.type ?? 'fact') + '; ' + rendered.notes + ' notes in project)')
      if (replaced.length > 0) notes.push('superseded: ' + replaced.join(', '))
      if (duplicate) notes.push('WARNING: a note with the same title already exists (' + duplicate + '). Pass id="' + duplicate + '" to revise it, or supersedes=["' + duplicate + '"] to replace it.')
      notes.push('index and card refreshed')
      return notes.join('. ').replace(/\\.\\. /g, '. ')
    },
  })

  tools.push({
    name: 'memory_status',
    description:
      'Inspect the memory store: known projects with roots and last activity, note and pending counts. Use it to discover another project, then memory_search project="<slug>".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'Show one project in detail by slug, alias, or path.' },
        scope: { type: 'string', enum: ['current', 'all'], description: 'Default current; all lists every project.' },
        pending: { type: 'boolean', description: 'Include open pending items.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      const info = await resolveAgent(exec)
      const registry = loadRegistry(root)
      const lines = []
      const current = currentProject(root, info)
      lines.push('current project: ' + current.slug + '  root: ' + (current.root ?? '?') + '  store: ' + storePath(root, ''))
      if (args.project) {
        const record = resolveProjectRef(root, args.project)
        if (!record) throw new Error('unknown project reference "' + args.project + '"')
        lines.push('')
        lines.push('# ' + record.slug + ' (' + record.name + ')')
        lines.push('root: ' + (record.root ?? '?') + '  aliases: ' + ((record.aliases ?? []).join(', ') || '-') + '  last active: ' + (record.lastActive ?? '-'))
        lines.push(readCard(root, record.slug) || '_no card yet_')
        if (args.pending) lines.push('', readPendingText(root, record.slug))
        return lines.join('\n')
      }
      const rows = []
      for (const slug of allSlugs(root)) {
        const record = registry.records[slug] ?? { slug, name: slug, root: null, aliases: [], lastActive: '' }
        rows.push({ slug, record, notes: scanNotes(root, slug).length, pending: pendingCount(root, slug) })
      }
      rows.sort((a, b) => String(b.record.lastActive ?? '').localeCompare(String(a.record.lastActive ?? '')))
      lines.push('')
      lines.push('# Projects (' + rows.length + ', newest activity first)')
      if (rows.length === 0) lines.push('_No projects recorded yet; the first memory_write creates one._')
      for (const row of rows) {
        lines.push('- ' + row.slug + '  notes:' + row.notes + '  pending:' + row.pending + '  last:' + (row.record.lastActive ?? '-') + '  root:' + (row.record.root ?? '?'))
      }
      lines.push('')
      lines.push('global rules: ' + storePath(root, 'global/PREFERENCES.md') + ' , ' + storePath(root, 'global/LESSONS.md'))
      lines.push('cross-project read: memory_search query="..." project="all"  |  memory_read path="projects/<slug>/MEMORY.md"')
      if (args.pending) for (const row of rows) lines.push('', '## ' + row.slug, readPendingText(root, row.slug))
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'memory_end',
    description:
      'Close a working session: append a dated journal block and, when durable knowledge emerged, create or update the notes for it in one call. This is how a conversation survives compaction and how the next session starts warm.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'What was done, what changed, what is left.' },
        notes: {
          type: 'array',
          description: 'Durable knowledge to persist. Omit when the session produced nothing worth keeping.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: 'Short specific title.' },
              type: { type: 'string', enum: ['fact', 'decision', 'pattern', 'issue', 'preference', 'task', 'observation', 'reference'] },
              tags: { type: 'array', items: { type: 'string' } },
              content: { type: 'string', description: 'Markdown body: context, decision, consequences.' },
              id: { type: 'string', description: 'Update an existing note by id instead of creating one.' },
            },
            required: ['title', 'content'],
          },
        },
        pending: { type: 'array', items: { type: 'string' }, description: 'Replace the project pending list with these open items.' },
        project: { type: 'string', description: 'Target project slug or alias. Default: current project.' },
      },
      required: ['summary'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      if (typeof args.summary !== 'string' || args.summary.trim().length === 0) throw new Error('summary must be a non-empty string')
      const info = await resolveAgent(exec)
      const record = currentProject(root, info, args.project)
      const journalFile = appendJournal(root, record.slug, args.summary)
      const writtenIds = []
      for (const note of Array.isArray(args.notes) ? args.notes : []) {
        if (!note || typeof note.title !== 'string' || typeof note.content !== 'string') continue
        const written = writeNote(root, record.slug, {
          id: note.id ? slugify(note.id) : undefined,
          title: note.title,
          type: note.type,
          tags: note.tags,
          body: note.content,
          sources: ['journal ' + basename(journalFile)],
        })
        writtenIds.push(written.id)
      }
      if (Array.isArray(args.pending)) {
        const body = args.pending.length > 0 ? args.pending.map((item) => '- ' + String(item).trim()).join('\n') : '_Nothing pending._'
        writeFileSync(storePath(root, 'projects/' + record.slug + '/pending.md'), '# Pending\n\n' + body + '\n', 'utf8')
      }
      const rendered = renderProject(root, record.slug)
      writeCatalog(root)
      renderGlobalIndex(root)
      return (
        'session recorded for ' + record.slug + ': journal ' + relPath(root, journalFile) +
        ', notes written ' + writtenIds.length + ' (' + rendered.notes + ' total), pending ' + rendered.pending + '. Card and indexes refreshed.'
      )
    },
  })

  tools.push({
    name: 'memory_curate',
    description:
      'Curate the always-on surface: write the project purpose and the durable rule list into MEMORY.md, then rebuild CARD.md. Pass rules you derived from notes (or omit rules to synthesize a compact list from decisions, preferences, and issues) so the card states what matters instead of accumulating. Use it after a burst of decisions, or when CARD.md reports truncation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'Project slug or alias. Default: current project.' },
        purpose: { type: 'string', description: 'One-paragraph purpose, replacing the Purpose section.' },
        rules: { type: 'array', items: { type: 'string' }, description: 'Durable rules, most important first. Omit to synthesize from notes.' },
        max_decisions: { type: 'integer', description: 'When synthesizing: decisions to include. Default 5, capped at 8.' },
        max_preferences: { type: 'integer', description: 'When synthesizing: preferences to include. Default 3, capped at 5.' },
        dry_run: { type: 'boolean', description: 'Show what would be written without writing. Default false.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      const info = await resolveAgent(exec)
      const record = currentProject(root, info, args.project)
      const notes = scanNotes(root, record.slug)
      const existing = readCard(root, record.slug)
      const rules = Array.isArray(args.rules) ? args.rules.map((rule) => String(rule).trim()).filter(Boolean) : []
      let synthesized = false
      if (!Array.isArray(args.rules)) {
        synthesized = true
        const maxDecisions = Math.min(Math.max(args.max_decisions ?? 5, 1), 8)
        const maxPreferences = Math.min(Math.max(args.max_preferences ?? 3, 1), 5)
        const decisions = notes.filter((note) => note.type === 'decision').slice(0, maxDecisions)
        const preferences = notes.filter((note) => note.type === 'preference').slice(0, maxPreferences)
        const issues = notes.filter((note) => note.type === 'issue').slice(0, 2)
        for (const note of decisions) rules.push(note.title)
        for (const note of preferences) rules.push(note.title)
        for (const note of issues) rules.push('Gotcha: ' + note.title)
      }
      if (args.dry_run === true) {
        return (
          '<memory_curate project="' + record.slug + '" dry_run="true">\n' +
          'purpose: ' + (typeof args.purpose === 'string' && args.purpose.trim().length > 0 ? args.purpose.trim() : '(unchanged)') + '\n' +
          'rules (' + rules.length + '):\n' + (rules.length > 0 ? rules.map((rule) => '- ' + rule).join('\n') : '_none_') + '\n' +
          'current card:\n' + (existing || '_none_') + '\n</memory_curate>'
        )
      }
      const rendered = curateProject(root, record.slug, { purpose: args.purpose, rules })
      writeCatalog(root)
      return (
        'curated ' + record.slug + ': ' + rules.length + ' rule(s)' + (synthesized ? ' synthesized from notes' : '') +
        ', purpose ' + (typeof args.purpose === 'string' && args.purpose.trim().length > 0 ? 'updated' : 'unchanged') +
        '. Wrote ' + relPath(root, rendered.memoryFile) + ' and CARD.md. Call memory_brief to see the new card.'
      )
    },
  })

  tools.push({
    name: 'memory_distill',
    description:
      'Distill the session journal: rewrite each month\'s short digest footer, write journal/YYYY-MM.digest.md beside the raw log, and optionally return promotion candidates (headline, bullet points, inferred type) for notes that deserve to become durable. Run it when the journal grows or before closing a long project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'Project slug or alias. Default: current project.' },
        write: { type: 'boolean', description: 'Write digest files and footers. Default true; false only reports.' },
        promote: { type: 'boolean', description: 'Return candidate points to promote into notes. Default false.' },
        limit: { type: 'integer', description: 'Maximum promotion candidates. Default 10, capped at 30.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}, exec) {
      const info = await resolveAgent(exec)
      const record = currentProject(root, info, args.project)
      const outcome = distillJournal(root, record.slug, { write: args.write !== false, promote: args.promote === true })
      if (args.write !== false) renderProject(root, record.slug)
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 30)
      const lines = []
      lines.push('<memory_distill project="' + record.slug + '" months="' + outcome.months.length + '" candidates="' + Math.min(outcome.candidates.length, limit) + '">')
      if (outcome.months.length === 0) lines.push('_No journal months yet._')
      for (const month of outcome.months) {
        lines.push('- ' + month.month + ': ' + month.sessions + ' session(s)' + (args.write !== false ? ' -> journal/' + month.month + '.digest.md' : ''))
      }
      if (args.promote === true && outcome.candidates.length > 0) {
        lines.push('')
        lines.push('## Promotion candidates (turn these into notes with memory_write)')
        for (const candidate of outcome.candidates.slice(0, limit)) {
          lines.push('- [' + candidate.type + '] ' + candidate.stamp + ' - ' + candidate.headline)
          for (const point of candidate.points) lines.push('  - ' + point)
        }
      }
      lines.push('</memory_distill>')
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'memory_reindex',
    description:
      'Rebuild the generated indexes (MEMORY.md and CARD.md per project, the global index, catalog.jsonl) after hand-editing memory files. Cheap and safe to run any time.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'Reindex one project only. Default: every project.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(String(value)),
    },
    async execute(args = {}) {
      if (args.project) {
        const record = resolveProjectRef(root, args.project)
        if (!record) throw new Error('unknown project reference "' + args.project + '"')
        const rendered = renderProject(root, record.slug)
        writeCatalog(root)
        renderGlobalIndex(root)
        return 'reindexed ' + record.slug + ': ' + rendered.notes + ' notes, ' + rendered.pending + ' pending; wrote ' + relPath(root, rendered.memoryFile) + ' and CARD.md'
      }
      const outcome = reindexAll(root)
      return 'reindexed ' + outcome.projects.length + ' projects (' + outcome.catalog.notes + ' notes); global index ' + relPath(root, outcome.global.file) + ', catalog ' + relPath(root, outcome.catalog.file)
    },
  })

  return tools
}