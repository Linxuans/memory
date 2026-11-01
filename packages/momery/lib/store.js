/**
 * The momery store: filesystem layout, project registry, note scan cache, and the
 * generated indexes (MEMORY.md, CARD.md, catalog.jsonl, index.json).
 *
 * Everything here is plain Node built-ins and plain text on disk. No database, no
 * embeddings, no network: the store must stay inspectable, greppable, and git-able.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { firstHeading, newId, parseNote, projectSlug, serializeNote, slugify, stamp } from './note.js'

export const STORE_README = `# momery - durable, project-scoped agent memory

Human-editable plain text. Every file is Markdown or JSON, sized for a diff.

    global/
      PREFERENCES.md      user-wide preferences and working rules
      LESSONS.md          cross-project lessons learned
      index.md            generated global index
    projects/<slug>/
      MEMORY.md           generated index - the entry point a human or agent reads
      CARD.md             <=40 line always-on card (purpose, rules, pending, pointers)
      notes/              durable knowledge: one topic per file
      journal/YYYY-MM.md  append-only session log
      pending.md          open questions / next actions
    index.json            project registry: slug -> root path, aliases, last activity
`

const CARD_MAX_LINES = 40
const CARD_MAX_CHARS = 2400

/** Resolve the store root from config, env, or the home directory, and create its skeleton. */
export function resolveRoot(configured) {
  const candidate = configured ?? process.env.MOMERY_ROOT ?? join(homedir(), '.momery')
  const root = isAbsolute(candidate) ? candidate : resolve(candidate)
  mkdirSync(join(root, 'projects'), { recursive: true })
  mkdirSync(join(root, 'global'), { recursive: true })
  const readme = join(root, 'README.md')
  if (!existsSync(readme)) writeFileSync(readme, STORE_README, 'utf8')
  return root
}

/** Absolute path must stay inside the store root. */
export function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('refusing to touch a path outside the memory store: ' + target)
  }
  return target
}

export function projectDir(root, slug) {
  return join(root, 'projects', slug)
}

export function notesDir(root, slug) {
  return join(projectDir(root, slug), 'notes')
}

export function journalDir(root, slug) {
  return join(projectDir(root, slug), 'journal')
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 60_000
const LOCK_RETRY_MS = 25

/**
 * Run `work` under an exclusive lock directory, so two agents writing the same store
 * cannot interleave a read-modify-write. A lock older than 30s is presumed abandoned
 * (the protocol MCP's reference memory server uses); waiting more than 60s fails loud.
 */
export function withLock(target, work) {
  const lockPath = target + '.lock'
  mkdirSync(dirname(target), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lockPath)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
      } catch {
        stale = true
      }
      if (stale) {
        try {
          rmdirSync(lockPath)
        } catch {
          /* another writer broke it first */
        }
        continue
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('memory store is locked by another writer: ' + lockPath)
      const until = Date.now() + LOCK_RETRY_MS
      while (Date.now() < until) {
        /* short spin; the critical sections are single file writes */
      }
    }
  }
  try {
    return work()
  } finally {
    try {
      rmdirSync(lockPath)
    } catch {
      /* already gone */
    }
  }
}

/** The project registry. `records` is keyed by slug. */
export function loadRegistry(root) {
  const data = readJson(join(root, 'index.json'), null)
  if (data && typeof data === 'object' && data.records && typeof data.records === 'object') return data
  return { version: 1, records: {} }
}

export function saveRegistry(root, registry) {
  const target = join(root, 'index.json')
  withLock(target, () => writeJson(target, registry))
}

/**
 * Register (or refresh) one project. Records the real root path, a display name, an
 * alias list, and activity timestamps; no filesystem names are trusted beyond the slug.
 */
export function touchProject(root, { slug, rootPath, name, aliases }) {
  const registry = loadRegistry(root)
  const now = stamp()
  const previous = registry.records[slug]
  registry.records[slug] = {
    slug,
    name: name ?? previous?.name ?? nameOf(rootPath, slug),
    root: rootPath ?? previous?.root ?? null,
    aliases: unique([...(previous?.aliases ?? []), ...(aliases ?? [])]),
    created: previous?.created ?? now,
    lastActive: now,
    sessions: (previous?.sessions ?? 0) + (previous ? 0 : 1),
  }
  saveRegistry(root, registry)
  return registry.records[slug]
}

