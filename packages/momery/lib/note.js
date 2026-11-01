/**
 * Frontmatter + note model for the momery store.
 *
 * A note is a plain Markdown file with a YAML-ish frontmatter block. The parser is
 * deliberately small and dependency-free: scalars, inline arrays, block lists, and
 * quoted strings. That is everything the store writes, so a hand-edited file that
 * keeps to that subset round-trips.
 */

export const NOTE_TYPES = [
  'fact',
  'decision',
  'pattern',
  'issue',
  'preference',
  'task',
  'observation',
  'reference',
]

export const NOTE_STATUSES = ['active', 'superseded', 'archived']

/** Slug: lowercase, ASCII-only, hyphen separated. Non-ASCII text is dropped. */
export function slugify(input, fallback = 'untitled') {
  const ascii = String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return ascii.length > 0 ? ascii : fallback
}

/**
 * Project slug for one working directory: a pure function of the normalized path,
 * so the same repo maps to the same folder on every profile.
 */
export function projectSlug(path) {
  const normalized = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, '$1-')
    .replace(/\/+/g, '/')
  return slugify(normalized, 'project')
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return inner
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => unquote(part))
  }
  return unquote(text)
}

function unquote(text) {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  if (text === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) || /:\s|\s#|[\n\r]/.test(text)) {
    return JSON.stringify(text)
  }
  return text
}

/** Parse one note document into { data, body }. Missing frontmatter yields data = {}. */
export function parseNote(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (!source.startsWith('---')) return { data: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: source }
  const header = source.slice(source.indexOf('\n', 3) + 1, end)
  let body = source.slice(end + 4)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  const data = {}
  let lastKey
  for (const line of header.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && lastKey !== undefined) {
      if (!Array.isArray(data[lastKey])) data[lastKey] = []
      data[lastKey].push(parseScalar(item[1]))
      continue
    }
    const pair = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]
    const rest = pair[2].trim()
    lastKey = key
    data[key] = rest === '' ? [] : parseScalar(rest)
  }
  return { data, body }
}

/** Serialize a note, keeping the store's canonical field order first. */
export function serializeNote(data, body) {
  const order = [
    'schema_version',
    'id',
    'title',
    'type',
    'status',
    'scope',
    'project',
    'tags',
    'confidence',
    'valid_from',
    'valid_until',
    'created',
    'updated',
    'superseded_by',
    'sources',
    'relations',
  ]
  const keys = [
    ...order.filter((key) => data[key] !== undefined),
    ...Object.keys(data).filter((key) => !order.includes(key) && data[key] !== undefined),
  ]
  const lines = ['---']
  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(key + ': []')
      else {
        lines.push(key + ':')
        for (const entry of value) lines.push('  - ' + formatScalar(entry))
      }
      continue
    }
    lines.push(key + ': ' + formatScalar(value))
  }
  lines.push('---', '')
  const cleaned = String(body ?? '').replace(/^\n+/, '')
  return lines.join('\n') + '\n' + cleaned + (cleaned.endsWith('\n') ? '' : '\n')
}

/** Stable, sortable id: YYYYMMDD-HHmmss plus a short random suffix. */
export function newId(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const prefix =
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  return prefix + '-' + Math.random().toString(36).slice(2, 6)
}

/** YYYY-MM-DDTHH:mm in local time: compact, sortable, human-readable. */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) +
    ':' + pad(date.getMinutes())
  )
}

/** First meaningful line of a body, used as a fallback title. */
export function firstHeading(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim())
    if (heading) return heading[1].trim()
    if (line.trim().length > 0 && !line.startsWith('---')) return line.trim().slice(0, 80)
  }
  return ''
}