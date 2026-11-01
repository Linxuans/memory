#!/usr/bin/env node
/**
 * momery CLI - the human surface over the same store the agent tools use.
 *
 *   node bin/momery.mjs status [--all]
 *   node bin/momery.mjs search "<query>" [--project all|<slug>] [--limit 8]
 *   node bin/momery.mjs brief ["<query>"] [--project <slug>]
 *   node bin/momery.mjs read <store-relative-path> [--offset 1] [--limit 200]
 *   node bin/momery.mjs write --title "..." --type decision --tags a,b --content "..."
 *   node bin/momery.mjs note --project <slug> --title "..." --file body.md
 *   node bin/momery.mjs pending --project <slug> --file pending.md
 *   node bin/momery.mjs journal --project <slug> --content "..."
 *   node bin/momery.mjs end --project <slug> --summary "..." [--notes notes.json]
 *   node bin/momery.mjs curate [--purpose "..."] [--rules "a,b" | --rules-file rules.txt] [--dry-run]
 *   node bin/momery.mjs distill [--promote] [--report-only] [--limit 10]
 *   node bin/momery.mjs reindex [--project <slug>]
 *   node bin/momery.mjs projects
 *
 * The store root resolves from --root, then MOMERY_ROOT, then ~/.momery.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { buildTools } from '../packages/momery/lib/tools.js'
import { identify } from '../packages/momery/lib/project.js'
import { ensureGlobalFiles, resolveRoot } from '../packages/momery/lib/store.js'

const argv = process.argv.slice(2)
const command = argv.shift() ?? 'status'

function take(flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  argv.splice(index, 2)
  return value
}
function takeAll(flag) {
  const values = []
  for (;;) {
    const value = take(flag)
    if (value === undefined) return values
    values.push(value)
  }
}
function takeBool(flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}

const rootOption = take('--root')
const root = resolveRoot(rootOption ?? process.env.MOMERY_ROOT ?? join(homedir(), '.momery'))
ensureGlobalFiles(root)

const projectRef = take('--project')
const cwd = take('--cwd') ?? process.cwd()
const identity = identify(cwd)
const project = projectRef && projectRef !== 'all' ? projectRef : identity.slug

const tools = buildTools(root, async () => ({ ...identity, slug: project }))
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

async function call(name, args) {
  const value = await byName[name].execute(args, { agent: { id: 'cli' }, signal: AbortSignal.timeout(30_000) })
  process.stdout.write(byName[name].output.render(args, value).map((block) => block.text).join('\n') + '\n')
}

function readBody(flag) {
  const file = take(flag)
  if (file !== undefined) return readFileSync(file, 'utf8')
  const inline = take('--content')
  if (inline !== undefined) return inline
  throw new Error(`provide ${flag} <file> or --content "..."`)
}

const query = argv.join(' ').trim()

try {
  switch (command) {
    case 'status':
      await call('memory_status', { scope: argv.includes('--all') ? 'all' : 'current', project: projectRef, pending: takeBool('--pending') })
      break
    case 'projects':
      await call('memory_status', { scope: 'all' })
      break
    case 'brief':
      await call('memory_brief', { query: query || undefined, project: projectRef, other_projects: takeBool('--other') })
      break
    case 'search': {
      if (!query) throw new Error('usage: momery search "<query>" [--project all|<slug>]')
      await call('memory_search', { query, project: projectRef, projects: undefined, limit: Number(take('--limit') ?? 8) })
      break
    }
    case 'read': {
      const path = argv[0]
      if (!path) throw new Error('usage: momery read <store-relative-path>')
      await call('memory_read', { path, offset: Number(take('--offset') ?? 1), limit: Number(take('--limit') ?? 200) })
      break
    }
    case 'write':
      await call('memory_write', {
        kind: 'note',
        project: projectRef,
        title: take('--title'),
        type: take('--type') ?? 'fact',
        tags: (take('--tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
        content: readBody('--file'),
      })
      break
    case 'note':
      await call('memory_write', {
        kind: 'note',
        project: projectRef,
        title: take('--title'),
        type: take('--type') ?? 'fact',
        tags: (take('--tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
        content: readBody('--file'),
      })
      break
    case 'pending':
      await call('memory_write', { kind: 'pending', project: projectRef, content: readBody('--file') })
      break
    case 'journal':
      await call('memory_write', { kind: 'journal', project: projectRef, content: readBody('--file') })
      break
    case 'end': {
      const summary = take('--summary') ?? readBody('--file')
      const notesFile = take('--notes')
      const notes = notesFile ? JSON.parse(readFileSync(notesFile, 'utf8')) : undefined
      await call('memory_end', { project: projectRef, summary, notes })
      break
    }
    case 'curate': {
      const rulesArg = take('--rules')
      const rulesFile = take('--rules-file')
      const rules = rulesFile
        ? readFileSync(rulesFile, 'utf8').split(/\r?\n/).map((line) => line.replace(/^[-*]\s+/, '').trim()).filter(Boolean)
        : rulesArg
          ? rulesArg.split(',').map((rule) => rule.trim()).filter(Boolean)
          : undefined
      await call('memory_curate', {
        project: projectRef,
        purpose: take('--purpose'),
        rules,
        dry_run: takeBool('--dry-run'),
      })
      break
    }
    case 'distill':
      await call('memory_distill', {
        project: projectRef,
        promote: takeBool('--promote'),
        write: !takeBool('--report-only'),
        limit: Number(take('--limit') ?? 10),
      })
      break
    case 'reindex':
      await call('memory_reindex', { project: projectRef })
      break
    case 'help':
    case '--help':
      process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^.*?\/\*\*/s, '') + '\n')
      break
    default:
      throw new Error(`unknown command "${command}"; try: status projects brief search read write pending journal end reindex`)
  }
} catch (error) {
  process.stderr.write('momery: ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}