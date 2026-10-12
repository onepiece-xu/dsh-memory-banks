/**
 * The learning loop: background review and bank consolidation.
 *
 * Zero DSH imports — the model call arrives as an injected `oneShot`, so the whole
 * loop (projection, validation, state machine, error handling) is unit-testable
 * with a scripted fake model.
 *
 * Crash safety: a consolidation writes `prepared` before asking the model,
 * `replacements-written` before touching the bank, and `completed` afterwards.
 * Anything left in a non-terminal state by a crash is marked `failed` on the next
 * start (`recoverInterrupted`), and the bank is only ever replaced by one atomic
 * write, so a torn run never half-applies.
 */
import * as core from './core.js'
import { extractJson, readEntryList } from './json.js'
import type { Bank, ReviewRecord } from './records.js'
import type { MemoryRepository } from './repo.js'
import * as tpl from './templates.js'

export interface LearningConfig {
  reviewEnabled: boolean
  reviewMinTurns: number
  reviewMaxInputChars: number
  reviewMaxOperations: number
  reviewTimeoutMs: number
  autoConsolidate: boolean
  consolidationMaxEntries: number
  consolidationTimeoutMs: number
  /** Characters per merge round; 0 merges the whole bank in one call. */
  consolidationChunkChars: number
}

export interface OneShotResult {
  text: string
}

export interface LearningDeps {
  repo: () => Promise<MemoryRepository>
  config: LearningConfig
  /** One-shot model call; absent when the deployment has no model route. */
  oneShot?: (request: { system: string; user: string; maxTokens: number; timeoutMs: number; sessionId?: string }) => Promise<string>
  projectKey: () => string | undefined
  now?: () => string
  log?: (message: string) => void
}

/** The durable event fields this module reads (structural, so tests need no DSH). */
export interface SessionEventLike {
  type: string
  data?: unknown
}

export interface SessionProjection {
  sessionId: string
  turns: number
  toolCalls: number
  userText: string
  assistantText: string
  failures: string[]
}

/** Text of one event's content/message payload, tolerant of both shapes. */
export function textOfEvent(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const value = data as { content?: unknown; message?: unknown; text?: unknown }
  const blocks = Array.isArray(value.content)
    ? value.content
    : Array.isArray((value.message as { content?: unknown } | undefined)?.content)
      ? ((value.message as { content: unknown[] }).content)
      : []
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  if (parts.length === 0 && typeof value.text === 'string') parts.push(value.text)
  return parts.join('\n')
}

/** Fold a session's durable events into the review input, bounded to a budget. */
export function projectSession(
  sessionId: string,
  events: readonly SessionEventLike[],
  maxChars: number,
): SessionProjection {
  const users: string[] = []
  const assistants: string[] = []
  const failures: string[] = []
  let turns = 0
  let toolCalls = 0
  for (const event of events) {
    if (event.type === 'turn/start') turns += 1
    else if (event.type === 'tool/call') toolCalls += 1
    else if (event.type === 'user/message') {
      const text = textOfEvent(event.data)
      if (text.length > 0) users.push(text)
    } else if (event.type === 'assistant/message') {
      const text = textOfEvent(event.data)
      if (text.length > 0) assistants.push(text)
    } else if (event.type === 'tool/result') {
      const data = event.data as { error?: unknown; name?: unknown } | undefined
      if (data?.error !== undefined) failures.push(`${String(data.name ?? 'tool')}: ${String(data.error).slice(0, 200)}`)
    }
  }
  const half = Math.max(200, Math.floor(maxChars / 2))
  return {
    sessionId,
    turns,
    toolCalls,
    userText: tail(users.join('\n'), half),
    assistantText: tail(assistants.join('\n'), half),
    failures: failures.slice(-10),
  }
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

/** Group validated review operations into one atomic batch per bank. */
export function groupOperations(operations: readonly tpl.ReviewOperation[]): Map<Bank, core.Operation[]> {
  const grouped = new Map<Bank, core.Operation[]>()
  for (const operation of operations) {
    const list = grouped.get(operation.target) ?? []
    if (operation.kind === 'add') {
      const parsed: core.Operation = { action: 'add', text: operation.content }
      if (operation.category !== undefined) parsed.category = operation.category
      list.push(parsed)
    } else {
      const parsed: core.Operation = { action: 'replace', oldText: operation.oldText ?? '', text: operation.content }
      if (operation.category !== undefined) parsed.category = operation.category
      list.push(parsed)
    }
    grouped.set(operation.target, list)
  }
  return grouped
}

/** Total characters of a list of entries. */
export function sumChars(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + text.length, 0)
}

/**
 * The next chunk to merge: the leading entries whose combined size fits
 * `chunkChars` (always at least one, so an oversized single entry cannot stall
 * the loop — it simply has nothing to merge with and the caller stops).
 */
export function takeChunk(texts: readonly string[], chunkChars: number): string[] {
  const out: string[] = []
  let chars = 0
  for (const text of texts) {
    if (out.length > 0 && chars + text.length > chunkChars) break
    out.push(text)
    chars += text.length
  }
  return out
}

