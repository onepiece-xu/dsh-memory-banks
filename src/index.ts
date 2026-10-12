/**
 * dsh-memory-banks — host half: hermes-agent's bounded, durable memory banks for DSH.
 *
 * Wiring only. Every rule lives in dependency-free modules:
 *   `core.ts`      bank algebra, budgets, matching, content scanning
 *   `records.ts`   durable zod schemas
 *   `repo.ts`      read/write orchestration over the storage domain
 *   `templates.ts` every model-facing string, correction detection, skill bodies
 *   `tools.ts`     the six model-facing tools
 *
 * Seams used: `ctx.storageDomain` (durability), `ctx.tools` (tools),
 * `ctx.systemPrompt` (policy + standing instructions), `ctx.commands`,
 * `ctx.skills` (mirror of procedural skills), `ctx.sessionQuery` (session search),
 * `agent/created` + `agent/pre-step` (snapshot injection, nudge),
 * `session/event` (counters, correction capture), `ctx.webServer` (optional panel).
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SkillProvider, SkillRegistry } from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

// Type-only imports: these packages augment `Context` / the event map, and
// TypeScript applies an augmentation only when the module is in the program.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'

import * as core from './core.js'
import { createLearning, textOfEvent, type SessionEventLike } from './learning.js'
import { createOneShot, resolveRoute, type LlmRoute, type LlmRuntimeLike } from './llm.js'
import { BANKS, type Bank, type SkillRecord } from './records.js'
import { MemoryRepository } from './repo.js'
import { shouldFallbackToSubstring, snippetAround } from './search.js'
import { memoryDomainSpec } from './storage.js'
import * as tpl from './templates.js'
import { createMemoryTools, type SessionHit } from './tools.js'
// Declares this plugin's `MessageSourceMap` kind (type-only side effect).
import type {} from './message-source.js'

export const name = 'dsh-memory-banks'

// `webServer`, `skills`, `sessionQuery` and `llm` are deliberately NOT injected:
// each is optional, and a memory plugin must still load in headless/SDK profiles.
export const inject = ['storageDomain', 'tools', 'systemPrompt', 'commands']

/** Plugin config — upstream field names where they mean the same thing. */
export interface Config {
  /** Master switch: when false the plugin registers nothing. */
  enabled: boolean
  memoryCharLimit: number
  userCharLimit: number
  projectCharLimit: number
  failureCharLimit: number
  /**
   * `policy-only` (default) injects the memory policy only. `legacy-inject` also
   * injects the current banks as a plugin-authored message once per session —
   * the DSH analogue of upstream's prompt injection that keeps the prompt prefix stable.
   */
  memoryMode: string
  standingInstructionsEnabled: boolean
  /** Turns without a memory write before the nudge fires. */
  nudgeInterval: number
  /** Tool calls without a memory write before the nudge fires (OR with turns). */
  nudgeToolCalls: number
  correctionDetection: boolean
  correctionMaxPerSession: number
  reviewEnabled: boolean
  reviewMinTurns: number
  reviewMaxInputChars: number
  reviewMaxOperations: number
  reviewTimeoutMs: number
  /** Minimum wall-clock gap between two reviews of the same session. */
  reviewMinIntervalMs: number
  /** Explicit model route for background calls; empty means "use the deployment default". */
  llmProvider: string
  llmModel: string
  consolidationMaxEntries: number
  consolidationTimeoutMs: number
  /** Characters per consolidation round; 0 merges the whole bank in one call. */
  consolidationChunkChars: number
  /** Merge a bank automatically when a write is refused for exceeding its budget. */
  autoConsolidateOnOverflow: boolean
  /** Days of review/consolidation audit history to keep; 0 keeps everything. */
  sessionRetentionDays: number
  /** Run one final review when a session is disposed. */
  flushOnSessionEnd: boolean
  /** `tokens` (host FTS), `substring` (literal scan), or `auto` (tokens, then substring). */
  sessionSearchMode: string
  /** How many recent sessions the literal scan visits. */
  sessionSearchScanSessions: number
  /** `auto-consolidate` | `reject` | `fifo-evict` (upstream parity). */
  memoryOverflowStrategy: string
  usageHitTrackingEnabled: boolean
  searchLimit: number
  sessionSearchLimit: number
  maxSnippetChars: number
  /** Character budget of the always-injected standing-instruction block. */
  maxStandingChars: number
}

