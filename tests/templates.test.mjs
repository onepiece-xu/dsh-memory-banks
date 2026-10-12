// Template / detection / skill-body tests: everything the model reads or that
// decides what gets saved, with no DSH packages involved.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertSkillDescription,
  assertSkillName,
  classifyCorrection,
  correctionEntryText,
  MAX_SKILL_DESCRIPTION,
  patchSkillSection,
  renderSkillBody,
  reviewSystemPrompt,
  reviewUserPrompt,
  skillSlug,
  snapshotText,
  standingBlock,
  STANDING_HEADER,
  validateReviewOperations,
} from '../dist/templates.js'
import { projectKeyOf } from '../dist/core.js'

test('corrections: strong patterns save, weak patterns need a directive, praise is ignored', () => {
  assert.equal(classifyCorrection('no, use pnpm not npm'), 'strong')
  assert.equal(classifyCorrection("that's wrong"), 'strong')
  assert.equal(classifyCorrection('I said use pnpm'), 'strong')
  assert.equal(classifyCorrection('wrong, change it to pnpm'), 'weak')
  assert.equal(classifyCorrection('wrong'), 'none') // weak pattern without a directive
  assert.equal(classifyCorrection('no worries, that looks great'), 'none')
  assert.equal(classifyCorrection('please continue with the next step'), 'none')
  assert.equal(classifyCorrection('   '), 'none')
})

test('correction entries stay terse', () => {
  assert.equal(correctionEntryText('  no,   use pnpm \n not npm '), 'no, use pnpm not npm')
  const long = correctionEntryText('x'.repeat(300))
  assert.equal(long.length, 200)
  assert.ok(long.endsWith('…'))
})

test('review prompts carry the session, the project, and a bounded input tail', () => {
  assert.match(reviewSystemPrompt(), /Return only a JSON object with an operations array/)
  const prompt = reviewUserPrompt({
    sessionId: 'session-1',
    projectKey: 'alpha-11111111',
    userText: 'u'.repeat(500),
    assistantText: 'a'.repeat(500),
    failures: ['tool failed'],
  }, 100)
  assert.match(prompt, /Completed session session-1 in project alpha-11111111\./)
  assert.ok(prompt.length < 600)
  assert.ok(prompt.includes('a'.repeat(50)))
  assert.ok(!prompt.includes('u'.repeat(50)))
})

test('review operations are re-validated, never trusted', () => {
  const operations = validateReviewOperations({
    operations: [
      { kind: 'add', target: 'memory', content: 'uses pnpm', category: 'convention', reason: 'user said so' },
      { kind: 'add', target: 'nope', content: 'dropped' },
      { kind: 'delete', target: 'memory', content: 'dropped' },
      { kind: 'add', target: 'user', content: '   ' },
      { kind: 'replace', target: 'user', content: 'new', old_text: 'old' },
      { kind: 'replace', target: 'user', content: 'no needle' },
      { kind: 'add', target: 'failure', content: 'bad idea', category: 'made-up' },
    ],
  })
  assert.equal(operations.length, 3)
  assert.deepEqual(operations[0], { kind: 'add', target: 'memory', content: 'uses pnpm', category: 'convention', reason: 'user said so' })
  assert.deepEqual(operations[1], { kind: 'replace', target: 'user', content: 'new', oldText: 'old' })
  assert.equal(operations[2].category, undefined)
  assert.deepEqual(validateReviewOperations({ operations: 'nope' }), [])
  assert.equal(validateReviewOperations({ operations: new Array(20).fill({ kind: 'add', target: 'memory', content: 'x' }) }).length, 8)
})

test('skill bodies render from structured input or raw content', () => {
  const body = renderSkillBody({
    whenToUse: 'TypeScript errors in a monorepo.',
    steps: ['Read the error', 'Run tsc --noEmit'],
    pitfalls: ['Do not trust the editor'],
    verification: ['tsc --noEmit is clean'],
  })
  assert.match(body, /## When to Use\nTypeScript errors in a monorepo\./)
  assert.match(body, /## Procedure\n1\. Read the error\n2\. Run tsc --noEmit/)
  assert.match(body, /## Pitfalls\n- Do not trust the editor/)
  assert.match(body, /## Verification\n1\. tsc --noEmit is clean/)
  assert.equal(renderSkillBody({ content: 'just raw steps' }), 'just raw steps')
  assert.throws(() => renderSkillBody({}), /requires a body/)
  assert.throws(() => renderSkillBody({ content: 'x'.repeat(8001) }), /max 8000/)
})

test('a skill section can be patched without touching the rest', () => {
  const body = '## When to Use\nold trigger\n\n## Procedure\n1. step\n\n## Pitfalls\n- old'
  const patched = patchSkillSection(body, 'Pitfalls', '- new pitfall\n- second')
  assert.match(patched, /## When to Use\nold trigger/)
  assert.match(patched, /## Procedure\n1\. step/)
  assert.match(patched, /## Pitfalls\n- new pitfall\n- second/)
  assert.ok(!patched.includes('- old'))
  assert.throws(() => patchSkillSection(body, 'Nope', 'x'), /has no "## Nope" section/)
})

test('skill names and descriptions are validated at the boundary', () => {
  assert.equal(skillSlug('Debug TypeScript Errors!'), 'debug-typescript-errors')
  assert.equal(assertSkillName('  Debug TS  '), 'Debug TS')
  assert.throws(() => assertSkillName(''), /requires a name/)
  assert.throws(() => assertSkillName('a'), /too short/)
  assert.equal(assertSkillDescription('  tsc   failures  '), 'tsc failures')
  assert.throws(() => assertSkillDescription(''), /requires a description/)
  assert.throws(() => assertSkillDescription('x'.repeat(MAX_SKILL_DESCRIPTION + 1)), /max 160/)
})

test('standing block and snapshot carry their headers, and empty standing is empty', () => {
  assert.equal(standingBlock([]), '')
  assert.equal(standingBlock(['never run find /']), `${STANDING_HEADER}\n- never run find /`)
  const snapshot = snapshotText([{ bank: 'memory', rendered: '## MEMORY [0% — 0/2,200 chars]\n(empty)' }])
  assert.match(snapshot, /^\[DSH standing context\] \(memory snapshot\)/)
})

test('project keys are stable, path-sensitive, and absent without a cwd', () => {
  assert.equal(projectKeyOf('D:/Codes/skills/dsh-workspace'), projectKeyOf('D:\\Codes\\skills\\dsh-workspace\\'))
  assert.notEqual(projectKeyOf('D:/a/app'), projectKeyOf('D:/b/app'))
  assert.match(projectKeyOf('D:/a/app'), /^app-[0-9a-f]{8}$/)
  assert.equal(projectKeyOf(undefined), undefined)
  assert.equal(projectKeyOf('  '), undefined)
})
