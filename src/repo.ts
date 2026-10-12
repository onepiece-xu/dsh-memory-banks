/**
 * The memory repository: every read/write rule in one place, over a structural
 * KV-table interface, so it is unit-testable with a Map-backed double while the
 * DSH host half only passes in `domain.table(...)` handles.
 *
 * Invariants enforced here (ported from pi-hermes-memory):
 *   - scan before every store: secrets / injected instructions are refused
 *   - bounded banks: a write that would exceed the budget is refused with the overage
 *   - exact-match-first lookup; an ambiguous `old_text` is an error, never a guess
 *   - a failed write rolls the touched records back, so a batch never half-applies
 */
import * as core from './core.js'
import type { BankLimits } from './core.js'
import { scanDetailed } from './core.js'
import type {
  Bank,
  Category,
  ConsolidationRecord,
  MemoryGlobal,
  MemoryRecord,
  ReviewRecord,
  SkillRecord,
  Source,
  StandingRecord,
  StateRecord,
} from './records.js'

/** Structural subset of a storage-domain KV table. */
export interface Tablet<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<string>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** The domain's global singleton slot. */
export interface GlobalSlot {
  get(): MemoryGlobal
  set(value: MemoryGlobal): Promise<void>
}

export interface MemoryRepositoryOptions {
  memories: Tablet<MemoryRecord>
  standing: Tablet<StandingRecord>
  state: Tablet<StateRecord>
  skills: Tablet<SkillRecord>
  reviews: Tablet<ReviewRecord>
  consolidations: Tablet<ConsolidationRecord>
  global: GlobalSlot
  limits: BankLimits
  now?: () => string
}

export interface AddInput {
  target: Bank
  content: string
  category?: Category
  project?: string
  source?: Source
}

export interface UsageResult {
  usage: string
  chars: number
  limit: number
  count: number
}

export interface AddResult extends UsageResult {
  record: MemoryRecord
}

export interface RemoveResult extends UsageResult {
  removed: MemoryRecord
}

/** Refusals carry the rule ids so a tool result can explain itself. */
export class ScanRefusal extends Error {
  readonly hits: string[]
  constructor(hits: string[]) {
    super(`refused to store: content trips ${hits.join(', ')}`)
    this.name = 'ScanRefusal'
    this.hits = hits
  }
}

export class MemoryRepository {
  readonly #options: MemoryRepositoryOptions

  constructor(options: MemoryRepositoryOptions) {
    this.#options = options
  }

  get limits(): BankLimits {
    return this.#options.limits
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString()
  }