// No `z<Config>` annotation: `.volatile()` changes the schema's carried type
// (marking fields as form-exposed), so the schema is the source of truth and the
// exported `Config` interface documents the RESOLVED shape `apply` receives.
export const Config = z.object({
  // Every field is `.volatile()`: DSH's settings forms expose exactly the
  // volatile fields of an active profile entry, so this is what makes the
  // config editable from Settings → Plugins without hand-editing YAML.
  enabled: z.boolean().default(true).volatile(),
  memoryCharLimit: z.natural().default(2200).volatile(),
  userCharLimit: z.natural().default(1375).volatile(),
  projectCharLimit: z.natural().default(2200).volatile(),
  failureCharLimit: z.natural().default(4400).volatile(),
  memoryMode: z.string().default('policy-only').volatile(),
  standingInstructionsEnabled: z.boolean().default(true).volatile(),
  nudgeInterval: z.natural().default(10).volatile(),
  nudgeToolCalls: z.natural().default(15).volatile(),
  correctionDetection: z.boolean().default(true).volatile(),
  correctionMaxPerSession: z.natural().default(5).volatile(),
  reviewEnabled: z.boolean().default(true).volatile(),
  reviewMinTurns: z.natural().default(6).volatile(),
  reviewMaxInputChars: z.natural().default(6000).volatile(),
  reviewMaxOperations: z.natural().default(8).volatile(),
  reviewTimeoutMs: z.natural().default(120000).volatile(),
  reviewMinIntervalMs: z.natural().default(120000).volatile(),
  llmProvider: z.string().default('').volatile(),
  llmModel: z.string().default('').volatile(),
  consolidationMaxEntries: z.natural().default(20).volatile(),
  consolidationTimeoutMs: z.natural().default(180000).volatile(),
  consolidationChunkChars: z.natural().default(4000).volatile(),
  autoConsolidateOnOverflow: z.boolean().default(true).volatile(),
  sessionRetentionDays: z.natural().default(0).volatile(),
  flushOnSessionEnd: z.boolean().default(true).volatile(),
  sessionSearchMode: z.string().default('auto').volatile(),
  sessionSearchScanSessions: z.natural().default(20).volatile(),
  memoryOverflowStrategy: z.string().default('auto-consolidate').volatile(),
  usageHitTrackingEnabled: z.boolean().default(true).volatile(),
  searchLimit: z.natural().default(10).volatile(),
  sessionSearchLimit: z.natural().default(5).volatile(),
  maxSnippetChars: z.natural().default(1200).volatile(),
  maxStandingChars: z.natural().default(2000).volatile(),
})

/** Plugin tool-guidance slot: third-party plugins use the low hundreds (ssh 150, task-board 200). */
const SECTION_ORDER = 210
const STANDING_SECTION_ORDER = 212

interface RouteSpec {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: Buffer) => void }) => void
}
type WebServer = { register: (spec: RouteSpec) => () => void }

/**
 * Resolve a config object into plain values.
 *
 * Schemastery resolves a `.volatile()` field to a `{ get() }` wrapper — that is
 * exactly what makes it editable from Settings → Plugins — while a plain field
 * arrives as its value. Reading a wrapper as if it were the value silently turns
 * budgets and thresholds into objects (`[object Object]`, NaN comparisons), so
 * every runtime read goes through this normalizer.
 */
export function resolveConfig(raw: Config): Config {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as unknown as Record<string, unknown>)) {
    out[key] = typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get: () => unknown }).get()
      : value
  }
  return out as unknown as Config
}

function limitsOf(config: Config): core.BankLimits {
  return {
    memory: config.memoryCharLimit,
    user: config.userCharLimit,
    project: config.projectCharLimit,
    failure: config.failureCharLimit,
  }
}

