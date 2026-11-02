import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../packages/momery/index.js'
import { identify } from '../packages/momery/lib/project.js'

let pass = 0, fail = 0
const out = []
const ok = (label, cond, extra = '') => { if (cond) { pass++; out.push('ok: ' + label) } else { fail++; out.push('FAIL: ' + label + (extra ? ' -> ' + extra : '')) } }

const storeRoot = join(process.cwd(), '.tmp-regstore')
rmSync(storeRoot, { recursive: true, force: true })
const projA = join(process.cwd(), '.tmp-regproj', 'one')
const projB = join(process.cwd(), '.tmp-regproj', 'two')
mkdirSync(join(projA, '.git'), { recursive: true })
mkdirSync(join(projB, '.git'), { recursive: true })

function makeCtx(workingDirectory) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return workingDirectory
      return undefined
    },
    tools: {
      register(definition) { registered.push(definition); return () => {} },
      get(name) { return registered.some((tool) => tool.name === name) ? {} : undefined },
    },
    systemPrompt: { section(definition) { ctx._prompt = typeof definition.text === 'function' ? definition.text({ scope: {} }) : definition.text; return () => {} }, getSectionOrder() { return 0 } },
    effect(fn) { return fn() },
    logger: { warn() {} },
    _registered: registered,
  }
  return ctx
}

// --- case 1: get() throws exactly like the real Harness when handed an Agent ---
let target = projA
const hostileWD = {
  get() { throw new TypeError('session.snapshotEvents is not a function') },
  ensure: async () => target,
}
const ctx1 = makeCtx(hostileWD)
apply(ctx1, { memoryRoot: storeRoot })
const tools1 = Object.fromEntries(ctx1._registered.map((tool) => [tool.name, tool]))
const run1 = async (name, args, agent) => {
  const value = await tools1[name].execute(args, { agent, signal: AbortSignal.timeout(20000) })
  return tools1[name].output.render(args, value).map((b) => b.text).join('\n')
}
const agent = { id: 'agent-x' }
let text = ''
let threw = null
try { text = await run1('memory_write', { title: 'Hostile get()', content: 'body' }, agent) } catch (error) { threw = error }
ok('tools work when get() throws', threw === null && text.includes(identify(projA).slug), threw ? threw.message : text.slice(0, 80))

// --- case 2: cwd change is still detected through ensure() ---
target = projB
const second = await run1('memory_write', { title: 'After cd', content: 'body' }, agent)
ok('cwd change switches project', second.includes(identify(projB).slug), second.slice(0, 90))

// --- case 3: ensure() itself throws -> tool still succeeds ---
const failingWD = { get() { throw new TypeError('session.snapshotEvents is not a function') }, ensure: async () => { throw new Error('original project unavailable') } }
const ctx2 = makeCtx(failingWD)
apply(ctx2, { memoryRoot: storeRoot })
const tools2 = Object.fromEntries(ctx2._registered.map((tool) => [tool.name, tool]))
let text3 = '', threw3 = null
try {
  const value = await tools2.memory_write.execute({ title: 'Ensure fails', content: 'body' }, { agent: { id: 'agent-y' }, signal: AbortSignal.timeout(20000) })
  text3 = tools2.memory_write.output.render({}, value).map((b) => b.text).join('\n')
} catch (error) { threw3 = error }
ok('tools work when ensure() throws', threw3 === null && text3.includes('created note'), threw3 ? threw3.message : text3.slice(0, 80))

// --- case 4: no workingDirectory service at all ---
const ctx3 = makeCtx(undefined)
apply(ctx3, { memoryRoot: storeRoot })
const tools3 = Object.fromEntries(ctx3._registered.map((tool) => [tool.name, tool]))
let text4 = '', threw4 = null
try {
  const value = await tools3.memory_brief.execute({}, { agent: { id: 'agent-z' }, signal: AbortSignal.timeout(20000) })
  text4 = tools3.memory_brief.output.render({}, value).map((b) => b.text).join('\n')
} catch (error) { threw4 = error }
ok('tools work without workingDirectory', threw4 === null && text4.includes('# MEMORY CARD'), threw4 ? threw4.message : text4.slice(0, 80))

// --- case 5: prompt section no longer prints a directory ---
const ctx4 = makeCtx(hostileWD)
apply(ctx4, { memoryRoot: storeRoot })
ok('prompt section drops directory line', typeof ctx4._prompt === 'string' && !ctx4._prompt.includes('current project root'), String(ctx4._prompt).slice(0, 100))
ok('prompt section keeps the store root', typeof ctx4._prompt === 'string' && ctx4._prompt.includes(storeRoot))

console.log(out.join('\n'))
console.log('\nPASS=' + pass + ' FAIL=' + fail)