function nameOf(rootPath, slug) {
  if (!rootPath) return slug
  const parts = String(rootPath).replace(/\\/g, '/').replace(/\/+$/g, '').split('/')
  return parts[parts.length - 1] || slug
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0))]
}

/** Create the per-project skeleton on first use. Returns true when it created something. */
export function ensureProject(root, { slug, rootPath, name, aliases }) {
  let created = false
  for (const dir of [projectDir(root, slug), notesDir(root, slug), journalDir(root, slug)]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      created = true
    }
  }
  const memoryFile = join(projectDir(root, slug), 'MEMORY.md')
  if (!existsSync(memoryFile)) {
    writeFileSync(memoryFile, projectTemplate(name ?? nameOf(rootPath, slug), rootPath), 'utf8')
    created = true
  }
  const pendingFile = join(projectDir(root, slug), 'pending.md')
  if (!existsSync(pendingFile)) {
    writeFileSync(pendingFile, '# Pending\n\nOpen questions and next actions. One bullet each; close them by editing this file.\n', 'utf8')
    created = true
  }
  touchProject(root, { slug, rootPath, name, aliases })
  return created
}

function projectTemplate(name, rootPath) {
  return [
    '# ' + name + ' - project memory',
    '',
    'Root: `' + (rootPath ?? '(unknown)') + '`',
    '',
    'Generated index. Do not hand-edit the tables below; run memory_reindex after editing notes.',
    '',
    '## Purpose',
    '',
    'What this project is for, who it serves, and what "done" means. Keep it to a paragraph.',
    '',
    '## Durable rules',
    '',
    '- Rules that must survive a context reset: stack, conventions, forbidden shortcuts.',
    '',
    '## Notes',
    '',
    '_No notes yet._',
    '',
    '## Pending',
    '',
    '_Nothing pending._',
    '',
  ].join('\n')
}

/**
 * Walk `notes/` and return every parseable note with its file metadata. The cache is
 * keyed by absolute path and invalidated by mtime+size, so a scan costs one stat per
 * file after the first call and cross-project search stays cheap.
 */
const scanCache = new Map()

export function scanNotes(root, slug) {
  const dir = notesDir(root, slug)
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  const notes = []
  for (const entry of entries) {
    const file = join(dir, entry.name)
    let stats
    try {
      stats = statSync(file)
    } catch {
      continue
    }
    const cacheKey = file
    const cached = scanCache.get(cacheKey)
    let note
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      note = cached.note
    } else {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const { data, body } = parseNote(text)
      note = {
        id: typeof data.id === 'string' && data.id.length > 0 ? data.id : entry.name.replace(/\.md$/, ''),
        title: typeof data.title === 'string' && data.title.length > 0 ? data.title : firstHeading(body) || entry.name.replace(/\.md$/, ''),
        type: typeof data.type === 'string' ? data.type : 'fact',
        status: typeof data.status === 'string' ? data.status : 'active',
        scope: typeof data.scope === 'string' ? data.scope : 'project',
        project: slug,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.8,
        created: typeof data.created === 'string' ? data.created : '',
        updated: typeof data.updated === 'string' ? data.updated : '',
        sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
        relations: Array.isArray(data.relations) ? data.relations.map(String) : [],
        body,
        path: file,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        name: entry.name,
      }
      scanCache.set(cacheKey, { size: stats.size, mtimeMs: stats.mtimeMs, note })
    }
    if (note.status !== 'archived') notes.push(note)
  }
  return notes.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.title.localeCompare(b.title))
}