export function apply(ctx: Context, rawConfig: Config) {
  /**
   * Live view of the config. Each property read goes through `resolveConfig`, so a
   * Settings-form edit (which mutates the wrapper the host handed us) takes effect
   * on the next read — no cached snapshot to keep in sync.
   */
  const config = new Proxy({} as Config, {
    get: (_target, property: string) => resolveConfig(rawConfig)[property as keyof Config],
  })
  const limits = limitsOf(config)

  if (!config.enabled) {
    console.log(`[${name}] disabled by config`)
    return
  }

  /**
   * Optional-service lookup. Cordis THROWS when a plugin reads a service property
   * that is not in its `inject` list ("cannot get property X without inject"), so
   * every service this plugin can live without MUST go through `ctx.get(name)`.
   * Injecting them instead would make the plugin unloadable in profiles that lack
   * one (headless/SDK) — exactly what we avoid.
   */
  const service = <T>(serviceName: string): T | undefined => {
    const get = (ctx as unknown as { get?: (key: string) => unknown }).get
    return typeof get === 'function' ? (get.call(ctx, serviceName) as T | undefined) : undefined
  }

  const legacyInject = config.memoryMode === 'legacy-inject'

  // ── storage ────────────────────────────────────────────────────────────
  const opened = ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => opened.then((domain) => domain.close()).catch(() => {}), 'dsh-memory-banks: close domain')

  // The repository is built lazily once the domain resolves; every tool call
  // awaits it, so a storage failure surfaces on first use instead of at load.
  let repository: MemoryRepository | undefined
  const repoReady: Promise<MemoryRepository> = opened.then((domain) => {
    repository = new MemoryRepository({
      memories: domain.table('memories'),
      standing: domain.table('standing'),
      state: domain.table('state'),
      skills: domain.table('skills'),
      reviews: domain.table('reviews'),
      consolidations: domain.table('consolidations'),
      global: domain.global,
      limits,
    })
    return repository
  })
  const repo = async (): Promise<MemoryRepository> => repoReady

  // ── active project (two-tier memory) ───────────────────────────────────
  const baseProject = core.projectKeyOf(process.cwd())
  const projectKey = (): string | undefined => baseProject

  // ── optional host services ─────────────────────────────────────────────
  const sessionQuery = service<SessionQueryEngine>('sessionQuery')
  const sessionSearch = sessionQuery === undefined
    ? undefined
    : async (
      query: string,
      options: { limit: number; snippetChars: number; role?: 'user' | 'assistant' },
    ): Promise<SessionHit[]> => {
      /** Host FTS5 search (token recall). */
      const tokens = async (): Promise<SessionHit[]> => {
        let page
        try {
          page = await sessionQuery.searchSessions({
            query,
            limit: options.role === undefined ? options.limit : Math.min(options.limit * 4, 100),
          })
        } catch (error) {
          const code = (error as { code?: string }).code ?? ''
          if (code === 'SESSION_QUERY_SEARCH_DISABLED') {
            throw new Error(
              'session history search is switched off in this deployment: the host ships its session index as `path: ":memory:"` + `openAt: never`. ' +
              'Enable it with the overlay shipped in this package (`dsh --profile <p> --patch ./enable-session-index.patch.yml`) or by patching the `session-query-sqlite` entry with a durable path and `openAt: first-search`.',
            )
          }
          throw error
        }
        return page.items
          .filter((item) => options.role === undefined || item.bestMatch?.type === `${options.role}/message`)
          .slice(0, options.limit)
          .map((item) => {
            const snippet = item.bestMatch?.snippet ?? ''
            return {
              sessionId: String(item.header?.id ?? ''),
              cwd: item.header?.cwd ?? undefined,
              snippet: snippet.length <= options.snippetChars ? snippet : snippet.slice(0, options.snippetChars),
            }
          })
      }

      /**
       * Literal, whitespace-flexible substring scan over recent sessions — the
       * host's documented escape hatch when token recall cannot match (short CJK).
       */
      const substring = async (): Promise<SessionHit[]> => {
        const records = await sessionQuery.listSessions()
        const recent = [...records]
          .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))
          .slice(0, Math.max(1, config.sessionSearchScanSessions))
        const hits: SessionHit[] = []
        for (const record of recent) {
          const documents = await sessionQuery.filterEvents(record.header.id, [{ kind: 'text', text: query }])
          const match = documents.find((document) => options.role === undefined || document.type === `${options.role}/message`)
          if (match === undefined) continue
          hits.push({
            sessionId: String(record.header.id),
            cwd: record.header.cwd ?? undefined,
            snippet: snippetAround(match.text, query, options.snippetChars),
          })
          if (hits.length >= options.limit) break
        }
        return hits
      }

      const primary = await tokens()
      if (!shouldFallbackToSubstring(config.sessionSearchMode, query, primary.length)) return primary
      const fallback = await substring()
      return fallback.length > 0 ? fallback : primary
    }

  const skills = service<SkillRegistry>('skills')
  // A provider (not `register`) is the right seam: provider results are re-read on
  // every catalog refresh, whereas `register` is first-wins and cannot update in place.
  const disposeSkillProvider = skills?.registerProvider((): SkillProvider => ({
    name,
    async list() {
      const ready = await repo()
      return ready.skills(undefined, projectKey()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.scope === 'project' ? 'project-dsh' : 'user-dsh',
        provider: name,
        rank: skill.scope === 'project' ? 450 : 500,
        locator: skill.id,
        invocation: { modelInvocable: true, userInvocable: true },
      }))
    },
    async get(candidate) {
      const ready = await repo()
      const locator = candidate.locator === undefined ? undefined : String(candidate.locator)
      const skill = locator === undefined ? undefined : ready.skill(locator)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        description: skill.description,
        content: skill.body,
        source: skill.scope === 'project' ? 'project-dsh' : 'user-dsh',
        provider: name,
        invocation: { modelInvocable: true, userInvocable: true },
      }
    },
  }))
  if (disposeSkillProvider !== undefined) {
    ctx.effect(() => disposeSkillProvider, 'dsh-memory-banks: skill provider')
  }

  // Tool bodies write through the storage domain; the catalog re-reads it, so
  // these hooks only need to exist for symmetry with the tool signatures.
  const skillSync = async (_record: SkillRecord): Promise<void> => {}
  const skillUnsync = async (_id: string): Promise<void> => {}

  // ── learning loop: background review + consolidation ───────────────────
  // `ctx.llm` is not injected (a deployment may have no model route); when it is
  // missing the loop degrades to "skipped" records instead of failing.
  const llm = service<LlmRuntimeLike>('llm')
  const defaultRoute = (): LlmRoute | undefined => {
    const selection = service<{ currentSelection?: () => { provider?: string; model?: string } }>('agentDefaultModel')?.currentSelection?.()
    return selection?.provider !== undefined && selection.model !== undefined
      ? { provider: selection.provider, model: selection.model }
      : undefined
  }
  const oneShot = llm === undefined
    ? undefined
    : createOneShot(llm, () => resolveRoute({ provider: config.llmProvider, model: config.llmModel, fallback: defaultRoute() }))

  const learning = createLearning({
    repo,
    config: {
      reviewEnabled: config.reviewEnabled,
      reviewMinTurns: config.reviewMinTurns,
      reviewMaxInputChars: config.reviewMaxInputChars,
      reviewMaxOperations: config.reviewMaxOperations,
      reviewTimeoutMs: config.reviewTimeoutMs,
      autoConsolidate: config.autoConsolidateOnOverflow,
      consolidationMaxEntries: config.consolidationMaxEntries,
      consolidationTimeoutMs: config.consolidationTimeoutMs,
      consolidationChunkChars: config.consolidationChunkChars,
    },
    oneShot,
    projectKey,
    log: (message) => console.log(`[${name}] ${message}`),
  })

  // Crash recovery: runs left non-terminal by a previous process are marked failed
  // (the bank itself is only ever replaced by one atomic write, so nothing is torn).
  void repoReady
    .then(() => learning.recoverInterrupted())
    .then((cleaned) => {
      if (cleaned > 0) console.log(`[${name}] recovered ${cleaned} interrupted learning run(s)`)
    })
    .catch(() => {})

  /**
   * Review throttle: `session/flush` fires often (several times per turn), so an
   * unthrottled review would call the model on every checkpoint. A per-session
   * watermark — last reviewed log offset plus wall clock — reduces that to "new
   * durably-logged events, at most once per `reviewMinIntervalMs`", the analogue
   * of upstream's nudge interval.
   */
  const reviewIfDue = async (session: {
    readonly id: string
    readonly seq: number
    snapshotEvents: () => readonly SessionEventLike[]
  }): Promise<void> => {
    const ready = await repo()
    const key = `review:${session.id}`
    const last = ready.stateGet<{ seq: number; ms: number }>(key, { seq: -1, ms: 0 })
    if (session.seq <= last.seq) return
    if (Date.now() - last.ms < config.reviewMinIntervalMs) return
    await ready.stateSet(key, { seq: session.seq, ms: Date.now() })
    await learning.reviewSession(session.id, session.snapshotEvents())
  }

  // The durability checkpoint is the review trigger (parallel, awaited by the host).
  ctx.on('session/flush', (session) => {
    void reviewIfDue(session).catch(() => {})
    void runRetention().catch(() => {})
  })

  // Session end: one final review (throttled the same way; the learning service
  // also refuses a second concurrent run for the same session).
  ctx.on('session/disposed', (session) => {
    if (!config.flushOnSessionEnd) return
    void reviewIfDue(session).catch(() => {})
  })

  /**
   * Bounded audit history: prunes review/consolidation rows older than
   * `sessionRetentionDays` at most once a day. Memory entries are never pruned —
   * they are the product, not the log.
   */
  async function runRetention(): Promise<void> {
    if (config.sessionRetentionDays <= 0) return
    const ready = await repo()
    const lastRun = ready.stateGet<number>('retention.lastRunMs', 0)
    const nowMs = Date.now()
    if (nowMs - lastRun < 86_400_000) return
    const before = new Date(nowMs - config.sessionRetentionDays * 86_400_000).toISOString()
    const removed = await ready.pruneHistory(before)
    await ready.stateSet('retention.lastRunMs', nowMs)
    if (removed > 0) console.log(`[${name}] pruned ${removed} audit row(s) older than ${config.sessionRetentionDays} day(s)`)
  }
  void repoReady.then(() => runRetention()).catch(() => {})

  // ── tools ──────────────────────────────────────────────────────────────
  for (const tool of createMemoryTools({
    repo,
    config: {
      searchLimit: config.searchLimit,
      sessionSearchLimit: config.sessionSearchLimit,
      maxSnippetChars: config.maxSnippetChars,
      usageHitTrackingEnabled: config.usageHitTrackingEnabled,
    },
    projectKey,
    sessionSearch,
    skillSync,
    skillUnsync,
    onOverflow: async (bank) => {
      if (!config.autoConsolidateOnOverflow || config.memoryOverflowStrategy !== 'auto-consolidate') return
      await learning.consolidateBank(bank, 'write overflow')
    },
  })) ctx.tools.register(tool)

  // ── prompt: policy + standing instructions ─────────────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-memory-banks',
    order: SECTION_ORDER,
    text: () => (ctx.tools.get('memory_add') === undefined ? '' : tpl.MEMORY_POLICY),
  }), 'dsh-memory-banks: policy section')

  // The system-prompt section provider is synchronous, so the pins are cached and
  // refreshed whenever they can change (write, session start, command).
  let standingCache: string[] = []
  const refreshStanding = async (): Promise<void> => {
    standingCache = (await repo()).standing().map((pin) => pin.text)
  }
  void refreshStanding().catch(() => {})
  ctx.on('session/created', () => void refreshStanding().catch(() => {}))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-memory-banks-standing',
    order: STANDING_SECTION_ORDER,
    text: () => {
      if (!config.standingInstructionsEnabled || standingCache.length === 0) return ''
      let budget = 0
      const kept: string[] = []
      for (const pin of standingCache) {
        if (budget + pin.length > config.maxStandingChars) break
        budget += pin.length
        kept.push(pin)
      }
      return tpl.standingBlock(kept)
    },
  }), 'dsh-memory-banks: standing section')

  // A settings-form edit arrives as a loader volatile update. The event is real
  // (the loader README and the market plugin use it) but is not declared in this
  // composition's `Events` type, hence the narrow cast. `limits` is mutated in
  // place because the repository holds this very object.
  const VOLATILE_UPDATE = 'loader/volatile-update' as 'session/flush'
  ctx.on(VOLATILE_UPDATE, () => {
    Object.assign(limits, limitsOf(config))
    void refreshStanding().catch(() => {})
  })

  // ── session counters, nudges, correction capture ───────────────────────
  interface SessionState { turns: number; toolCalls: number; corrections: number; nudges: number }
  const counters = new Map<string, SessionState>()
  const stateOf = (id: string): SessionState => {
    const existing = counters.get(id)
    if (existing !== undefined) return existing
    const created: SessionState = { turns: 0, toolCalls: 0, corrections: 0, nudges: 0 }
    counters.set(id, created)
    return created
  }
  const resetCounters = (id: string): void => {
    const state = stateOf(id)
    state.turns = 0
    state.toolCalls = 0
  }

  ctx.on('session/event', (session, event) => {
    const state = stateOf(session.id)
    if (event.type === 'turn/start') {
      state.turns += 1
      return
    }
    if (event.type === 'tool/call') {
      const toolName = (event.data as { name?: string } | undefined)?.name ?? ''
      if (toolName.startsWith('memory') || toolName === 'skill_manage') resetCounters(session.id)
      else state.toolCalls += 1
      return
    }
    if (event.type !== 'user/message' || !config.correctionDetection) return
    if (state.corrections >= config.correctionMaxPerSession) return
    const text = textOfEvent(event.data)
    const strength = tpl.classifyCorrection(text)
    if (strength === 'none') return
    state.corrections += 1
    void repo()
      .then((ready) => ready.add({
        target: 'user',
        content: tpl.correctionEntryText(text),
        category: 'correction',
        source: 'session',
      }))
      .catch(() => {
        // A refused duplicate or a full bank must never break the session.
      })
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = stateOf(payload.agent.session.id)
    if (state.turns < config.nudgeInterval && state.toolCalls < config.nudgeToolCalls) return decision
    resetCounters(payload.agent.session.id)
    state.nudges += 1
    return {
      kind: 'enter' as const,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: tpl.NUDGE_TEXT }],
        source: { kind: tpl.SOURCE_KIND, form: tpl.SOURCE_FORM_RECALL },
      })],
    }
  })

  // Frozen snapshot, once per session, in snapshot mode only.
  if (legacyInject) {
    const injected = new WeakSet<object>()
    ctx.on('agent/created', ({ agent }): undefined => {
      if (injected.has(agent)) return undefined
      injected.add(agent)
      void repo().then((ready) => {
        const banks = BANKS
          .map((bank) => ({ bank, rendered: core.renderBank(ready.all(), bank, limits[bank]) }))
          .filter((entry) => !entry.rendered.endsWith('(empty)'))
        if (banks.length === 0) return
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: tpl.snapshotText(banks) }],
          source: { kind: tpl.SOURCE_KIND, form: tpl.SOURCE_FORM_RECALL },
        }))
      }).catch(() => {})
      return undefined
    })
  }

  // ── commands ───────────────────────────────────────────────────────────
  // Declaring `input` makes the composer treat a bare `/cmd` + Enter as a claim
  // that needs a second Enter, so only commands that take arguments declare it.
  const command = (
    commandName: string,
    description: string,
    hint: string | undefined,
    handler: (rawInput: string) => Promise<string>,
  ): void => {
    ctx.commands.register({
      name: commandName,
      description,
      ...(hint === undefined ? {} : { input: { hint } }),
      handler: async (invocation) => {
        try {
          return { kind: 'success' as const, text: await handler(invocation.rawInput ?? '') }
        } catch (error) {
          return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }

  command('memory-insights', 'Show what the dsh-memory-banks banks currently hold', undefined, async () => {
    const ready = await repo()
    const pins = ready.standing()
    const skillList = ready.skills(undefined, projectKey())
    return [
      core.insights(ready.all(), limits),
      '',
      `Standing instructions (${pins.length}): ${pins.map((pin) => pin.text).join(' | ') || '(none)'}`,
      `Skills (${skillList.length}): ${skillList.map((skill) => skill.id).join(', ') || '(none)'}`,
    ].join('\n')
  })

  command('memory-pin', 'Pin a standing instruction injected into every session', '[<text> | remove <n> | clear | list]', async (rawInput) => {
    const ready = await repo()
    const input = rawInput.trim()
    if (input.length === 0 || input === 'list') {
      const pins = ready.standing()
      return pins.length === 0
        ? 'No standing instructions pinned.'
        : pins.map((pin, index) => `${index + 1}. ${pin.text}`).join('\n')
    }
    if (input === 'clear') {
      const removed = await ready.clearPins()
      await refreshStanding()
      return `Cleared ${removed} standing instruction(s).`
    }
    if (input.startsWith('remove ')) {
      const index = Number.parseInt(input.slice('remove '.length).trim(), 10)
      const pins = ready.standing()
      if (!Number.isInteger(index) || index < 1 || index > pins.length) throw new Error(`no standing instruction at position ${input.slice('remove '.length).trim()}`)
      await ready.unpin(pins[index - 1].id)
      await refreshStanding()
      return `Removed standing instruction ${index}.`
    }
    const record = await ready.pin({ kind: 'instruction', text: input })
    await refreshStanding()
    return `Pinned: ${record.text}`
  })

  command('memory-preview-context', 'Preview what memory injects into the system prompt', undefined, async () => {
    const ready = await repo()
    const pins = ready.standing().map((pin) => pin.text)
    const standing = config.standingInstructionsEnabled ? tpl.standingBlock(pins) : '(standing instructions disabled)'
    const snapshot = legacyInject
      ? BANKS.map((bank) => core.renderBank(ready.all(), bank, limits[bank])).join('\n\n')
      : '(snapshot injection disabled: memoryMode is policy-only)'
    return [tpl.MEMORY_POLICY, '', standing, '', snapshot].join('\n')
  })

  command('memory-switch-project', 'List the project-scoped memory banks', undefined, async () => {
    const ready = await repo()
    const byProject = new Map<string, number>()
    for (const record of ready.all()) {
      if (record.project === undefined) continue
      byProject.set(record.project, (byProject.get(record.project) ?? 0) + 1)
    }
    const active = projectKey() ?? '(none)'
    const lines = [...byProject.entries()].map(([key, count]) => `- ${key}: ${count} entr${count === 1 ? 'y' : 'ies'}`)
    return [`Active project: ${active}`, ...(lines.length === 0 ? ['No project-scoped memory yet.'] : lines)].join('\n')
  })

  command('memory-consolidate', 'Merge a memory bank back under its budget (defaults to the fullest bank)', '[<memory|user|project|failure>]', async (rawInput) => {
    const ready = await repo()
    const requested = rawInput.trim()
    const named = (BANKS as readonly string[]).includes(requested) ? (requested as Bank) : undefined
    const report = (bank: Bank): string => {
      const usage = ready.usage(bank)
      return `${bank}: ${usage.usage}`
    }
    const percentOf = (bank: Bank): number => {
      const usage = ready.usage(bank)
      return usage.limit > 0 ? Math.round((usage.chars / usage.limit) * 100) : 0
    }

    if (named !== undefined) {
      const outcome = await learning.consolidateBank(named, 'manual command')
      return outcome.applied
        ? `Consolidated ${named}: ${outcome.before} → ${outcome.after} entries.`
        : `No consolidation for ${named}: ${outcome.note}.`
    }

    const fullest = [...BANKS].sort((a, b) => percentOf(b) - percentOf(a))[0]
    const lines = BANKS.map((bank) => `${report(bank)} (${percentOf(bank)}%)`)
    if (percentOf(fullest) < 70) {
      return ['Nothing needs consolidating right now.', ...lines].join('\n')
    }
    const outcome = await learning.consolidateBank(fullest, 'manual command (fullest bank)')
    return [
      `Fullest bank: ${fullest} (${percentOf(fullest)}%).`,
      outcome.applied ? `Consolidated: ${outcome.before} → ${outcome.after} entries.` : `Not consolidated: ${outcome.note}.`,
      ...lines,
    ].join('\n')
  })

  command('memory-interview', 'Questions that pre-fill the user profile', undefined, async () => [
    'Answer these and I will save them to the `user` bank with memory_add:',
    tpl.INTERVIEW_QUESTIONS,
  ].join('\n'))

  command('memory-index-sessions', 'Report the state of the DSH session-history index', undefined, async () => {
    if (sessionQuery === undefined) return 'This profile serves no session-query service, so session_search is unavailable.'
    const sessions = await sessionQuery.listSessions()
    const indexed = (await repo()).all().length
    return [
      `Sessions visible to session_search: ${sessions.length}.`,
      `Memory entries stored: ${indexed}.`,
      'Indexing and backfill belong to the host (ctx.sessionQuery); this plugin never writes that index.',
    ].join('\n')
  })

  command('memory-skills', 'List the stored procedural skills', undefined, async () => {
    const ready = await repo()
    const list = ready.skills(undefined, projectKey())
    return list.length === 0
      ? 'No skills stored yet. Ask the model to create one with skill_manage.'
      : list.map((skill) => `- ${skill.id} [${skill.scope}] ${skill.description}`).join('\n')
  })

  // Self-documenting skill: the same contract the policy section states, readable
  // on demand through the host's skill catalog.
  command('learn-memory-tool', 'Save a global skill explaining how to use the memory tools', undefined, async () => {
    const ready = await repo()
    const id = 'using-dsh-memory-banks'
    if (ready.skill(id) !== undefined) return `Skill ${id} already exists — read it with skill_manage view ${id}.`
    const nowIso = new Date().toISOString()
    await ready.skillPut({
      id,
      scope: 'global',
      name: id,
      description: 'How to use the durable hermes memory banks: when to add, replace, remove, search, pin, consolidate, and save skills',
      body: tpl.memoryUsageSkillBody(),
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    return `Created global skill ${id}; the model sees it through the skill catalog.`
  })

  // ── optional panel route ───────────────────────────────────────────────
  // `ctx.inject` is the SUPPORTED way to consume a service that may be absent:
  // cordis throws when a plugin reads a service property it did not inject, and
  // `ctx.get('webServer')` does not reach a sibling-scope provider (verified
  // live — the route 404'd until this became scoped injection). Headless and SDK
  // profiles simply never run this callback, so the plugin still loads there.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as { webServer: WebServer }).webServer
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-memory-banks/stats',
      handler: (_req, res) => {
        const ready = repository
        const stats = ready === undefined
          ? { plugin: name, state: 'loading', banks: [], entries: [] }
          : {
            plugin: name,
            state: 'ready',
            memoryMode: config.memoryMode,
            project: projectKey() ?? null,
            banks: BANKS.map((bank) => ({
              bank,
              entries: core.entriesOf(ready.all(), bank).length,
              chars: core.charsOf(ready.all(), bank),
              limit: limits[bank],
              usage: core.usageLine(ready.all(), bank, limits[bank]),
            })),
            standing: ready.standing().map((pin) => pin.text),
            skills: ready.skills(undefined, projectKey()).map((skill) => ({ id: skill.id, scope: skill.scope })),
            entries: ready.of('memory', projectKey()),
          }
        const body = Buffer.from(JSON.stringify(stats), 'utf8')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
        res.end(body)
      },
    }), 'dsh-memory-banks: stats route')
  })

  void repoReady.then((ready) => {
    console.log(`[${name}] ready — ${ready.all().length} memory entr${ready.all().length === 1 ? 'y' : 'ies'}, ${ready.skills(undefined, projectKey()).length} skill(s)`)
  }).catch((error: unknown) => {
    console.log(`[${name}] storage unavailable: ${error instanceof Error ? error.message : String(error)}`)
  })
}
