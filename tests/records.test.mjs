// Schema tests for the zero-dependency record layer: these run without any DSH
// peer packages, so they are the local guard on the durable shape.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  consolidationRecordSchema,
  memoryGlobalSchema,
  memoryRecordSchema,
  reviewRecordSchema,
  sessionIndexRecordSchema,
  skillRecordSchema,
  standingRecordSchema,
  stateRecordSchema,
} from '../dist/records.js'

const entry = {
  id: 'use-pnpm-1a2b3c4d',
  bank: 'memory',
  text: 'project uses pnpm',
  seq: 1,
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
}

test('memoryRecord: minimal entry parses, later-stage fields stay optional', () => {
  const parsed = memoryRecordSchema.parse(entry)
  assert.equal(parsed.hitCount, undefined)
  assert.equal(parsed.lastHitAt, undefined)
  assert.equal(parsed.source, undefined)
  assert.equal(parsed.project, undefined)
})

test('memoryRecord: project scope, counters and provenance round-trip', () => {
  const parsed = memoryRecordSchema.parse({
    ...entry,
    bank: 'project',
    project: 'D:/Codes/skills/dsh-workspace',
    category: 'convention',
    hitCount: 3,
    lastHitAt: '2026-10-12T01:00:00.000Z',
    source: 'review',
  })
  assert.equal(parsed.bank, 'project')
  assert.equal(parsed.hitCount, 3)
  assert.equal(parsed.source, 'review')
})

test('memoryRecord: rejects unknown bank, empty text, negative seq, bad category', () => {
  assert.equal(memoryRecordSchema.safeParse({ ...entry, bank: 'nope' }).success, false)
  assert.equal(memoryRecordSchema.safeParse({ ...entry, text: '' }).success, false)
  assert.equal(memoryRecordSchema.safeParse({ ...entry, seq: -1 }).success, false)
  assert.equal(memoryRecordSchema.safeParse({ ...entry, category: 'made-up' }).success, false)
  assert.equal(memoryRecordSchema.safeParse({ ...entry, source: 'guess' }).success, false)
})

test('standing: only user-authored kinds exist', () => {
  const pin = { id: 'p1', kind: 'instruction', text: 'never run find /', seq: 1, createdAt: entry.createdAt }
  assert.equal(standingRecordSchema.safeParse(pin).success, true)
  assert.equal(standingRecordSchema.safeParse({ ...pin, kind: 'agent' }).success, false)
  assert.equal(standingRecordSchema.safeParse({ ...pin, text: '' }).success, false)
})

test('state: JSON text slot accepts any string, rejects a missing id', () => {
  assert.equal(stateRecordSchema.safeParse({ id: 'index.cursor', json: '{"file":"a.jsonl","mtimeMs":1}' }).success, true)
  assert.equal(stateRecordSchema.safeParse({ id: 'index.cursor' }).success, false)
})

test('review: status is constrained and counters are non-negative', () => {
  const review = { id: 'r1', sessionId: 's1', at: entry.createdAt, turns: 10, toolCalls: 15, status: 'applied', ops: 2 }
  assert.equal(reviewRecordSchema.safeParse(review).success, true)
  assert.equal(reviewRecordSchema.safeParse({ ...review, status: 'maybe' }).success, false)
  assert.equal(reviewRecordSchema.safeParse({ ...review, ops: -1 }).success, false)
})

test('consolidation: the crash-safe state machine only names its four states', () => {
  const base = { id: 'c1', target: 'memory', status: 'prepared', before: 'a§b', startedAt: entry.createdAt, updatedAt: entry.createdAt }
  assert.equal(consolidationRecordSchema.safeParse(base).success, true)
  for (const status of ['replacements-written', 'completed', 'failed']) {
    assert.equal(consolidationRecordSchema.safeParse({ ...base, status }).success, true)
  }
  assert.equal(consolidationRecordSchema.safeParse({ ...base, status: 'in-progress' }).success, false)
  assert.equal(consolidationRecordSchema.safeParse({ ...base, target: 'other' }).success, false)
})

test('skill: scope is required and bounded to global|project', () => {
  const skill = { id: 's1', scope: 'global', name: 'debug-typescript-errors', description: 'tsc failures', body: 'steps', createdAt: entry.createdAt, updatedAt: entry.createdAt }
  assert.equal(skillRecordSchema.safeParse(skill).success, true)
  assert.equal(skillRecordSchema.safeParse({ ...skill, scope: 'workspace' }).success, false)
  assert.equal(skillRecordSchema.safeParse({ ...skill, name: '' }).success, false)
})

test('session index: mtime/size watermark record', () => {
  const row = { file: 'session-abc.jsonl', mtimeMs: 1788505759987, size: 81086, indexedAt: entry.createdAt, messages: 42 }
  assert.equal(sessionIndexRecordSchema.safeParse(row).success, true)
  assert.equal(sessionIndexRecordSchema.safeParse({ ...row, file: '' }).success, false)
})

test('global: the sequence counter rejects negatives and non-integers', () => {
  assert.equal(memoryGlobalSchema.safeParse({ seq: 0 }).success, true)
  assert.equal(memoryGlobalSchema.safeParse({ seq: -1 }).success, false)
  assert.equal(memoryGlobalSchema.safeParse({ seq: 1.5 }).success, false)
})
