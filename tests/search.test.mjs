// Session-search helper tests: the token-vs-substring decision and snippet
// cutting are the two places this plugin outsmarts a tokenizer, so they are
// pinned down explicitly.
import test from 'node:test'
import assert from 'node:assert/strict'

import { isShortQuery, shouldFallbackToSubstring, snippetAround } from '../dist/search.js'

test('isShortQuery flags CJK/short-token queries that token recall may miss', () => {
  assert.equal(isShortQuery('今'), true)
  assert.equal(isShortQuery('天气'), true)
  assert.equal(isShortQuery('记忆 系统'), true) // one short word is enough
  assert.equal(isShortQuery('tokenizer'), false)
  assert.equal(isShortQuery('brown fox'), false)
  assert.equal(isShortQuery('全文索引'), false) // three characters is the trigram boundary
  assert.equal(isShortQuery(''), false)
  assert.equal(isShortQuery('   '), false)
})

test('shouldFallbackToSubstring only retries when token recall found nothing', () => {
  assert.equal(shouldFallbackToSubstring('auto', '天气', 0), true)
  assert.equal(shouldFallbackToSubstring('auto', 'tokenizer', 0), false) // long query: tokens should have worked
  assert.equal(shouldFallbackToSubstring('auto', '天气', 3), false) // hits: no need
  assert.equal(shouldFallbackToSubstring('substring', 'tokenizer', 0), true)
  assert.equal(shouldFallbackToSubstring('tokens', '天气', 0), false)
})

test('snippetAround centers the match, marks truncation, and flattens whitespace', () => {
  const text = `line one\nline two with the needle inside it\nline three`
  const snippet = snippetAround(text, 'needle', 40)
  assert.ok(snippet.includes('needle'))
  assert.ok(!snippet.includes('\n'))
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('…'))

  const short = snippetAround('just short', 'short', 60)
  assert.equal(short, 'just short')

  // A whitespace-flexible match (query has different spacing) still centers.
  const flexible = snippetAround('alpha beta gamma delta epsilon zeta', 'beta   gamma', 24)
  assert.ok(flexible.includes('beta gamma'))

  // No match at all: keep the head, never pretend there was a match.
  const miss = snippetAround('completely different content', 'zzz', 12)
  assert.equal(miss, 'completely …')
})
