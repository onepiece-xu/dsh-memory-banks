// Learning-loop tests: projection, review, consolidation, crash recovery — all
// driven by a scripted fake model, so no DSH package and no API call is involved.
import test from 'node:test'
import assert from 'node:assert/strict'

import { assertConsolidationBudget, createLearning, groupOperations, projectSession, sumChars, takeChunk, textOfEvent } from '../dist/learning.js'
import { MemoryRepository } from '../dist/repo.js'
import { DEFAULT_LIMITS, makeRepo, tickingNow } from './helpers.mjs'

const CONFIG = {
  reviewEnabled: true,
  reviewMinTurns: 6,
  reviewMaxInputChars: 600,
  reviewMaxOperations: 8,
  reviewTimeoutMs: 5000,
  autoConsolidate: true,
  consolidationMaxEntries: 20,
  consolidationTimeoutMs: 5000,
  consolidationChunkChars: 0,
}

function textEvent(text) { return { type: 'user/message', data: { content: [{ type: 'text', text }] } } }

function makeLearning({ repo, answer, config = {}, oneShot } = {}) {
  const calls = []
  const service = createLearning({
    repo: async () => repo,
    config: { ...CONFIG, ...config },
    oneShot: oneShot ?? (async (request) => {
      calls.push(request)
      if (typeof answer === 'function') return answer(request)
      return answer ?? '{"operations":[]}'
    }),
    projectKey: () => 'alpha-11111111',
    now: tickingNow(),
    log: () => {},
  })
  return { service, calls }
}

test('textOfEvent reads both content shapes', () => {
  assert.equal(textOfEvent({ content: [{ type: 'text', text: 'hello' }, { type: 'image' }] }), 'hello')
  assert.equal(textOfEvent({ message: { content: [{ type: 'text', text: 'nested' }] } }), 'nested')
  assert.equal(textOfEvent({ text: 'plain' }), 'plain')
  assert.equal(textOfEvent(null), '')
  assert.equal(textOfEvent({ content: [] }), '')
})

test('projectSession counts turns/tool calls and trims to a budget', () => {
  const events = [
    { type: 'turn/start' },
    textEvent('u'.repeat(100)),
    { type: 'tool/call', data: { name: 'read' } },
    { type: 'tool/result', data: { name: 'read', error: 'boom' } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'a'.repeat(100) }] } },
    { type: 'turn/start' },
  ]
  const projection = projectSession('session-1', events, 100)
  assert.equal(projection.turns, 2)
  assert.equal(projection.toolCalls, 1)
  assert.equal(projection.failures.length, 1)
  assert.match(projection.failures[0], /^read: boom$/)
  // The tail is kept, so the most recent context survives trimming (half = 200 floor).
  assert.ok(projection.userText.length <= 200)
  assert.ok(projection.assistantText.length <= 200)
})

test('groupOperations batches per bank and keeps replace needles', () => {
  const grouped = groupOperations([
    { kind: 'add', target: 'memory', content: 'uses pnpm' },
    { kind: 'replace', target: 'memory', content: 'uses pnpm 9', oldText: 'pnpm' },
    { kind: 'add', target: 'user', content: 'prefers terse answers', category: 'preference' },
  ])
  assert.deepEqual([...grouped.keys()].sort(), ['memory', 'user'])
  assert.deepEqual(grouped.get('memory'), [
    { action: 'add', text: 'uses pnpm' },
    { action: 'replace', oldText: 'pnpm', text: 'uses pnpm 9' },
  ])
  assert.deepEqual(grouped.get('user'), [{ action: 'add', text: 'prefers terse answers', category: 'preference' }])
})

test('assertConsolidationBudget refuses an over-budget plan', () => {
  assertConsolidationBudget(['aaa', 'bbb'], 6)
  assert.throws(() => assertConsolidationBudget(['aaa', 'bbb'], 5), /over the 5 budget/)
})

test('review below the turn threshold is skipped without calling the model', async () => {
  const { repo, tables } = makeRepo()
  const { service, calls } = makeLearning({ repo })
  const outcome = await service.reviewSession('s1', [{ type: 'turn/start' }, textEvent('short session')])
  assert.equal(outcome.record.status, 'skipped')
  assert.match(outcome.record.note, /only 1 turn/)
  assert.equal(calls.length, 0)
  assert.equal(tables.reviews.size, 1)
})