/** A consolidation plan must fit the budget before it is allowed near the bank. */
export function assertConsolidationBudget(texts: readonly string[], limit: number): void {
  const chars = sumChars(texts)
  if (chars > limit) throw new Error(`consolidation produced ${chars} chars, over the ${limit} budget`)
}

export interface ReviewOutcome {
  record: ReviewRecord
  applied: number
}

export interface ConsolidationOutcome {
  bank: Bank
  before: number
  after: number
  applied: boolean
  note: string
}

export interface LearningService {
  reviewSession(sessionId: string, events: readonly SessionEventLike[]): Promise<ReviewOutcome>
  consolidateBank(bank: Bank, reason: string): Promise<ConsolidationOutcome>
  recoverInterrupted(): Promise<number>
  busy(key: string): boolean
}

export function createLearning(deps: LearningDeps): LearningService {
  const inFlight = new Set<string>()
  const now = (): string => deps.now?.() ?? new Date().toISOString()
  const log = (message: string): void => deps.log?.(message)

  /**
   * Apply one review batch, making room first if a bank is full — the same policy
   * the write tools use. Without this, one over-budget proposal failed the whole
   * review even when every other operation was valid (observed live: a three-
   * operation project-bank review failed at 110% and again at 160% of budget).
   */
  async function applyBatchWithRoom(bank: Bank, batch: readonly core.Operation[]): Promise<number> {
    const repo = await deps.repo()
    const options = { source: 'review' as const, project: bank === 'project' ? deps.projectKey() : undefined }
    try {
      return (await repo.applyOperations(bank, batch, options)).applied
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/over budget/.test(message)) throw error
      await runConsolidation(bank, 'review needed room')
      return (await repo.applyOperations(bank, batch, options)).applied
    }
  }

  async function reviewSession(sessionId: string, events: readonly SessionEventLike[]): Promise<ReviewOutcome> {
    const key = `review:${sessionId}`
    if (inFlight.has(key)) {
      return {
        record: { id: `review:${sessionId}:${now()}`, sessionId, at: now(), turns: 0, toolCalls: 0, status: 'skipped', ops: 0, note: 'a review for this session is already running' },
        applied: 0,
      }
    }
    inFlight.add(key)
    try {
      return await runReview(sessionId, events)
    } finally {
      inFlight.delete(key)
    }
  }

  async function runReview(sessionId: string, events: readonly SessionEventLike[]): Promise<ReviewOutcome> {
    const repo = await deps.repo()
    const projection = projectSession(sessionId, events, deps.config.reviewMaxInputChars)
    const base: ReviewRecord = {
      id: `review:${sessionId}:${now()}`,
      sessionId,
      at: now(),
      turns: projection.turns,
      toolCalls: projection.toolCalls,
      status: 'running',
      ops: 0,
    }
    const finish = async (status: ReviewRecord['status'], ops: number, note?: string): Promise<ReviewOutcome> => {
      const record: ReviewRecord = { ...base, status, ops }
      if (note !== undefined) record.note = note
      await repo.reviewPut(record)
      return { record, applied: ops }
    }

    if (!deps.config.reviewEnabled) return { record: base, applied: 0 }
    if (projection.turns < deps.config.reviewMinTurns) {
      return finish('skipped', 0, `only ${projection.turns} turn(s)`)
    }
    if (deps.oneShot === undefined) return finish('skipped', 0, 'no model route available')
    if (projection.userText.length === 0 && projection.assistantText.length === 0) {
      return finish('skipped', 0, 'nothing to review')
    }

    await repo.reviewPut(base)
    try {
      const answer = await deps.oneShot({
        system: tpl.reviewSystemPrompt(),
        user: tpl.reviewUserPrompt({
          sessionId,
          projectKey: deps.projectKey(),
          userText: projection.userText,
          assistantText: projection.assistantText,
          failures: projection.failures,
        }, deps.config.reviewMaxInputChars),
        maxTokens: 1200,
        timeoutMs: deps.config.reviewTimeoutMs,
        sessionId,
      })
      const operations = tpl.validateReviewOperations(extractJson(answer), deps.config.reviewMaxOperations)
      if (operations.length === 0) return finish('skipped', 0, 'no durable candidates')

      let applied = 0
      for (const [bank, batch] of groupOperations(operations)) {
        applied += await applyBatchWithRoom(bank, batch)
      }
      log(`[review] applied ${applied} operation(s) from session ${sessionId}`)
      return finish('applied', applied)
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      log(`[review] failed for session ${sessionId}: ${note}`)
      return finish('failed', 0, note)
    }
  }

  async function consolidateBank(bank: Bank, reason: string): Promise<ConsolidationOutcome> {
    const key = `consolidate:${bank}`
    if (inFlight.has(key)) {
      return { bank, before: 0, after: 0, applied: false, note: 'a consolidation for this bank is already running' }
    }
    inFlight.add(key)
    try {
      return await runConsolidation(bank, reason)
    } finally {
      inFlight.delete(key)
    }
  }

  async function runConsolidation(bank: Bank, reason: string): Promise<ConsolidationOutcome> {
    const repo = await deps.repo()
    const before = repo.of(bank)
    const usage = repo.usage(bank)
    if (before.length < 2) {
      return { bank, before: before.length, after: before.length, applied: false, note: 'fewer than two entries; nothing to merge' }
    }
    if (deps.oneShot === undefined) {
      return { bank, before: before.length, after: before.length, applied: false, note: 'no model route available' }
    }

    const id = `consolidation:${bank}:${now()}`
    const startedAt = now()
    const originalTexts = before.map((entry) => entry.text)
    const beforeJson = JSON.stringify(originalTexts)
    const chunkChars = deps.config.consolidationChunkChars > 0
      ? deps.config.consolidationChunkChars
      : Number.MAX_SAFE_INTEGER

    let current = [...originalTexts]
    let rounds = 0
    let changed = false
    let firstRound = true

    const mergeOnce = async (chunk: readonly string[]): Promise<string[]> => {
      const answer = await deps.oneShot!({
        system: tpl.consolidationSystemPrompt(),
        user: tpl.consolidationUserPrompt({
          bank,
          usage: usage.usage,
          budget: usage.limit,
          maxEntries: deps.config.consolidationMaxEntries,
          entries: chunk,
        }),
        maxTokens: 1200,
        timeoutMs: deps.config.consolidationTimeoutMs,
      })
      return readEntryList(extractJson(answer), deps.config.consolidationMaxEntries)
    }

    const record = async (status: 'prepared' | 'replacements-written' | 'completed' | 'failed', note: string, after?: string): Promise<void> => {
      await repo.consolidationPut({
        id,
        target: bank,
        status,
        before: beforeJson,
        ...(after === undefined ? {} : { after }),
        startedAt,
        updatedAt: now(),
        attempts: rounds,
        note,
      })
    }

    await record('prepared', reason)

    // Chunked rounds: merge a bounded slice at a time, keep going while the plan
    // actually shrinks, and persist the plan after every round for observability.
    // The bank itself is only replaced ONCE at the end, so a crash mid-run leaves
    // the bank untouched (and the next start marks the row failed).
    try {
      const maxRounds = sumChars(current) <= chunkChars ? 1 : 6
      while (rounds < maxRounds) {
        const total = sumChars(current)
        // A manual run always merges at least once (tidying up under budget is the
        // point of `/memory-consolidate`); later rounds only continue while over.
        if (!firstRound && total <= usage.limit) break
        let chunk = takeChunk(current, chunkChars)
        // A chunk holding one entry has nothing to merge with; widen to two so the
        // loop can always make progress (an oversized single entry is the only case
        // that legitimately stops here).
        if (chunk.length < 2 && current.length >= 2) chunk = current.slice(0, 2)
        if (chunk.length < 2) break
        rounds += 1
        firstRound = false
        const merged = await mergeOnce(chunk)
        const next = [...merged, ...current.slice(chunk.length)]
        // Only a chunk that covered the whole bank is the finished plan, so only
        // then must the result fit the budget (intermediate rounds may still be over).
        if (chunk.length === current.length) assertConsolidationBudget(next, usage.limit)
        if (sumChars(next) >= total) {
          rounds -= 1
          break // no progress: stop rather than rewrite the same bank
        }
        current = next
        changed = true
        await record('prepared', `${reason} (round ${rounds})`, JSON.stringify(current))
      }
      if (!changed) throw new Error('the model did not reduce the bank; nothing was written')

      const stillOver = sumChars(current) > usage.limit
      await record('replacements-written', stillOver ? `${reason} (partial: still over budget)` : reason, JSON.stringify(current))
      await repo.replaceBank(bank, current)
      await record('completed', stillOver ? `${reason} (partial: still over budget)` : reason, JSON.stringify(current))
      log(`[consolidate] ${bank}: ${originalTexts.length} → ${current.length} entr${current.length === 1 ? 'y' : 'ies'} in ${rounds} round(s)${stillOver ? ' (partial)' : ''}`)
      return { bank, before: originalTexts.length, after: current.length, applied: true, note: stillOver ? 'partial' : reason }
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      await record('failed', note)
      log(`[consolidate] ${bank} failed: ${note}`)
      return { bank, before: originalTexts.length, after: before.length, applied: false, note }
    }
  }

  /** Mark runs a crash left non-terminal as failed; returns how many were cleaned. */
  async function recoverInterrupted(): Promise<number> {
    const repo = await deps.repo()
    let cleaned = 0
    for (const record of repo.consolidations()) {
      if (record.status === 'completed' || record.status === 'failed') continue
      await repo.consolidationPut({ ...record, status: 'failed', updatedAt: now(), note: 'interrupted before completion' })
      cleaned += 1
    }
    for (const record of repo.reviews()) {
      if (record.status !== 'running') continue
      await repo.reviewPut({ ...record, status: 'failed', note: 'interrupted before completion' })
      cleaned += 1
    }
    return cleaned
  }

  return {
    reviewSession,
    consolidateBank,
    recoverInterrupted,
    busy: (key: string) => inFlight.has(key),
  }
}