/** All known project slugs on disk, whether or not the registry knows them. */
export function discoverProjects(root) {
  const dir = join(root, 'projects')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

/** Resolve a user-supplied project reference: slug, alias, display name, or absolute path. */
export function resolveProjectRef(root, ref) {
  const registry = loadRegistry(root)
  if (!ref || ref === 'current') return null
  const wanted = String(ref).trim()
  const direct = registry.records[wanted]
  if (direct) return direct
  const lower = wanted.toLowerCase()
  for (const record of Object.values(registry.records)) {
    if (record.slug.toLowerCase() === lower) return record
    if (String(record.name ?? '').toLowerCase() === lower) return record
    if ((record.aliases ?? []).some((alias) => String(alias).toLowerCase() === lower)) return record
  }
  const asPath = projectSlug(wanted)
  if (registry.records[asPath]) return registry.records[asPath]
  if (discoverProjects(root).includes(asPath)) return { slug: asPath, name: asPath, root: null, aliases: [] }
  return null
}

/** Write one note. `id` is the filename stem, so the file is `notes/<id>.md`. */
export function writeNote(root, slug, { id, title, type, status, tags, confidence, body, sources, relations, validUntil }) {
  const dir = notesDir(root, slug)
  mkdirSync(dir, { recursive: true })
  const noteId = id ?? newId()
  const file = safeJoin(root, 'projects', slug, 'notes', noteId + '.md')
  const now = stamp()
  const existing = existsSync(file) ? parseNote(readFileSync(file, 'utf8')) : { data: {}, body: '' }
  const data = {
    schema_version: 2,
    id: noteId,
    title: title ?? existing.data.title ?? firstHeading(body) ?? noteId,
    type: type ?? existing.data.type ?? 'fact',
    status: status ?? existing.data.status ?? 'active',
    scope: 'project',
    project: slug,
    tags: tags ?? existing.data.tags ?? [],
    confidence: confidence ?? existing.data.confidence ?? 0.8,
    valid_from: existing.data.valid_from ?? now,
    valid_until: validUntil ?? existing.data.valid_until,
    created: existing.data.created ?? now,
    updated: now,
    sources: sources ?? existing.data.sources ?? [],
    relations: relations ?? existing.data.relations ?? [],
  }
  withLock(file, () => writeFileSync(file, serializeNote(data, body ?? existing.body), 'utf8'))
  scanCache.delete(file)
  return { id: noteId, path: file, created: existing.data.created === undefined }
}

/** Append one dated block to this month's journal. */
export function appendJournal(root, slug, text) {
  const dir = journalDir(root, slug)
  mkdirSync(dir, { recursive: true })
  const now = new Date()
  const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
  const file = safeJoin(root, 'projects', slug, 'journal', month + '.md')
  const block = '\n## ' + stamp(now) + '\n\n' + String(text).trim() + '\n'
  withLock(file, () => {
    if (!existsSync(file)) writeFileSync(file, '# Journal ' + month + '\n', 'utf8')
    writeFileSync(file, block, { encoding: 'utf8', flag: 'a' })
  })
  return file
}

/** Update the frontmatter of existing project notes, under their own locks. */
export function patchNotes(root, slug, ids, patch) {
  const touched = []
  for (const rawId of ids) {
    const noteId = String(rawId ?? '').trim()
    if (!/^[A-Za-z0-9._-]+$/.test(noteId)) continue
    const file = safeJoin(root, 'projects', slug, 'notes', noteId + '.md')
    if (!existsSync(file)) continue
    const current = parseNote(readFileSync(file, 'utf8'))
    const data = { ...current.data, ...patch, updated: stamp() }
    withLock(file, () => writeFileSync(file, serializeNote(data, current.body), 'utf8'))
    scanCache.delete(file)
    touched.push(noteId)
  }
  return touched
}

/** Read a store-relative path with a byte cap. */
export function readStoreFile(root, relPath, maxBytes) {
  const file = safeJoin(root, relPath)
  const stats = statSync(file)
  if (!stats.isFile()) throw new Error('not a regular file: ' + relPath)
  const raw = readFileSync(file, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return { text: raw, truncated: false, bytes: stats.size, path: file }
  return { text: raw.slice(0, maxBytes), truncated: true, bytes: stats.size, path: file }
}

/** Regenerate MEMORY.md and CARD.md for one project. */
export function renderProject(root, slug) {
  const registry = loadRegistry(root)
  const record = registry.records[slug] ?? { slug, name: slug, root: null, aliases: [] }
  const notes = scanNotes(root, slug)
  const pendingText = readTextIfExists(join(projectDir(root, slug), 'pending.md'))
  const pending = pendingBullets(pendingText)
  const journal = recentJournal(root, slug, 6)
  const byType = groupBy(notes, (note) => note.type)
  const memoryFile = join(projectDir(root, slug), 'MEMORY.md')
  const handEdited = readTextIfExists(memoryFile)
  const purpose = extractPurpose(handEdited)
  const rules = extractRules(handEdited)

  const lines = []
  lines.push('# ' + (record.name ?? slug) + ' - project memory', '')
  lines.push('- slug: `' + slug + '`')
  lines.push('- root: `' + (record.root ?? '(unknown)') + '`')
  if ((record.aliases ?? []).length > 0) lines.push('- aliases: ' + record.aliases.map((alias) => '`' + alias + '`').join(', '))
  lines.push('- last active: ' + (record.lastActive ?? '-') + '   notes: ' + notes.length + '   pending: ' + pending.length, '')
  lines.push('> Generated index. Keep hand-written prose in the Purpose and Durable rules sections;')
  lines.push('> the tables are rebuilt by memory_reindex. Detailed knowledge lives in `notes/`,')
  lines.push('> session history in `journal/`.', '')
  lines.push('## Purpose', '', purpose || '_Describe what this project is for, who it serves, and what done means._', '')
  lines.push('## Durable rules', '', rules.length > 0 ? rules.map((rule) => '- ' + rule).join('\n') : '- _Stack, conventions, forbidden shortcuts._', '')
  lines.push('## Notes by type', '')
  for (const type of Object.keys(byType).sort()) {
    lines.push('### ' + type, '')
    for (const note of byType[type]) {
      const tags = note.tags.length > 0 ? ' `' + note.tags.join('`, `') + '`' : ''
      lines.push('- [' + note.title + '](notes/' + note.id + '.md) - ' + summarize(note.body) + tags + ' _(' + (note.updated || note.created || '-') + ')_')
    }
    lines.push('')
  }
  if (notes.length === 0) lines.push('_No notes yet._', '')
  lines.push('## Pending', '')
  lines.push(pending.length > 0 ? pending.map((item) => '- ' + item).join('\n') : '_Nothing pending._', '')
  lines.push('## Recent journal', '')
  lines.push(journal.length > 0 ? journal.map((item) => '- ' + item).join('\n') : '_No sessions recorded yet._', '')

  const memoryText = lines.join('\n')
  const cardText = buildCard(record, notes, pending, purpose, rules, slug)
  const cardFile = join(projectDir(root, slug), 'CARD.md')
  withLock(memoryFile, () => writeFileSync(memoryFile, memoryText, 'utf8'))
  withLock(cardFile, () => writeFileSync(cardFile, cardText, 'utf8'))
  return { memoryFile, cardFile, notes: notes.length, pending: pending.length }
}

function buildCard(record, notes, pending, purpose, rules, slug) {
  const lines = []
  lines.push('# MEMORY CARD - ' + (record.name ?? record.slug))
  lines.push('project: `' + record.slug + '`  root: `' + (record.root ?? '?') + '`  active: ' + (record.lastActive ?? '-'))
  if (purpose) lines.push('', 'purpose: ' + oneLine(purpose))
  if (rules.length > 0) {
    lines.push('', 'rules:')
    for (const rule of rules.slice(0, 6)) lines.push('- ' + oneLine(rule))
  }
  if (pending.length > 0) {
    lines.push('', 'pending:')
    for (const item of pending.slice(0, 6)) lines.push('- ' + oneLine(item))
  }
  const recent = notes.slice(0, 8)
  if (recent.length > 0) {
    lines.push('', 'key notes:')
    for (const note of recent) {
      lines.push('- [' + note.type + '] ' + note.title + ' -> notes/' + note.id + '.md')
    }
  }
  lines.push('', 'more: MEMORY.md (index) | notes/ (knowledge) | journal/ (history)')
  const full = lines.join('\n')
  if (lines.length <= CARD_MAX_LINES && full.length <= CARD_MAX_CHARS) return full + '\n'
  const notice =
    'CARD TRUNCATED: ' + lines.length + ' lines / ' + full.length + ' chars exceeded the ' + CARD_MAX_LINES +
    '-line, ' + CARD_MAX_CHARS + '-char budget. Curate pending.md and the Purpose / Durable rules of MEMORY.md, or archive stale notes.'
  const kept = []
  let chars = 0
  for (const line of lines) {
    if (kept.length >= CARD_MAX_LINES - 2 || chars + line.length > CARD_MAX_CHARS) break
    kept.push(line)
    chars += line.length + 1
  }
  return kept.join('\n') + '\n\n! ' + notice + '\n'
}



/** Global index across every project, plus the global rules files. */
export function renderGlobalIndex(root) {
  const registry = loadRegistry(root)
  const lines = ['# momery - global index', '', 'Generated. One row per project, newest activity first.', '']
  lines.push('| slug | name | root | notes | last active |')
  lines.push('| --- | --- | --- | --- | --- |')
  const rows = []
  for (const slug of [...new Set([...Object.keys(registry.records), ...discoverProjects(root)])]) {
    const record = registry.records[slug] ?? { slug, name: slug, root: null, aliases: [], lastActive: '' }
    rows.push({ slug, record, notes: scanNotes(root, slug).length })
  }
  rows.sort((a, b) => String(b.record.lastActive ?? '').localeCompare(String(a.record.lastActive ?? '')))
  for (const row of rows) {
    lines.push('| ' + row.slug + ' | ' + (row.record.name ?? '') + ' | `' + (row.record.root ?? '') + '` | ' + row.notes + ' | ' + (row.record.lastActive ?? '') + ' |')
  }
  lines.push('', '## Global files', '', '- [PREFERENCES.md](PREFERENCES.md) - user-wide preferences and working rules', '- [LESSONS.md](LESSONS.md) - cross-project lessons', '')
  const file = join(root, 'global', 'index.md')
  withLock(file, () => writeFileSync(file, lines.join('\n'), 'utf8'))
  return { file, projects: rows.length }
}

export function ensureGlobalFiles(root) {
  const preferences = join(root, 'global', 'PREFERENCES.md')
  if (!existsSync(preferences)) {
    writeFileSync(
      preferences,
      [
        '# PREFERENCES - user-wide',
        '',
        'Applies to every project. Keep it short and imperative; each bullet is a rule an agent should follow.',
        '',
        '- Prefer the user\'s language for prose and English for code identifiers.',
        '- Prefer plain text, inspectable artifacts over opaque stores.',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  const lessons = join(root, 'global', 'LESSONS.md')
  if (!existsSync(lessons)) {
    writeFileSync(
      lessons,
      [
        '# LESSONS - cross-project',
        '',
        'One bullet per transferable lesson: what happened, what to do next time. Promote a project note here once it generalizes.',
        '',
      ].join('\n'),
      'utf8',
    )
  }
}

function readTextIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function extractPurpose(text) {
  const section = extractSection(text, 'Purpose')
  const cleaned = section.replace(/^_.*_$/gm, '').trim()
  return /^What this project is for/i.test(cleaned) ? '' : cleaned
}

function extractRules(text) {
  const section = extractSection(text, 'Durable rules')
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length > 0 && !/^_.*_$/.test(line) && !/^Rules that must survive/i.test(line))
}

function extractSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp('^#{1,6}\\s+' + heading + '\\s*$', 'i').test(line.trim()))
  if (start === -1) return ''
  const out = []
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,6}\s+/.test(lines[index])) break
    out.push(lines[index])
  }
  return out.join('\n').trim()
}

