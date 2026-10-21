/**
 * The rules of the per-conversation surface list, driven directly.
 *
 * `lib/surfaces.js` exists so these can be plain unit tests: the state machine
 * is where "a second review took the first one away" used to live, and it is the
 * one part of this change with no I/O to work around.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSurfaceRegistry } from '../lib/surfaces.js'
import { handleReviewCurrent } from '../lib/index.js'

test('a second surface appends instead of replacing the first', () => {
  const registry = createSurfaceRegistry()
  registry.open({ sessionId: 's', surface: '/p/a/surface.json', title: 'A' })
  registry.open({ sessionId: 's', surface: '/p/b/surface.json', title: 'B' })
  assert.deepEqual(registry.list('s').map((entry) => entry.surface), ['/p/a/surface.json', '/p/b/surface.json'])
  assert.equal(registry.newest('s').surface, '/p/b/surface.json')
})

test('re-opening the same surface refreshes that one and leaves the rest alone', () => {
  const registry = createSurfaceRegistry()
  const firstRevision = registry.open({ sessionId: 's', surface: '/p/a/surface.json' }).revision
  registry.open({ sessionId: 's', surface: '/p/b/surface.json' })
  const again = registry.open({ sessionId: 's', surface: '/p/a/surface.json' })
  assert.equal(registry.list('s').length, 2, '同一份面再开只能是刷新，不能变成两个')
  assert.equal(again.revision, firstRevision + 1, '刷新必须让 revision 走一格，否则帧不会重新加载')
  const b = registry.list('s').find((entry) => entry.surface === '/p/b/surface.json')
  assert.equal(b.revision, 1, '别的面不能被牵连')
})

test('two conversations never see each other list', () => {
  const registry = createSurfaceRegistry()
  registry.open({ sessionId: 'video', surface: '/p/video/surface.json' })
  registry.open({ sessionId: 'ppt', surface: '/p/ppt/surface.json' })
  assert.deepEqual(registry.list('video').map((entry) => entry.surface), ['/p/video/surface.json'])
  assert.deepEqual(registry.list('ppt').map((entry) => entry.surface), ['/p/ppt/surface.json'])
  assert.deepEqual(registry.list('nobody'), [])
})

test('an open without a conversation waits to be claimed, then belongs to one', () => {
  let clock = 1000
  const registry = createSurfaceRegistry({ now: () => clock, pendingTtlMs: 10_000 })
  const pending = registry.open({ sessionId: '', surface: '/p/a/surface.json' })
  assert.equal(pending.pending, true)
  assert.deepEqual(registry.list(''), [], '没有身份的面不能落进任何会话')
  registry.claimPending('video')
  assert.deepEqual(registry.list('video').map((entry) => entry.surface), ['/p/a/surface.json'])
  // Second claimer of the same pending open gets nothing: it was claimed once.
  registry.claimPending('ppt')
  assert.deepEqual(registry.list('ppt'), [])
  clock += 20_000
  assert.equal(registry.pendingCount(), 0)
})

test('an unclaimed open expires instead of leaking into a later conversation', () => {
  let clock = 1000
  const registry = createSurfaceRegistry({ now: () => clock, pendingTtlMs: 10_000 })
  registry.open({ sessionId: '', surface: '/p/a/surface.json' })
  clock += 60_000
  registry.claimPending('later')
  assert.deepEqual(registry.list('later'), [], '过期的那一次不许被后来的对话捡走')
  assert.equal(registry.pendingCount(), 0)
})

test('the current route lists every surface and keeps the old single fields', async () => {
  const registry = createSurfaceRegistry()
  registry.open({ sessionId: 's', surface: '/p/a/surface.json', title: 'A' })
  registry.open({ sessionId: 's', surface: '/p/b/surface.json', title: 'B' })
  const body = await (await handleReviewCurrent(registry, 's')).json()
  assert.deepEqual(body.surfaces.map((entry) => entry.surface), ['/p/a/surface.json', '/p/b/surface.json'])
  assert.deepEqual(body.surfaces.map((entry) => entry.title), ['A', 'B'])
  // 0.2.x panels read these; they must keep meaning "the newest one".
  assert.equal(body.surface, '/p/b/surface.json')
  assert.equal(body.revision, 1)
  assert.equal(body.watching, 0)
})

test('each surface gets its own change counter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dock-surfaces-'))
  const watched = join(dir, 'render.json')
  const other = join(dir, 'other.json')
  await writeFile(watched, '{"v":1}')
  await writeFile(other, '{"v":1}')
  const registry = createSurfaceRegistry()
  registry.open({
    sessionId: 's',
    surface: join(dir, 'a.json'),
    watch: [{ rel: 'render.json', absolute: watched }],
  })
  registry.open({
    sessionId: 's',
    surface: join(dir, 'b.json'),
    watch: [{ rel: 'other.json', absolute: other }],
  })
  const before = await (await handleReviewCurrent(registry, 's')).json()
  assert.deepEqual(before.surfaces.map((entry) => entry.changedSeq), [0, 0])

  await writeFile(watched, '{"v":2}')
  const after = await (await handleReviewCurrent(registry, 's')).json()
  assert.deepEqual(after.surfaces.map((entry) => entry.changedSeq), [1, 0], '只该戳动的那一份面走一格')

  const again = await (await handleReviewCurrent(registry, 's')).json()
  assert.deepEqual(again.surfaces.map((entry) => entry.changedSeq), [1, 0], '没有新变化就不许再走')
})
