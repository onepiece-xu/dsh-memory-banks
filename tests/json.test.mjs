// JSON extraction tests: model answers are untrusted text, so every wrapper shape
// is exercised, and every failure is a loud, stable message.
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractJson, readEntryList } from '../dist/json.js'

test('extractJson handles fenced, prose-wrapped, bare, and array answers', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('```\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(extractJson('Here you go:\n{"operations":[]}\nHope that helps.'), { operations: [] })
  assert.deepEqual(extractJson('{"a":3}'), { a: 3 })
  assert.deepEqual(extractJson('["x","y"]'), ['x', 'y'])
  assert.deepEqual(extractJson('prefix [1,2] suffix'), [1, 2])
  assert.deepEqual(extractJson('```json\n{"nested":{"deep":[1,2]}}\n```'), { nested: { deep: [1, 2] } })
})

test('extractJson fails loud instead of guessing', () => {
  assert.throws(() => extractJson(''), /empty answer/)
  assert.throws(() => extractJson('no json at all'), /no parseable JSON/)
  assert.throws(() => extractJson('{"broken": '), /no parseable JSON/)
})

test('readEntryList accepts an array or an entries object, dedupes and caps', () => {
  assert.deepEqual(readEntryList(['a', 'b', 'a', '  ', 'c'], 10), ['a', 'b', 'c'])
  assert.deepEqual(readEntryList({ entries: ['x', 'y'] }, 10), ['x', 'y'])
  assert.deepEqual(readEntryList(['1', '2', '3'], 2), ['1', '2'])
  assert.deepEqual(readEntryList(['  padded  '], 5), ['padded'])
})

test('readEntryList rejects unusable answers', () => {
  assert.throws(() => readEntryList({ nope: [] }, 5), /expected a JSON array of entries/)
  assert.throws(() => readEntryList(['', '   '], 5), /no usable entries/)
  assert.throws(() => readEntryList([1, 2, 3], 5), /no usable entries/)
})