function pendingBullets(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => /^[-*]\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1].trim())
    .filter((line) => line.length > 0 && !/^Nothing pending/i.test(line))
}

function recentJournal(root, slug, limit) {
  const dir = journalDir(root, slug)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((name) => name.endsWith('.md')).sort().reverse()
  const entries = []
  for (const name of files) {
    const text = readTextIfExists(join(dir, name))
    for (const line of text.split(/\r?\n/)) {
      const match = /^##\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s*$/.exec(line)
      if (match) entries.push(match[1])
      if (entries.length >= limit) return entries
    }
  }
  return entries
}

function groupBy(items, keyOf) {
  const groups = {}
  for (const item of items) {
    const key = keyOf(item)
    ;(groups[key] ??= []).push(item)
  }
  return groups
}

function summarize(text) {
  return oneLine(text).slice(0, 160)
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Rewrite catalog.jsonl: one JSON line per note in every project. */
export function writeCatalog(root) {
  const lines = []
  for (const slug of discoverProjects(root)) {
    for (const note of scanNotes(root, slug)) {
      lines.push(
        JSON.stringify({
          project: slug,
          id: note.id,
          title: note.title,
          type: note.type,
          status: note.status,
          tags: note.tags,
          confidence: note.confidence,
          updated: note.updated,
          bytes: note.bytes,
          path: 'projects/' + slug + '/notes/' + note.name,
        }),
      )
    }
  }
  const file = join(root, 'catalog.jsonl')
  withLock(file, () => writeFileSync(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8'))
  return { file, notes: lines.length }
}

/** Full rebuild: every project index, the global index, and the catalog. */
export function reindexAll(root) {
  ensureGlobalFiles(root)
  const projects = []
  for (const slug of discoverProjects(root)) {
    ensureProject(root, { slug })
    renderProject(root, slug)
    projects.push(slug)
  }
  const global = renderGlobalIndex(root)
  const catalog = writeCatalog(root)
  return { projects, global, catalog }
}