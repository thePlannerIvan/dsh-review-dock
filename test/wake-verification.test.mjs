/**
 * The wake seam must answer with evidence, not with the Host's word.
 *
 * Regression for the 0.2.2 runtime: `sessionController.inspect()` is gone (it
 * exists through 0.2.1), and the old verifier swallowed the resulting TypeError,
 * so every wake whose message had already left the in-memory inbox reported
 * `502 undelivered` — including the "same submission sent again" case that is
 * supposed to be `409 duplicate`. These tests drive the real `/api/review.wake`
 * route against the three shapes a runtime can have:
 *
 *   - `state` + `events`   (DSH 0.2.2+)
 *   - `inspect`            (DSH <= 0.2.1)
 *   - neither              (unknown future drift → honest `accepted-unverified`)
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

async function fixture(t, sessionController, agents = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-wake-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'index.html'), '{{REVIEW_BRIDGE}}\n')
  const surface = join(reviewDir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/wake',
    title: 'Wake probe',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    wake: { mode: 'queue', text: '第 {unit} 页已定' },
    capabilities: [],
  }))
  const routes = []
  const services = {
    sessionController,
    agents: { get: (id) => agents[id] },
    tools: { register: () => () => {} },
  }
  const get = (name) => services[name]
  const bridgeCtx = {
    connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
    effect: (fn) => (fn() ?? (() => {})),
    logger: {},
    get,
  }
  const ctx = {
    inject(_names, fn) { fn(bridgeCtx) },
    effect: (fn) => (fn() ?? (() => {})),
    get,
    logger: {},
  }
  apply(ctx, {})
  return {
    root,
    surface,
    routes,
    feedback: join(reviewDir, 'feedback.json'),
    post(route, body) {
      return route.fetch(new Request('http://dsh.local' + route.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
    },
  }
}

const payload = {
  review_id: 'r1',
  overall_feedback: 'ok',
  items: [{ id: 'i1', text: 'x' }],
  provenance: { submitted_at: '2026-11-08T00:00:00Z' },
}

/**
 * The 0.2.2+ shape: `state()` reports the cursor and the pending queue, `events()`
 * returns a bounded history page whose records wrap the event.
 */
function modernController({ deliver }) {
  let cursor = 0
  const queue = []
  const events = []
  return {
    prompts: [],
    async prompt(request) {
      this.prompts.push(request)
      deliver({ request, queue, events, nextSeq: () => (cursor += 1) })
      return { accepted: true }
    },
    async state() {
      return {
        cursor,
        active: true,
        running: false,
        queue: queue.map((message) => ({
          id: message.id,
          placement: 'queued',
          rpcId: message.source.rpcId,
          content: message.content,
        })),
        pendingInput: [],
      }
    },
    async events() {
      return { cursor, records: events.map((event) => ({ type: 'event', event })), hasMore: false }
    },
  }
}

/** The <= 0.2.1 shape: one `inspect()` call returns the whole event list. */
function legacyController({ deliver }) {
  let cursor = 0
  const queue = []
  // A real session always has older events; the seq bound needs at least one.
  const events = [{ type: 'session/created', seq: 0, data: {} }]
  return {
    prompts: [],
    async prompt(request) {
      this.prompts.push(request)
      deliver({ request, queue, events, nextSeq: () => (cursor += 1) })
      return { accepted: true }
    },
    async inspect() {
      return { events, queue }
    },
  }
}

const wakeRouteOf = (f) => f.routes.find((route) => route.path === '/api/review.wake')
const writeRouteOf = (f) => f.routes.find((route) => route.path === '/api/review.write')

test('0.2.2 state(): a prompt still in the queue is reported as queued', async (t) => {
  const controller = modernController({
    deliver({ request, queue }) {
      queue.push({ id: 'm1', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
    },
  })
  const f = await fixture(t, controller)
  const response = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.state, 'queued')
  assert.equal(body.verified.equalsWakeText, true)
})

test('0.2.2 events(): a message a turn already took is reported as in-turn', async (t) => {
  const controller = modernController({
    deliver({ request, events, nextSeq }) {
      events.push({
        type: 'user/message',
        seq: nextSeq(),
        data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content },
      })
    },
  })
  const f = await fixture(t, controller)
  const response = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.state, 'in-turn')
  assert.equal(body.verified.seq, 1)
})

test('0.2.2 events(): a retry of the same submission is 409 duplicate, not 502', async (t) => {
  let deliveries = 0
  const controller = modernController({
    deliver({ request, events, nextSeq }) {
      // Deliver the first call only; the Host would deduplicate the retry.
      if (deliveries > 0) return
      deliveries += 1
      events.push({
        type: 'user/message',
        seq: nextSeq(),
        data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content },
      })
    },
  })
  const f = await fixture(t, controller)
  const write = f.post(writeRouteOf(f), { surface: f.surface, sessionId: 's1', payload })
  assert.equal((await write).status, 200)

  const first = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  assert.equal(first.status, 200, await first.text())
  const second = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  const body = await second.json()
  assert.equal(second.status, 409, JSON.stringify(body))
  assert.equal(body.state, 'duplicate')
  assert.match(body.error, /已经送达过/)
})

test('0.2.2 state(): acceptance with no evidence is 502 undelivered', async (t) => {
  const controller = modernController({ deliver() { /* accepted, delivered nowhere */ } })
  const f = await fixture(t, controller)
  const response = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  const body = await response.json()
  assert.equal(response.status, 502)
  assert.equal(body.state, 'undelivered')
})

test('<= 0.2.1 inspect(): the legacy verifier still proves delivery', async (t) => {
  const controller = legacyController({
    deliver({ request, events, nextSeq }) {
      events.push({
        type: 'user/message',
        seq: nextSeq(),
        data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content },
      })
    },
  })
  const f = await fixture(t, controller)
  const response = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.state, 'in-turn')
})

test('no read API at all: accepted but unverified, never a false red', async (t) => {
  const controller = {
    prompts: [],
    async prompt(request) { this.prompts.push(request); return { accepted: true } },
  }
  const f = await fixture(t, controller)
  const response = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.state, 'accepted-unverified')
  assert.equal(body.verified.where, 'no verifier api')
  assert.match(body.warning, /无法核验/)
})

test('a removed controller.prompt is named, not thrown', async (t) => {
  const f = await fixture(t, {})
  const response = await f.post(wakeRouteOf(f), { surface: f.surface, unit: 'p1', sessionId: 's1' })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /prompt\(\)/)
})
