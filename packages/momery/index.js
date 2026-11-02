/**
 * momery - durable, project-scoped memory for the DeepSeek Harness.
 *
 * Registers seven memory tools globally, a `momery` skill describing the protocol,
 * and one short system-prompt section that makes the capability discoverable even
 * after a session is compacted or resumed. State lives entirely in plain files under
 * the store root; this plugin holds only a per-agent project cache.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { identify, projectForAgent } from './lib/project.js'
import { parseNote } from './lib/note.js'
import { resolveRoot, ensureGlobalFiles, renderGlobalIndex, reindexAll } from './lib/store.js'
import { buildTools } from './lib/tools.js'

export const name = 'momery'

/** Harness services this plugin registers against. Optional ones are read with ctx.get(). */
export const inject = ['tools', 'systemPrompt', 'skills', 'workingDirectory']

const PROMPT_SECTION = 'tool:momery'
const TOOL_NAMES = ['memory_brief', 'memory_search', 'memory_read', 'memory_write', 'memory_status', 'memory_end', 'memory_curate', 'memory_distill', 'memory_reindex']

/** Read a config flag without throwing on unusual values. */
function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

export function apply(ctx, config = {}) {
  const root = resolveRoot(typeof config.memoryRoot === 'string' && config.memoryRoot.trim().length > 0 ? config.memoryRoot.trim() : undefined)
  const autoInject = flag(config.promptSection, true)
  const registerSkill = flag(config.skill, true)
  const bootstrap = flag(config.bootstrap, true)
  const projects = new WeakMap()

  ensureGlobalFiles(root)
  if (bootstrap) {
    try {
      reindexAll(root)
    } catch (error) {
      ctx.logger?.warn?.(`momery: initial reindex skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Project identity of the calling agent's session directory, cached per agent.
   *
   * `workingDirectory.ensure(agent)` is the only directory API that takes an Agent;
   * `get()` takes a Session, so calling it with an Agent throws inside the Harness
   * (`session.snapshotEvents is not a function`). Resolve through `ensure` alone, and
   * treat any failure as "unknown directory" instead of failing the tool call.
   */
  const resolveAgent = async (exec) => {
    const agent = exec?.agent
    const cached = agent ? projects.get(agent) : undefined
    if (!agent) return identify(process.cwd())

    const workingDirectory = hasService(ctx, 'workingDirectory') ? ctx.get('workingDirectory') : undefined
    let cwd = null
    if (workingDirectory) {
      try {
        cwd = await workingDirectory.ensure(agent, exec?.signal)
      } catch {
        cwd = null
      }
    }
    // A session can `cd`; compare the authoritative directory with the cached one.
    const resolved = typeof cwd === 'string' && cwd.length > 0 ? cwd : cached?.cwd ?? process.cwd()
    if (cached && cached.cwd === resolved) return cached

    const info = projectForAgent(root, resolved)
    const entry = { ...info, cwd: resolved }
    projects.set(agent, entry)
    return entry
  }

  ctx.effect(() => {
    const disposers = []
    for (const tool of buildTools(root, resolveAgent)) disposers.push(ctx.tools.register(tool))
    disposers.push(
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: 910,
        text: ({ scope }) => {
          const visible = TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName, scope) !== undefined)
          if (visible.length === 0) return ''
          return [
            '## Long-term memory (momery)',
            'You have durable project memory that outlives this conversation. Store: `' + root + '`.',
            'Before non-trivial work and after any context reset, call `memory_brief` with the task\'s entities or symptom text. Read a specific hit with `memory_read`.',
            'Record durable decisions, constraints, patterns, root-caused issues, and stated preferences with `memory_write` while the evidence is fresh; close the session with `memory_end`.',
            'Other projects\' memory is reachable on purpose: `memory_status` to discover, `memory_search project="all"` to search everything, `memory_read` for details. Load the `momery` skill for the full protocol.',
          ].join('\n')
        },
      }),
    )
    // A skill-registration failure must not take the tools down with it.
    if (registerSkill && hasService(ctx, 'skills')) {
      try {
        disposers.push(registerRuntimeSkill(ctx))
      } catch (error) {
        ctx.logger?.warn?.('momery: skill registration skipped: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}

function hasService(ctx, name) {
  try {
    return ctx.get(name) !== undefined
  } catch {
    return false
  }
}


/** Register the protocol skill from the packaged SKILL.md, parsed at activation. */
function registerRuntimeSkill(ctx) {
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, 'skill', 'SKILL.md')
  const raw = readFileSync(file, 'utf8')
  const { data, body } = parseNote(raw)
  const summary = {
    name: typeof data.name === 'string' && data.name.length > 0 ? data.name : 'momery',
    description: typeof data.description === 'string' ? data.description : 'Durable project memory.',
    whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : undefined,
  }
  return ctx.skills.register({
    ...summary,
    source: 'runtime',
    path: file,
    resourceBase: { kind: 'directory', path: dirname(file) },
    invocation: { modelInvocable: true, userInvocable: true },
    content: body.trim(),
  })
}

/** Exposed for a human CLI and for tests; the plugin itself needs no init hook. */
export { resolveRoot as storeRoot } from './lib/store.js'
export const api = { buildTools, ensureGlobalFiles, renderGlobalIndex, reindexAll }