// One-shot model call robustness: the live host aborted concurrent auxiliary
// requests, so serialization and one transient retry are the behaviour worth
// pinning down.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createOneShot, isTransientFailure, resolveRoute } from '../dist/llm.js'

test('isTransientFailure retries aborts and empty answers, not refusals', () => {
  assert.equal(isTransientFailure('memory model call failed: ABORTED — Request aborted'), true)
  assert.equal(isTransientFailure('the memory model call returned no text'), true)
  assert.equal(isTransientFailure('memory model call failed: RATE_LIMIT'), true)
  assert.equal(isTransientFailure('memory model call timed out after 120000ms'), true)
  assert.equal(isTransientFailure('memory model call failed: MISSING_CREDENTIAL — no key'), false)
  assert.equal(isTransientFailure('invalid operation: add requires `text`'), false)
})

test('resolveRoute prefers explicit config, else the deployment default', () => {
  assert.deepEqual(
    resolveRoute({ provider: 'mify', model: 'deepseek-flash', fallback: { provider: 'f', model: 'x' } }),
    { provider: 'mify', model: 'deepseek-flash' },
  )
  assert.deepEqual(resolveRoute({ provider: '', model: '', fallback: { provider: 'f', model: 'x' } }), { provider: 'f', model: 'x' })
  assert.equal(resolveRoute({}), undefined)
})

function failingStream(counter, message = 'ABORTED — Request aborted') {
  return {
    stream: async function* () {
      counter.inFlight += 1
      counter.max = Math.max(counter.max, counter.inFlight)
      counter.attempts += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      counter.inFlight -= 1
      throw new Error(message)
    },
  }
}

const request = { system: 'system', user: 'user', maxTokens: 16, timeoutMs: 1000 }

test('a transient failure is retried once, then surfaced', async () => {
  const counter = { attempts: 0, inFlight: 0, max: 0 }
  const oneShot = createOneShot(failingStream(counter), () => ({ provider: 'p', model: 'm' }), { retries: 1, retryDelayMs: 1 })
  await assert.rejects(() => oneShot(request), /ABORTED/)
  assert.equal(counter.attempts, 2)
})

test('a refusal is not retried', async () => {
  const counter = { attempts: 0, inFlight: 0, max: 0 }
  const oneShot = createOneShot(
    failingStream(counter, 'memory model call failed: MISSING_CREDENTIAL — no key'),
    () => ({ provider: 'p', model: 'm' }),
    { retries: 2, retryDelayMs: 1 },
  )
  await assert.rejects(() => oneShot(request), /MISSING_CREDENTIAL/)
  assert.equal(counter.attempts, 1)
})

test('background calls are serialized: never two at once', async () => {
  const counter = { attempts: 0, inFlight: 0, max: 0 }
  const oneShot = createOneShot(failingStream(counter), () => ({ provider: 'p', model: 'm' }), { retries: 0, retryDelayMs: 1 })
  await Promise.allSettled([
    oneShot({ ...request, user: 'u1' }),
    oneShot({ ...request, user: 'u2' }),
    oneShot({ ...request, user: 'u3' }),
  ])
  assert.equal(counter.max, 1)
  assert.equal(counter.attempts, 3)
})

test('a missing route fails fast without touching the provider', async () => {
  let attempts = 0
  const llm = { stream: async function* () { attempts += 1; yield undefined } }
  const oneShot = createOneShot(llm, () => undefined, { retries: 3, retryDelayMs: 1 })
  await assert.rejects(() => oneShot(request), /no model route available/)
  assert.equal(attempts, 0)
})
