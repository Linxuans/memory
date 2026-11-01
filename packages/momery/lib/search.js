/**
 * Lexical recall over the memory store. No embeddings, no index server: tokenize the
 * query and the notes, score field-weighted overlaps, and return bounded excerpts with
 * file pointers. CJK text is covered by character bigrams plus single characters, so
 * Chinese queries work without a tokenizer.
 */

import { scanNotes } from './store.js'

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me',
  'my', 'our', 'your', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'not',
  'no', 'yes', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'please', 'help', 'use',
  '关于', '什么', '怎么', '如何', '以及', '我们', '你们', '他们', '这个', '那个', '一下', '可以',
])

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** Split text into lowercase terms: ASCII words (>=2 chars) plus CJK bigrams/characters. */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase()
  const terms = new Map()
  const push = (term, weight = 1) => {
    if (term.length === 0) return
    terms.set(term, (terms.get(term) ?? 0) + weight)
  }
  const ascii = raw.match(/[a-z0-9_][a-z0-9_.-]*/g) ?? []
  for (const word of ascii) {
    if (word.length < 2) continue
    if (STOPWORDS.has(word)) continue
    push(word)
    for (const part of word.split(/[_.-]+/)) {
      if (part.length >= 2 && part !== word && !STOPWORDS.has(part)) push(part, 0.5)
    }
  }
  const cjkRuns = raw.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index++) push(run.slice(index, index + 2))
    for (const char of run) push(char, 0.6)
    if (run.length <= 6) push(run, 0.5)
  }
  return terms
}

function overlap(queryTerms, text) {
  if (queryTerms.size === 0) return 0
  const haystack = String(text ?? '').toLowerCase()
  let score = 0
  for (const [term, weight] of queryTerms) {
    if (haystack.includes(term)) score += weight
  }
  return score / queryTerms.size
}

/** Score one note against a tokenized query. Field weights favour curated metadata. */
export function scoreNote(queryTerms, note) {
  const title = overlap(queryTerms, note.title)
  const tags = overlap(queryTerms, note.tags.join(' '))
  const body = overlap(queryTerms, note.body)
  const type = overlap(queryTerms, note.type)
  const raw = title * 4 + tags * 3 + body * 2 + type * 0.5
  const recency = recencyBoost(note.updated || note.created)
  const statusPenalty = note.status === 'superseded' ? 0.6 : 1
  return raw * recency * statusPenalty * (0.5 + note.confidence)
}

function recencyBoost(dateText) {
  const time = Date.parse(dateText)
  if (!Number.isFinite(time)) return 1
  const days = (Date.now() - time) / 86_400_000
  if (days < 7) return 1.2
  if (days < 30) return 1.1
  if (days > 365) return 0.9
  return 1
}

/** Best excerpt around the densest match, or the opening lines when nothing matches. */
export function excerpt(note, queryTerms, width = 220) {
  const body = String(note.body ?? '')
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  let bestIndex = 0
  let bestHits = -1
  for (const term of queryTerms.keys()) {
    const index = flat.toLowerCase().indexOf(term)
    if (index === -1) continue
    let hits = 0
    let cursor = index
    while (cursor !== -1 && hits < 5) {
      hits++
      cursor = flat.toLowerCase().indexOf(term, cursor + term.length)
    }
    if (hits > bestHits) {
      bestHits = hits
      bestIndex = index
    }
  }
  const start = Math.max(0, bestIndex - Math.floor(width / 3))
  const piece = flat.slice(start, start + width).trim()
  return (start > 0 ? '...' : '') + piece + (start + width < flat.length ? '...' : '')
}

/**
 * Search one project or every project. Returns ranked hits with `project`, `id`,
 * `title`, `type`, `tags`, `updated`, `score`, `excerpt`, and a store-relative path.
 */
export function search(root, slugs, query, { limit = 8, types, tags, includeSuperseded = false } = {}) {
  const queryTerms = tokenize(query)
  const wantedTypes = types && types.length > 0 ? new Set(types) : null
  const wantedTags = tags && tags.length > 0 ? new Set(tags.map((tag) => tag.toLowerCase())) : null
  const hits = []
  for (const slug of slugs) {
    for (const note of scanNotes(root, slug)) {
      if (!includeSuperseded && note.status === 'superseded') continue
      if (wantedTypes && !wantedTypes.has(note.type)) continue
      if (wantedTags) {
        const noteTags = new Set(note.tags.map((tag) => tag.toLowerCase()))
        let matched = false
        for (const tag of wantedTags) if (noteTags.has(tag)) matched = true
        if (!matched) continue
      }
      const score = queryTerms.size === 0 ? 1 : scoreNote(queryTerms, note)
      if (queryTerms.size > 0 && score <= 0.05) continue
      hits.push({
        project: slug,
        id: note.id,
        title: note.title,
        type: note.type,
        status: note.status,
        tags: note.tags,
        confidence: note.confidence,
        updated: note.updated || note.created,
        score: Math.round(score * 100) / 100,
        excerpt: excerpt(note, queryTerms),
        path: 'projects/' + slug + '/notes/' + note.name,
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)))
  return hits.slice(0, Math.max(1, limit))
}