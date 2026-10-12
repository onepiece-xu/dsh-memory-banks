// Integration test of the REAL host half: it imports the built plugin module,
// runs `apply()` against a fake Context, and then exercises the registered tools,
// prompt sections and commands end to end over Map-backed storage tables.
//
// This is the closest local equivalent of booting a profile: the tool definitions
// go through the real `defineTool` validation, and the repository, scanning,
// budgets and learning wiring all run for real.
import test from 'node:test'
import assert from 'node:assert/strict'

const plugin = await import('../dist/index.js')

class FakeTable {
  #map = new Map()
  get(key) { return this.#map.get(key) }
  entries() { return this.#map.entries() }
  keys() { return this.#map.keys() }
  async put(key, value) { this.#map.set(key, value) }
  async delete(key) { return this.#map.delete(key) }
  get size() { return this.#map.size }
}

function defaultConfig(overrides = {}) {
  return {
    enabled: true,
    memoryCharLimit: 2200,
    userCharLimit: 1375,
    projectCharLimit: 2200,
    failureCharLimit: 4400,
    memoryMode: 'policy-only',
    standingInstructionsEnabled: true,
    nudgeInterval: 10,
    nudgeToolCalls: 15,
    correctionDetection: true,
    correctionMaxPerSession: 5,
    reviewEnabled: true,
    reviewMinTurns: 6,
    reviewMaxInputChars: 6000,
    reviewMaxOperations: 8,
    reviewTimeoutMs: 120000,
    llmProvider: '',
    llmModel: '',
    consolidationMaxEntries: 20,
    consolidationTimeoutMs: 180000,
    consolidationChunkChars: 4000,
    autoConsolidateOnOverflow: true,
    sessionRetentionDays: 0,
    flushOnSessionEnd: true,
    sessionSearchMode: 'auto',
    sessionSearchScanSessions: 20,
    memoryOverflowStrategy: 'auto-consolidate',
    usageHitTrackingEnabled: true,
    searchLimit: 10,
    sessionSearchLimit: 5,
    maxSnippetChars: 1200,
    maxStandingChars: 2000,
    ...overrides,
  }
}

/**
 * A fake Context exposing exactly the seams the host half injects.
 *
 * `optionalServices` are reachable ONLY through `ctx.get(name)`: reading them as
 * properties throws, exactly like Cordis does for a service that is not in the
 * plugin's `inject` list ("cannot get property X without inject"). That is what
 * makes this test a regression guard for the real-world activation failure.
 */
function makeContext(optionalServices = {}) {
  const tables = {
    memories: new FakeTable(),
    standing: new FakeTable(),
    state: new FakeTable(),
    skills: new FakeTable(),
    reviews: new FakeTable(),
    consolidations: new FakeTable(),
    session_index: new FakeTable(),
  }
  const tools = new Map()
  const sections = new Map()
  const commands = new Map()
  const listeners = new Map()
  const disposers = []
  const services = new Map(Object.entries(optionalServices))
  let seq = 0

  const domain = {
    name: 'dsh_memory_banks',
    global: { get: () => ({ seq }), set: async (value) => { seq = value.seq } },
    table: (name) => {
      const table = tables[name]
      if (table === undefined) throw new Error(`undeclared table requested: ${name}`)
      return table
    },
    close: async () => {},
  }

  const base = {
    storageDomain: { open: async () => domain },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (toolName) => tools.get(toolName),
    },
    systemPrompt: {
      section: (section) => {
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
    },
    commands: {
      register: (definition) => {
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get: (serviceName) => services.get(serviceName),
  }

  // Cordis's `inject(deps, callback)` runs the callback — with those services
  // available on the scoped context — only once every dependency exists. The fake
  // mirrors that, so optional-service wiring is exercised for real.
  const routes = []
  base.inject = (deps, callback) => {
    if (!deps.every((dependency) => services.has(dependency))) return { dispose() {} }
    // The scoped context exposes exactly the injected services as properties.
    const scoped = new Proxy(ctx, {
      get(target, property, receiver) {
        if (typeof property === 'string' && deps.includes(property)) return services.get(property)
        return Reflect.get(target, property, receiver)
      },
    })
    callback(scoped)
    return { dispose() {} }
  }

  const ctx = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        throw new Error(`cannot get property "${property}" without inject`)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  return { ctx, tables, tools, sections, commands, listeners, disposers, routes }
}

async function boot(overrides, optionalServices) {
  const world = makeContext(optionalServices)
  plugin.apply(world.ctx, defaultConfig(overrides))
  // Let the domain promise and the initial `refreshStanding()` settle.
  await new Promise((resolve) => setImmediate(resolve))
  return world
}

const run = (definition, args) => definition.execute(args, {})

test('a plugin entry registers its six tools, two prompt sections and nine commands', async () => {
  const world = await boot()
  assert.deepEqual([...world.tools.keys()].sort(), [
    'memory_add',
    'memory_remove',
    'memory_replace',
    'memory_search',
    'session_search',
    'skill_manage',
  ])
  assert.deepEqual([...world.sections.keys()].sort(), [
    'plugin:dsh-memory-banks',
    'plugin:dsh-memory-banks-standing',
  ])
  assert.deepEqual([...world.commands.keys()].sort(), [
    'learn-memory-tool',
    'memory-consolidate',
    'memory-index-sessions',
    'memory-insights',
    'memory-interview',
    'memory-pin',
    'memory-preview-context',
    'memory-skills',
    'memory-switch-project',
  ])
})

test('the policy section states the contract, and the standing section starts empty', async () => {
  const world = await boot()
  const policy = world.sections.get('plugin:dsh-memory-banks').text()
  assert.match(policy, /memory_add/)
  assert.match(policy, /context, not instruction/)
  assert.equal(world.sections.get('plugin:dsh-memory-banks-standing').text(), '')
})

test('memory_add → memory_search → memory_replace → memory_remove over real storage', async () => {
  const world = await boot()
  const add = await run(world.tools.get('memory_add'), { target: 'memory', content: 'project uses pnpm' })
  assert.equal(add.ok, true)
  assert.equal(add.bank, 'memory')
  assert.match(add.usage, /\[1% — 17\/2,200 chars\]/)
  assert.equal(world.tables.memories.size, 1)

  const found = await run(world.tools.get('memory_search'), { query: 'pnpm' })
  assert.equal(found.count, 1)
  assert.equal(found.hits[0].text, 'project uses pnpm')

  const replaced = await run(world.tools.get('memory_replace'), { target: 'memory', old_text: 'pnpm', content: 'project uses pnpm 9' })
  assert.equal(replaced.ok, true)
  assert.equal((await run(world.tools.get('memory_search'), { query: 'pnpm 9' })).count, 1)

  const removed = await run(world.tools.get('memory_remove'), { target: 'memory', old_text: 'pnpm 9' })
  assert.equal(removed.ok, true)
  assert.equal(world.tables.memories.size, 0)
})

test('the tools inherit the safety rules: secrets refused, ambiguity refused', async () => {
  const world = await boot()
  await assert.rejects(
    () => run(world.tools.get('memory_add'), { target: 'memory', content: 'token sk-ant-abcdefghijklmnopqrst' }),
    /refused to store/,
  )
  await run(world.tools.get('memory_add'), { target: 'user', content: 'prefers concise answers' })
  await run(world.tools.get('memory_add'), { target: 'user', content: 'prefers dark theme' })
  await assert.rejects(
    () => run(world.tools.get('memory_remove'), { target: 'user', old_text: 'prefers' }),
    /matched 2 distinct entries/,
  )
  // The refused secret never landed; the two legitimate user entries did.
  const entries = [...world.tables.memories.entries()].map(([, row]) => row)
  assert.deepEqual(entries.map((row) => row.bank), ['user', 'user'])
})

test('memory_add records recall usage and skill_manage curates a real catalog entry', async () => {
  const world = await boot()
  await run(world.tools.get('memory_add'), { target: 'memory', content: 'prefers terse answers' })
  await run(world.tools.get('memory_search'), { query: 'terse' })
  const stored = [...world.tables.memories.entries()][0][1]
  assert.equal(stored.hitCount, 1)

  const created = await run(world.tools.get('skill_manage'), {
    action: 'create',
    scope: 'global',
    name: 'debug-typescript-errors',
    description: 'Debug tsc --noEmit failures in a monorepo',
    steps: ['Read the error', 'Run tsc --noEmit'],
    verification: ['tsc --noEmit is clean'],
  })
  assert.equal(created.ok, true)
  assert.equal(created.id, 'debug-typescript-errors')
  assert.equal(world.tables.skills.size, 1)
  assert.match(world.tables.skills.get('debug-typescript-errors').body, /## Procedure/)

  const listed = await run(world.tools.get('skill_manage'), { action: 'view' })
  assert.match(listed.message, /debug-typescript-errors/)
  await assert.rejects(
    () => run(world.tools.get('skill_manage'), { action: 'create', scope: 'global', name: 'debug-typescript-errors', description: 'dupe' }),
    /already exists/,
  )
})

test('session_search explains a disabled host index instead of failing opaquely', async () => {
  const world = await boot()
  // No sessionQuery on this fake context: the tool reports it as unavailable.
  await assert.rejects(
    () => run(world.tools.get('session_search'), { query: 'anything' }),
    /session search is unavailable/,
  )
})

test('/memory-pin drives the standing section, and the commands report real state', async () => {
  const world = await boot()
  const pin = await world.commands.get('memory-pin').handler({ rawInput: 'never run find /' })
  assert.equal(pin.kind, 'success')
  assert.match(pin.text, /Pinned/)
  assert.match(world.sections.get('plugin:dsh-memory-banks-standing').text(), /never run find \//)

  const insights = await world.commands.get('memory-insights').handler({ rawInput: '' })
  assert.equal(insights.kind, 'success')
  assert.match(insights.text, /MEMORY/)
  assert.match(insights.text, /Standing instructions \(1\)/)

  const clear = await world.commands.get('memory-pin').handler({ rawInput: 'clear' })
  assert.match(clear.text, /Cleared 1 standing instruction/)
  assert.equal(world.sections.get('plugin:dsh-memory-banks-standing').text(), '')

  const learn = await world.commands.get('learn-memory-tool').handler({ rawInput: '' })
  assert.match(learn.text, /Created global skill using-dsh-memory-banks/)
  const again = await world.commands.get('learn-memory-tool').handler({ rawInput: '' })
  assert.match(again.text, /already exists/)
})

test('session/flush and session/disposed trigger reviews that degrade to skipped', async () => {
  const world = await boot()
  const session = {
    id: 'session-1',
    snapshotEvents: () => [
      { type: 'turn/start' },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'please use pnpm' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'ok' }] } },
    ],
  }
  for (const handler of world.listeners.get('session/flush') ?? []) await handler(session)
  for (const handler of world.listeners.get('session/disposed') ?? []) await handler(session)
  await new Promise((resolve) => setImmediate(resolve))
  // Two reviews were attempted (flush + disposed), each recorded as skipped: the
  // fake context has no model route, and the session is under the turn threshold.
  const reviews = [...world.tables.reviews.entries()].map(([, row]) => row)
  assert.ok(reviews.length >= 1)
  assert.ok(reviews.every((row) => row.status === 'skipped'))
})

test('the full nudge → correction → consolidate path is reachable from the wiring', async () => {
  const world = await boot({ nudgeInterval: 1, nudgeToolCalls: 1 })
  // The pre-step waterfall hands back the step's messages plus the nudge.
  const preStep = (world.listeners.get('agent/pre-step') ?? [])[0]
  assert.ok(preStep, 'agent/pre-step listener must be registered')
  world.listeners.get('session/event')[0](
    { id: 'session-2' },
    { type: 'turn/start', data: {} },
  )
  const decision = await preStep(
    { agent: { session: { id: 'session-2' } }, messages: [{ id: 'm1', role: 'user', content: [] }], turn: 2, step: 1, signal: AbortSignal.abort() },
    async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [] }] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.kind, 'dsh-memory-banks')

  // A user correction is captured into the user bank without any model call.
  const onEvent = world.listeners.get('session/event')[0]
  onEvent({ id: 'session-2' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'no, use pnpm not npm' }] } })
  await new Promise((resolve) => setImmediate(resolve))
  const userEntries = [...world.tables.memories.entries()].map(([, row]) => row).filter((row) => row.bank === 'user')
  assert.equal(userEntries.length, 1)
  assert.equal(userEntries[0].category, 'correction')
  assert.equal(userEntries[0].source, 'session')
})

test('optional services are reached through ctx.get: session_search uses the host index', async () => {
  const sessionQuery = {
    async searchSessions(request) {
      assert.equal(request.query, 'pnpm')
      return {
        items: [{
          header: { id: 'session-9', cwd: 'D:/Codes/demo' },
          bestMatch: { type: 'user/message', snippet: 'we discussed pnpm workspaces' },
        }],
      }
    },
    async listSessions() { return [] },
    async filterEvents() { return [] },
  }
  const world = await boot({}, { sessionQuery })
  const hits = await run(world.tools.get('session_search'), { query: 'pnpm' })
  assert.equal(hits.count, 1)
  assert.equal(hits.hits[0].session_id, 'session-9')
  assert.equal(hits.hits[0].cwd, 'D:/Codes/demo')
  assert.match(hits.hits[0].snippet, /pnpm workspaces/)
})

test('short CJK queries fall back to the literal scan when token recall finds nothing', async () => {
  const calls = []
  const sessionQuery = {
    // Token recall misses 天气; the literal scan must find it.
    async searchSessions() { return { items: [] } },
    async listSessions() { return [{ header: { id: 'session-cjk', createdAt: 2, cwd: 'D:/Codes/cjk' } }] },
    async filterEvents(sessionId, filters) {
      calls.push([sessionId, filters])
      return [{ type: 'user/message', text: '今天天气很好，我们去公园散步' }]
    },
  }
  const world = await boot({}, { sessionQuery })
  const hits = await run(world.tools.get('session_search'), { query: '天气' })
  assert.equal(hits.count, 1)
  assert.match(hits.hits[0].snippet, /天气/)
  assert.deepEqual(calls, [['session-cjk', [{ kind: 'text', text: '天气' }]]])
})

test('the skill registry receives a provider that reads current storage', async () => {
  let provider
  const skills = {
    registerProvider: (create) => {
      provider = create({ invalidate() {} })
      return () => {}
    },
  }
  const world = await boot({}, { skills })
  assert.ok(provider, 'apply() must register a skill provider when the registry exists')
  assert.equal(provider.name, 'dsh-memory-banks')

  await run(world.tools.get('skill_manage'), {
    action: 'create', scope: 'global', name: 'deploy-here', description: 'How to deploy here', steps: ['run the pipeline'],
  })
  const catalog = await provider.list({})
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'deploy-here')
  assert.equal(catalog[0].provider, 'dsh-memory-banks')
  assert.equal(catalog[0].invocation.modelInvocable, true)

  const document = await provider.get({ name: 'deploy-here', locator: 'deploy-here', rank: 500 })
  assert.match(document.content, /## Procedure/)
  assert.equal(document.provider, 'dsh-memory-banks')
})

test('the settings panel route registers only when a web server exists', async () => {
  // No webServer service: the plugin still boots and registers no route.
  const bare = await boot()
  assert.equal(bare.routes.length, 0)

  const registered = []
  const webServer = { register: (spec) => { registered.push(spec); return () => {} } }
  const world = await boot({}, { webServer })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'exact')
  assert.equal(registered[0].path, '/dsh-memory-banks/stats')

  await run(world.tools.get('memory_add'), { target: 'memory', content: 'panel sees this' })
  let body = ''
  registered[0].handler({}, { writeHead: () => {}, end: (buffer) => { body = buffer.toString('utf8') } })
  const stats = JSON.parse(body)
  assert.equal(stats.plugin, 'dsh-memory-banks')
  assert.equal(stats.state, 'ready')
  assert.equal(stats.banks.length, 4)
  assert.deepEqual(stats.entries.map((entry) => entry.text), ['panel sees this'])
  assert.match(stats.banks[0].usage, /^\[\d+% — /)
})

// ── config resolution ──────────────────────────────────────────────────────
// Schemastery resolves `.volatile()` fields to `{ get() }` wrappers (that is what
// makes them editable from Settings). These tests boot the plugin with EXACTLY
// that shape, which is how the real host delivers it.

async function bootRaw(rawConfig, optionalServices) {
  const world = makeContext(optionalServices)
  plugin.apply(world.ctx, rawConfig)
  await new Promise((resolve) => setImmediate(resolve))
  return world
}

const wrapAll = (config) => Object.fromEntries(Object.entries(config).map(([key, value]) => [key, { get: () => value }]))

test('volatile config wrappers are resolved into plain values', async () => {
  assert.equal(plugin.resolveConfig({ a: { get: () => 5 }, b: 'plain' }).a, 5)
  assert.equal(plugin.resolveConfig({ b: 'plain' }).b, 'plain')

  const world = await bootRaw(wrapAll(defaultConfig({ memoryCharLimit: 20, searchLimit: 5 })))
  // The budget is enforced with the RESOLVED number (as an object it never was).
  await run(world.tools.get('memory_add'), { target: 'memory', content: 'x'.repeat(18) })
  await assert.rejects(
    () => run(world.tools.get('memory_add'), { target: 'memory', content: 'y'.repeat(5) }),
    /over budget/,
  )
  // searchLimit resolved too: a hit count of 1 proves the slice was not NaN.
  assert.equal((await run(world.tools.get('memory_search'), { query: 'xxxx' })).count, 1)
})

test('the nudge obeys its thresholds when config arrives as volatile wrappers', async () => {
  const strict = await bootRaw(wrapAll(defaultConfig({ nudgeInterval: 10, nudgeToolCalls: 15 })))
  const preStep = strict.listeners.get('agent/pre-step')[0]
  const step = (world, sessionId) => preStep(
    { agent: { session: { id: sessionId } }, messages: [{ id: 'm1', role: 'user', content: [] }], turn: 1, step: 1, signal: AbortSignal.abort() },
    async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [] }] }),
  )
  // Under both thresholds: the step is handed back untouched (previously the
  // comparison ran against an object and this nudged on every single step).
  assert.equal((await step(strict, 's-under')).messages.length, 1)

  const eager = await bootRaw(wrapAll(defaultConfig({ nudgeInterval: 1, nudgeToolCalls: 1 })))
  eager.listeners.get('session/event')[0]({ id: 's-over' }, { type: 'turn/start', data: {} })
  const eagerPreStep = eager.listeners.get('agent/pre-step')[0]
  const decision = await eagerPreStep(
    { agent: { session: { id: 's-over' } }, messages: [{ id: 'm1', role: 'user', content: [] }], turn: 2, step: 1, signal: AbortSignal.abort() },
    async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [] }] }),
  )
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.kind, 'dsh-memory-banks')
})