  #seq(): number {
    return this.#options.global.get().seq
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /** Every stored entry (any bank). */
  all(): MemoryRecord[] {
    return [...this.#options.memories.entries()].map(([, record]) => record)
  }

  get(id: string): MemoryRecord | undefined {
    return this.#options.memories.get(id)
  }

  /**
   * Entries of one bank, in insertion order. With a project key, global entries
   * (no `project`) are included alongside that project's entries.
   */
  of(bank: Bank, project?: string): MemoryRecord[] {
    return this.all()
      .filter((record) => record.bank === bank)
      .sort((a, b) => a.seq - b.seq)
      .filter((record) => (project === undefined ? true : record.project === undefined || record.project === project))
  }

  /** Keyword search: every word must appear; scoped by bank / category / project. */
  find(
    query: string,
    options: { banks?: readonly Bank[]; category?: Category; project?: string; limit?: number } = {},
  ): MemoryRecord[] {
    const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
    return this.all()
      .filter((record) => {
        if (options.banks !== undefined && !options.banks.includes(record.bank)) return false
        if (options.category !== undefined && record.category !== options.category) return false
        if (options.project !== undefined && record.project !== undefined && record.project !== options.project) return false
        if (words.length === 0) return true
        const haystack = record.text.toLowerCase()
        return words.every((word) => haystack.includes(word))
      })
      .sort((a, b) => b.seq - a.seq)
      .slice(0, options.limit ?? 10)
  }

  usage(bank: Bank): UsageResult {
    const all = this.all()
    return {
      usage: core.usageLine(all, bank, this.limits[bank]),
      chars: core.charsOf(all, bank),
      limit: this.limits[bank],
      count: core.entriesOf(all, bank).length,
    }
  }

  standing(): StandingRecord[] {
    return [...this.#options.standing.entries()].map(([, record]) => record).sort((a, b) => a.seq - b.seq)
  }

  stateGet<T>(id: string, fallback: T): T {
    const record = this.#options.state.get(id)
    if (record === undefined) return fallback
    try {
      return JSON.parse(record.json) as T
    } catch {
      return fallback
    }
  }

  /**
   * Skills of the requested scope. Without a project key every scope is listed;
   * with one, global skills plus that project's skills are returned.
   */
  skills(scope?: SkillRecord['scope'], project?: string): SkillRecord[] {
    return [...this.#options.skills.entries()]
      .map(([, record]) => record)
      .filter((record) => (scope === undefined ? true : record.scope === scope))
      .filter((record) => (project === undefined ? true : record.scope === 'global' || record.project === project))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  skill(id: string): SkillRecord | undefined {
    return this.#options.skills.get(id)
  }

  reviews(): ReviewRecord[] {
    return [...this.#options.reviews.entries()].map(([, record]) => record).sort((a, b) => a.at.localeCompare(b.at))
  }

  consolidations(): ConsolidationRecord[] {
    return [...this.#options.consolidations.entries()]
      .map(([, record]) => record)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  // ── write plumbing ─────────────────────────────────────────────────────

  #assertScannable(text: string): void {
    const hits = scanDetailed(text)
    if (hits.length > 0) throw new ScanRefusal(hits.map((hit) => hit.id))
  }

  /**
   * Rebuild durable records from the pure algebra's output: metadata the algebra
   * does not carry (project, source, recall counters) is preserved from the
   * previous record, and only NEW entries get the caller's project/source.
   */
  #project(
    entries: readonly core.MemoryEntry[],
    previous: ReadonlyMap<string, MemoryRecord>,
    input: { project?: string; source?: Source },
  ): MemoryRecord[] {
    return entries.map((entry) => {
      const before = previous.get(entry.id)
      const record: MemoryRecord = {
        id: entry.id,
        bank: entry.bank,
        text: entry.text,
        seq: entry.seq,
        createdAt: before?.createdAt ?? entry.createdAt,
        updatedAt: entry.updatedAt,
      }
      const category = entry.category ?? before?.category
      if (category !== undefined) record.category = category
      // Scope is identity: an existing record keeps its own project, a new one is
      // stamped by the caller (otherwise adding to one project re-stamps the rest).
      const project = before === undefined ? input.project : before.project
      if (project !== undefined) record.project = project
      // Provenance is per-write: only entries this operation created or changed
      // carry the caller's source, so an unrelated add never relabels old entries.
      const changed = before === undefined || before.text !== entry.text || before.category !== entry.category
      const source = changed ? input.source ?? before?.source : before?.source
      if (source !== undefined) record.source = source
      if (before?.hitCount !== undefined) record.hitCount = before.hitCount
      if (before?.lastHitAt !== undefined) record.lastHitAt = before.lastHitAt
      return record
    })
  }

  /** Persist the difference between two entry lists; a failed write rolls back. */
  async #commit(before: readonly MemoryRecord[], after: readonly MemoryRecord[], nextSeq: number): Promise<void> {
    const table = this.#options.memories
    const beforeById = new Map(before.map((record) => [record.id, record]))
    const afterById = new Map(after.map((record) => [record.id, record]))
    const touched: string[] = []
    try {
      for (const record of after) {
        const previous = beforeById.get(record.id)
        const changed =
          previous === undefined ||
          previous.text !== record.text ||
          previous.category !== record.category ||
          previous.source !== record.source ||
          previous.project !== record.project
        if (changed) {
          touched.push(record.id)
          await table.put(record.id, record)
        }
      }
      for (const id of beforeById.keys()) {
        if (!afterById.has(id)) {
          touched.push(id)
          await table.delete(id)
        }
      }
      await this.#options.global.set({ seq: nextSeq })
    } catch (error) {
      for (const id of touched.reverse()) {
        const previous = beforeById.get(id)
        try {
          if (previous === undefined) await table.delete(id)
          else await table.put(id, previous)
        } catch {
          // Keep the original failure; a rollback failure must not mask it.
        }
      }
      throw error
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /** Add one entry to a bank. */
  async add(input: AddInput): Promise<AddResult> {
    const content = input.content.trim()
    if (content.length === 0) throw new Error('memory_add requires non-empty content')
    this.#assertScannable(content)

    const before = this.all()
    const base = this.#seq()
    const operation = core.parseOperation({ action: 'add', text: content, category: input.category })
    const next = core.stepOperation(core.entriesOf(before, input.target), input.target, operation, base + 1, this.#now())
    const merged = this.#project(
      next,
      new Map(before.map((record) => [record.id, record])),
      { project: input.project, source: input.source },
    )
    const untouched = before.filter((record) => record.bank !== input.target)
    const after = [...untouched, ...merged]
    core.assertWithinLimit(after, input.target, this.limits[input.target])
    await this.#commit(before, after, base + 1)
    const created = after.find((record) => record.id === core.entryId(content))
    if (created === undefined) throw new Error('internal error: added entry not found')
    return { record: created, ...this.usage(input.target) }
  }

  /** Replace the entry identified by `oldText` (exact match first, then substring). */
  async replace(input: { target: Bank; oldText: string; content: string; category?: Category; project?: string }): Promise<AddResult> {
    const content = input.content.trim()
    const oldText = input.oldText.trim()
    if (content.length === 0) throw new Error('memory_replace requires non-empty content')
    if (oldText.length === 0) throw new Error('memory_replace requires old_text')
    this.#assertScannable(content)

    const before = this.all()
    const bankEntries = core.entriesOf(before, input.target)
    const target = core.matchEntry(bankEntries, input.target, oldText)
    const base = this.#seq()
    const operation = core.parseOperation({ action: 'replace', old_text: oldText, text: content, category: input.category })
    const next = core.stepOperation(bankEntries, input.target, operation, base + 1, this.#now())
    const merged = this.#project(
      next,
      new Map(before.map((record) => [record.id, record])),
      { project: input.project },
    )
    const after = [...before.filter((record) => record.bank !== input.target), ...merged]
    core.assertWithinLimit(after, input.target, this.limits[input.target])
    await this.#commit(before, after, base + 1)
    const updated = after.find((record) => record.id === target.id)
    if (updated === undefined) throw new Error('internal error: replaced entry not found')
    return { record: updated, ...this.usage(input.target) }
  }

  /** Remove the entry identified by `oldText`. */
  async remove(input: { target: Bank; oldText: string }): Promise<RemoveResult> {
    const oldText = input.oldText.trim()
    if (oldText.length === 0) throw new Error('memory_remove requires old_text')
    const before = this.all()
    const bankEntries = core.entriesOf(before, input.target)
    const target = core.matchEntry(bankEntries, input.target, oldText)
    const base = this.#seq()
    const next = core.stepOperation(bankEntries, input.target, core.parseOperation({ action: 'remove', old_text: oldText }), base + 1, this.#now())
    const after = [...before.filter((record) => record.bank !== input.target), ...this.#project(next, new Map(), {})]
    await this.#commit(before, after, base + 1)
    return { removed: target, ...this.usage(input.target) }
  }

  /** Apply a review/consolidation plan as one atomic batch on one bank. */
  async applyOperations(
    target: Bank,
    operations: readonly core.Operation[],
    options: { project?: string; source?: Source } = {},
  ): Promise<{ applied: number; usage: string }> {
    if (operations.length === 0) return { applied: 0, usage: this.usage(target).usage }
    for (const operation of operations) {
      if (operation.action !== 'remove') this.#assertScannable(operation.text)
    }
    const before = this.all()
    const bankEntries = core.entriesOf(before, target)
    const base = this.#seq()
    const next = core.applyBatch(bankEntries, target, operations, base + 1, this.#now(), this.limits[target])
    const merged = this.#project(next, new Map(before.map((record) => [record.id, record])), options)
    const after = [...before.filter((record) => record.bank !== target), ...merged]
    core.assertWithinLimit(after, target, this.limits[target])
    await this.#commit(before, after, base + operations.length)
    return { applied: operations.length, usage: this.usage(target).usage }
  }

  /** Replace a whole bank with `texts`, preserving order (consolidation result). */
  async replaceBank(target: Bank, texts: readonly string[]): Promise<{ applied: number; usage: string }> {
    for (const text of texts) this.#assertScannable(text)
    const before = this.all()
    const now = this.#now()
    const base = this.#seq()
    const rebuilt: MemoryRecord[] = texts.map((text, index) => ({
      id: core.entryId(text),
      bank: target,
      text,
      seq: base + index + 1,
      createdAt: now,
      updatedAt: now,
      source: 'consolidation',
    }))
    const after = [...before.filter((record) => record.bank !== target), ...rebuilt]
    core.assertWithinLimit(after, target, this.limits[target])
    await this.#commit(before, after, base + texts.length)
    return { applied: texts.length, usage: this.usage(target).usage }
  }

  /** Record a recall hit for aging / usage signals. */
  async noteHits(records: readonly MemoryRecord[]): Promise<void> {
    if (records.length === 0) return
    const now = this.#now()
    for (const record of records) {
      const current = this.#options.memories.get(record.id)
      if (current === undefined) continue
      await this.#options.memories.put(record.id, {
        ...current,
        hitCount: (current.hitCount ?? 0) + 1,
        lastHitAt: now,
      })
    }
  }

  async pin(input: { kind: StandingRecord['kind']; text: string }): Promise<StandingRecord> {
    const text = input.text.trim()
    if (text.length === 0) throw new Error('a standing instruction needs text')
    this.#assertScannable(text)
    const seq = this.#seq() + 1
    const record: StandingRecord = {
      id: core.entryId(`pin:${text}`),
      kind: input.kind,
      text,
      seq,
      createdAt: this.#now(),
    }
    await this.#options.standing.put(record.id, record)
    await this.#options.global.set({ seq })
    return record
  }

  async unpin(id: string): Promise<boolean> {
    return this.#options.standing.delete(id)
  }

  async clearPins(): Promise<number> {
    const ids = [...this.#options.standing.keys()]
    for (const id of ids) await this.#options.standing.delete(id)
    return ids.length
  }

  async stateSet(id: string, value: unknown): Promise<void> {
    await this.#options.state.put(id, { id, json: JSON.stringify(value) })
  }

  async skillPut(record: SkillRecord): Promise<void> {
    await this.#options.skills.put(record.id, record)
  }

  async skillDelete(id: string): Promise<boolean> {
    return this.#options.skills.delete(id)
  }

  async reviewPut(record: ReviewRecord): Promise<void> {
    await this.#options.reviews.put(record.id, record)
  }

  async consolidationPut(record: ConsolidationRecord): Promise<void> {
    await this.#options.consolidations.put(record.id, record)
  }

  /**
   * Drop audit history older than `before` (an ISO timestamp): review runs and
   * consolidation runs. Bounded tables are the analogue of upstream's
   * `sessionRetentionDays` pruning — the memory entries themselves are NEVER
   * pruned, because they are the product, not the log.
   */
  async pruneHistory(before: string): Promise<number> {
    let removed = 0
    for (const record of this.reviews()) {
      if (record.at < before) {
        await this.#options.reviews.delete(record.id)
        removed += 1
      }
    }
    for (const record of this.consolidations()) {
      if (record.startedAt < before) {
        await this.#options.consolidations.delete(record.id)
        removed += 1
      }
    }
    return removed
  }
}