test('review applies validated operations per bank and records the run', async () => {
  const { repo } = makeRepo()
  const { service } = makeLearning({
    repo,
    answer: JSON.stringify({
      operations: [
        { kind: 'add', target: 'user', content: 'prefers pnpm over npm' },
        { kind: 'add', target: 'memory', content: 'tests run with node --test' },
        { kind: 'add', target: 'nope', content: 'dropped: unknown target' },
        { kind: 'delete', target: 'memory', content: 'dropped: deletes are never trusted' },
      ],
    }),
  })
  const events = Array.from({ length: 6 }, (_, index) => ({ type: 'turn/start', index }))
  events.push(textEvent('please use pnpm'))
  const outcome = await service.reviewSession('s2', events)
  assert.equal(outcome.record.status, 'applied')
  assert.equal(outcome.applied, 2)
  assert.deepEqual(repo.all().map((entry) => entry.text).sort(), ['prefers pnpm over npm', 'tests run with node --test'])
  assert.ok(repo.all().every((entry) => entry.source === 'review'))
  assert.equal(repo.reviews().length, 1)
  assert.equal(repo.reviews()[0].status, 'applied')
})

test('a model answer with nothing usable is a skip, a broken call is a failure', async () => {
  const { repo } = makeRepo()
  const events = Array.from({ length: 6 }, (_, index) => ({ type: 'turn/start', index }))
  events.push(textEvent('nothing durable here'))

  const skipped = makeLearning({ repo, answer: '{"operations":[]}' })
  assert.equal((await skipped.service.reviewSession('s3', events)).record.status, 'skipped')

  const failed = makeLearning({ repo, oneShot: async () => { throw new Error('provider exploded') } })
  const outcome = await failed.service.reviewSession('s4', events)
  assert.equal(outcome.record.status, 'failed')
  assert.match(outcome.record.note, /provider exploded/)
  assert.equal(repo.all().length, 0)
})

test('without a model route the review is skipped, not failed', async () => {
  const { repo } = makeRepo()
  const service = createLearning({
    repo: async () => repo,
    config: CONFIG,
    projectKey: () => undefined,
    now: tickingNow(),
  })
  const events = Array.from({ length: 6 }, (_, index) => ({ type: 'turn/start', index }))
  events.push(textEvent('hello'))
  const outcome = await service.reviewSession('s5', events)
  assert.equal(outcome.record.status, 'skipped')
  assert.match(outcome.record.note, /no model route/)
})

test('consolidation merges a bank, records the state machine, and stays idempotent', async () => {
  const { repo } = makeRepo({ limits: { ...DEFAULT_LIMITS, memory: 200 } })
  await repo.add({ target: 'memory', content: 'project uses pnpm' })
  await repo.add({ target: 'memory', content: 'project uses pnpm for installs' })
  await repo.add({ target: 'memory', content: 'tests run with node --test' })

  const { service } = makeLearning({ repo, answer: '```json\n{"entries":["project uses pnpm","tests run with node --test"]}\n```' })
  const outcome = await service.consolidateBank('memory', 'test')
  assert.equal(outcome.applied, true)
  assert.equal(outcome.before, 3)
  assert.equal(outcome.after, 2)
  assert.deepEqual(repo.all().filter((entry) => entry.bank === 'memory').map((entry) => entry.text), [
    'project uses pnpm',
    'tests run with node --test',
  ])
  const row = repo.consolidations()[0]
  assert.equal(row.status, 'completed')
  assert.match(row.before, /uses pnpm for installs/)
  assert.match(row.after, /tests run with node --test/)
})

test('a consolidation that breaks the budget fails and leaves the bank intact', async () => {
  const { repo } = makeRepo()
  await repo.add({ target: 'memory', content: 'short one' })
  await repo.add({ target: 'memory', content: 'short two' })
  const { service } = makeLearning({ repo, answer: JSON.stringify({ entries: ['x'.repeat(100)] }) })
  const outcome = await service.consolidateBank('memory', 'test')
  assert.equal(outcome.applied, false)
  assert.match(outcome.note, /over the 60 budget/)
  assert.deepEqual(repo.all().map((entry) => entry.text), ['short one', 'short two'])
  assert.equal(repo.consolidations()[0].status, 'failed')
})

test('consolidation skips tiny banks and missing model routes', async () => {
  const { repo } = makeRepo()
  await repo.add({ target: 'memory', content: 'only entry' })
  const single = makeLearning({ repo })
  assert.match((await single.service.consolidateBank('memory', 'test')).note, /fewer than two entries/)

  await repo.add({ target: 'memory', content: 'second entry' })
  const noRoute = createLearning({ repo: async () => repo, config: CONFIG, projectKey: () => undefined, now: tickingNow() })
  assert.match((await noRoute.consolidateBank('memory', 'test')).note, /no model route/)
})

test('interrupted runs are recovered as failed on the next start', async () => {
  const { repo } = makeRepo()
  await repo.consolidationPut({
    id: 'c1', target: 'memory', status: 'prepared', before: '[]', startedAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
  })
  await repo.consolidationPut({
    id: 'c2', target: 'user', status: 'completed', before: '[]', startedAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
  })
  await repo.reviewPut({
    id: 'r1', sessionId: 's', at: '2026-10-12T00:00:00.000Z', turns: 7, toolCalls: 1, status: 'running', ops: 0,
  })
  const { service } = makeLearning({ repo })
  assert.equal(await service.recoverInterrupted(), 2)
  assert.equal(repo.consolidations().find((row) => row.id === 'c1').status, 'failed')
  assert.equal(repo.consolidations().find((row) => row.id === 'c2').status, 'completed')
  assert.equal(repo.reviews()[0].status, 'failed')
  // Idempotent: a second pass finds nothing left to clean.
  assert.equal(await service.recoverInterrupted(), 0)
})

