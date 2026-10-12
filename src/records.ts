/**
 * Durable record schemas — zod only, zero DSH imports, so they are unit-testable
 * locally (`node --test`, no harness peers needed). `storage.ts` turns these into
 * the storage-domain spec that DSH validates at open time.
 *
 * Every field a later stage adds is OPTIONAL from version 1 on, so growing the
 * feature set never needs a domain version bump.
 */
import { z } from 'zod'

/** The four memory banks. */
export const BANKS = ['memory', 'user', 'project', 'failure'] as const
export type Bank = (typeof BANKS)[number]

/** Categories hermes-agent attaches to failure/correction entries. */
export const CATEGORIES = ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const
export type Category = (typeof CATEGORIES)[number]

/** Where an entry came from, so review/consolidation output stays auditable. */
export const SOURCES = ['tool', 'session', 'review', 'consolidation', 'import'] as const
export type Source = (typeof SOURCES)[number]

/** One stored memory, in one of the four banks. */
export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  bank: z.enum(BANKS),
  category: z.enum(CATEGORIES).optional(),
  /** Project key (workspace directory) for the `project` bank and project-scoped recall. */
  project: z.string().optional(),
  text: z.string().min(1),
  seq: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Recall counters, maintained while `usageHitTrackingEnabled` is on. */
  hitCount: z.number().int().nonnegative().optional(),
  lastHitAt: z.string().optional(),
  source: z.enum(SOURCES).optional(),
})

/** A standing instruction (`/memory-pin`). Only the user or a command writes here. */
export const standingRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['profile', 'instruction']),
  text: z.string().min(1),
  seq: z.number().int().nonnegative(),
  createdAt: z.string(),
})

/** Generic watermark/counter slot (JSON text): index progress, nudge counters, last review. */
export const stateRecordSchema = z.object({
  id: z.string().min(1),
  json: z.string(),
})

/** One background review pass, for audit and to bound retries. */
export const reviewRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string(),
  at: z.string(),
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  status: z.enum(['running', 'applied', 'skipped', 'failed']),
  ops: z.number().int().nonnegative(),
  note: z.string().optional(),
})

/** Crash-safe consolidation state machine: `prepared → replacements-written → completed | failed`. */
export const consolidationRecordSchema = z.object({
  id: z.string().min(1),
  target: z.enum(BANKS),
  status: z.enum(['prepared', 'replacements-written', 'completed', 'failed']),
  before: z.string(),
  after: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  attempts: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
})

/** A procedural skill (`skill_manage`), global or project scoped. */
export const skillRecordSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['global', 'project']),
  project: z.string().optional(),
  name: z.string().min(1),
  description: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One indexed session file, for incremental backfill (mtime/size compare). */
export const sessionIndexRecordSchema = z.object({
  file: z.string().min(1),
  mtimeMs: z.number(),
  size: z.number(),
  indexedAt: z.string(),
  messages: z.number().int().nonnegative(),
})

/** Domain global: the sequence counter every entry id ordering derives from. */
export const memoryGlobalSchema = z.object({ seq: z.number().int().nonnegative() })

export type MemoryRecord = z.infer<typeof memoryRecordSchema>
export type StandingRecord = z.infer<typeof standingRecordSchema>
export type StateRecord = z.infer<typeof stateRecordSchema>
export type ReviewRecord = z.infer<typeof reviewRecordSchema>
export type ConsolidationRecord = z.infer<typeof consolidationRecordSchema>
export type SkillRecord = z.infer<typeof skillRecordSchema>
export type SessionIndexRecord = z.infer<typeof sessionIndexRecordSchema>
export type MemoryGlobal = z.infer<typeof memoryGlobalSchema>
