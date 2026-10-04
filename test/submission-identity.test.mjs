/**
 * Regression for 0.2.2: "same submission, sent again" must keep ONE identity.
 *
 * The identity is the hash of the feedback payload, and a page re-stamps
 * `provenance.submitted_at`, `provenance.wake` and every `items[].id` on each
 * `collect()`. Hashing the payload verbatim therefore gave a retry a NEW
 * identity, the dedup did not fire, and `prompt` was delivered a second time —
 * one click, two messages to the model.
 *
 * `lib/index.js` is a Cordis bundle (it registers itself through the Host's
 * module loader), so it cannot simply be imported here. The two functions under
 * test are pure and self-contained: pull their source text out and run them,
 * which keeps the test pinned to the shipped file rather than to a copy.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

/** Slice one top-level `function name(...) {...}` out of the bundle by brace counting. */
function grabFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `lib/index.js no longer defines ${name}()`)
  let depth = 0
  for (let at = source.indexOf('{', start); at < source.length; at += 1) {
    if (source[at] === '{') depth += 1
    else if (source[at] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, at + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

const module_ = { exports: {} }
new Function('module', 'exports', 'createHash', [
  grabFunction('submissionIdentity'),
  grabFunction('submissionOf'),
  'module.exports = { submissionIdentity, submissionOf }',
].join('\n'))(module_, module_.exports, createHash)
const { submissionOf, submissionIdentity } = module_.exports

const base = () => ({
  review_id: 'review-abc',
  overall_feedback: '',
  pages: {
    page_07: {
      decision: 'revise',
      feedback: '这块写的太复杂了，简化一下',
      annotations: [],
      assets: [],
      version: 'v1',
      png_sha256: 'p1',
    },
  },
  items: [
    { id: 'uid-AAA', pages: ['page_07'], feedback: '这块写的太复杂了，简化一下', annotations: [], assets: [] },
  ],
  provenance: {
    source: 'review_page',
    transport: 'dsh',
    surface: 'planners-ppt-hell/visual',
    submitted_at: '2026-10-04T10:00:00.000Z',
  },
})

test('a re-send of the same submission keeps the same identity', () => {
  const first = base()
  // What the page produces when the SAME submission is collected again: a fresh
  // timestamp, the wake receipt it writes back after the wake, and a fresh uid().
  const resent = base()
  resent.provenance.submitted_at = '2026-10-04T10:00:07.123Z'
  resent.provenance.wake = { requested: true, verified: null, at: '2026-10-04T10:00:07.500Z' }
  resent.items[0].id = 'uid-BBB'

  assert.equal(
    submissionOf('session-1', '/p/surface.json', resent),
    submissionOf('session-1', '/p/surface.json', first),
    'a retry must be recognised as the same submission, or the model is woken twice',
  )
})

test('the page write-back after a wake cannot cross-wire two concurrent submits', () => {
  // `push()` is write → wake → write(the wake receipt). Two clicks that overlap
  // interleave those three calls, so the second wake can read the identity that
  // the FIRST push's write-back just installed, while the first wake used the
  // one before it. If those two differ, one click becomes two prompts. They can
  // only differ if the write-back changes identity — and it must not: it adds
  // nothing but the receipt.
  const beforeWake = base()
  const afterWake = base()
  afterWake.provenance.wake = {
    requested: true,
    verified: { state: 'queued', where: 'agents.get(sessionId).inbox' },
    at: '2026-10-04T10:00:03.000Z',
  }

  assert.equal(
    submissionOf('session-1', '/p/surface.json', afterWake),
    submissionOf('session-1', '/p/surface.json', beforeWake),
    'the write-back must not advance the identity, or an overlapping second click wakes the model again',
  )
})

test('a changed submission still gets a new identity', () => {
  const first = base()
  const edited = base()
  edited.items[0].feedback = '这块换个说法'
  edited.pages.page_07.feedback = '这块换个说法'

  assert.notEqual(
    submissionOf('session-1', '/p/surface.json', edited),
    submissionOf('session-1', '/p/surface.json', first),
    'real edits must never be swallowed by the dedup',
  )
})

test('a different session never shares an identity', () => {
  const payload = base()
  assert.notEqual(
    submissionOf('session-2', '/p/surface.json', payload),
    submissionOf('session-1', '/p/surface.json', payload),
  )
})

test('identity never drops content, only the volatile stamps', () => {
  const payload = base()
  const stripped = submissionIdentity(payload)
  assert.equal(stripped.provenance.submitted_at, undefined)
  assert.equal(stripped.items[0].id, undefined)
  assert.equal(stripped.items[0].feedback, payload.items[0].feedback)
  assert.equal(stripped.pages.page_07.version, 'v1')
  // The payload the caller wrote must not be mutated on the way through.
  assert.equal(payload.provenance.submitted_at, '2026-10-04T10:00:00.000Z')
  assert.equal(payload.items[0].id, 'uid-AAA')
})