test('concurrent runs for the same session or bank are refused, not interleaved', async () => {  const { repo } = makeRepo()
  await repo.add({ target: 'memory', content: 'a fact' })
  await repo.add({ target: 'memory', content: 'another fact' })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { service } = makeLearning({
    repo,
    oneShot: async () => {
      await gate
      return JSON.stringify({ entries: ['merged fact'] })
    },
  })
  const first = service.consolidateBank('memory', 'first')
  const second = await service.consolidateBank('memory', 'second')
  assert.equal(second.applied, false)
  assert.match(second.note, /already running/)
  release()
  assert.equal((await first).applied, true)
})

test('takeChunk takes whole entries up to the chunk size, always at least one', () => {
  assert.deepEqual(takeChunk(['aa', 'bb', 'cc'], 4), ['aa', 'bb'])
  assert.deepEqual(takeChunk(['aaaaa', 'b'], 4), ['aaaaa']) // an oversized first entry still returns
  assert.deepEqual(takeChunk([], 10), [])
  assert.equal(sumChars(['aa', 'bbb']), 5)
})

test('chunked consolidation merges in rounds when the budget is tightened', async () => {
  const base = makeRepo({ limits: { ...DEFAULT_LIMITS, memory: 400 } })
  for (const letter of ['a', 'b', 'c', 'd', 'e']) {
    await base.repo.add({ target: 'memory', content: letter.repeat(60) })
  }
  // Same tables, tighter budget — the realistic way a bank ends up over budget.
  const repo = new MemoryRepository({
    ...base.tables,
    global: base.globalSlot,
    limits: { ...DEFAULT_LIMITS, memory: 150 },
    now: () => '2026-10-12T00:00:00.000Z',
  })
  let calls = 0
  const { service } = makeLearning({
    repo,
    config: { consolidationChunkChars: 130 },
    oneShot: async () => {
      calls += 1
      return JSON.stringify({ entries: ['merged'] })
    },
  })
  const outcome = await service.consolidateBank('memory', 'chunked')
  assert.equal(outcome.applied, true)
  assert.equal(outcome.before, 5)
  assert.equal(outcome.after, 2)
  assert.equal(calls, 2)
  assert.equal(repo.consolidations().at(-1).status, 'completed')
})

test('a chunked run that cannot make the bank fit fails and leaves it intact', async () => {
  const echoPlan = async () => JSON.stringify({ entries: ['x'.repeat(60), 'y'.repeat(60)] })

  // Whole-bank chunk whose plan is still over budget → the budget is the error.
  const whole = makeRepo({ limits: { ...DEFAULT_LIMITS, memory: 400 } })
  await whole.repo.add({ target: 'memory', content: 'a'.repeat(60) })
  await whole.repo.add({ target: 'memory', content: 'b'.repeat(60) })
  const wholeRepo = new MemoryRepository({
    ...whole.tables, global: whole.globalSlot, limits: { ...DEFAULT_LIMITS, memory: 100 },
    now: () => '2026-10-12T00:00:00.000Z',
  })
  const wholeRun = makeLearning({ repo: wholeRepo, config: { consolidationChunkChars: 130 }, oneShot: echoPlan })
  const overBudget = await wholeRun.service.consolidateBank('memory', 'no fit')
  assert.equal(overBudget.applied, false)
  assert.match(overBudget.note, /over the 100 budget/)
  assert.equal(wholeRepo.all().length, 2)
  assert.equal(wholeRepo.consolidations().at(-1).status, 'failed')

  // Partial chunk that does not shrink the bank → no-progress error.
  const partial = makeRepo({ limits: { ...DEFAULT_LIMITS, memory: 400 } })
  for (const letter of ['a', 'b', 'c']) await partial.repo.add({ target: 'memory', content: letter.repeat(60) })
  const partialRepo = new MemoryRepository({
    ...partial.tables, global: partial.globalSlot, limits: { ...DEFAULT_LIMITS, memory: 100 },
    now: () => '2026-10-12T00:00:00.000Z',
  })
  const partialRun = makeLearning({ repo: partialRepo, config: { consolidationChunkChars: 130 }, oneShot: echoPlan })
  const noProgress = await partialRun.service.consolidateBank('memory', 'no progress')
  assert.equal(noProgress.applied, false)
  assert.match(noProgress.note, /did not reduce/)
  assert.equal(partialRepo.all().length, 3)
})
