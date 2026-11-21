/**
 * 侧栏的转交只有一个分派：照着宿主给的那张表走。
 *
 * 这一组直接驱动真正在侧栏里跑的那份 relay（lib/client.js 的 `carry`），而不是
 * 另一份测试专用的实现：表里每一行都送一次，断言它落到自己的入口、带上自己声明
 * 的字段、按自己声明的回执翻译。`draftRead` 曾经就是这样丢的 —— 桥有、入口有、
 * 转交里没有位置。现在它是表里的一行，这一组会把它跑一遍。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTIONS } from '../lib/action-table.js'

// The sidebar module registers itself on the DSH loader at import time; give it a
// stub so Node can load the very same file the browser loads.
globalThis.__ModuleLoader__ = { load: (registration) => { globalThis.__reviewRegistration = registration } }
await import('../lib/client.js')
const client = globalThis.__reviewRegistration.factory(() => ({ createElement() {} }))
const { carry } = client

const jsonResponse = (status, value) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

const SURFACE = '/tmp/project/review/surface.json'

/** The payload each action's page-side call would send. */
const PAYLOAD = {
  asset: { rel: 'shots/page-01.png', v: 'v2' },
  read: { rel: 'state.json', optional: true },
  write: { review_id: 'r1', overall_feedback: 'ok' },
  draft: { annotations: [{ id: 'a1' }] },
  draftRead: {},
  command: { op: 'state' },
  wake: { unit: 'page-01', text: '第 1 页已定' },
  upload: { rel: 'uploads/a.bin', name: 'a.bin', bytes: new Uint8Array([1, 2]).buffer },
}

/** A canned Host answer for one action. */
function answerFor(action) {
  if (action.relay.kind === 'bytes') {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
  }
  if (action.name === 'draftRead') return jsonResponse(200, { draft: { saved: true } })
  if (action.name === 'upload') return jsonResponse(200, { ok: true, path: '/tmp/a.bin', bytes: 2, sha256: 'x' })
  if (action.name === 'wake') return jsonResponse(200, { ok: true, state: 'in-turn', verified: { equalsWakeText: true } })
  if (action.name === 'command') return jsonResponse(200, { ok: false, code: 'conflict', error: 'Changed' })
  return jsonResponse(200, { ok: true, path: '/tmp/written.json' })
}

/** Run one action through the real relay and capture what it sent. */
async function relay(action) {
  const calls = []
  const result = await carry(action, {
    surface: SURFACE,
    sessionId: 'session-1',
    payload: PAYLOAD[action.name] ?? {},
    endpoint: (name) => `http://dsh.local/api/${name}`,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      return answerFor(action)
    },
  })
  return { calls, result }
}

test('every action in the table is carried to its own entry, with the method the row declares', async () => {
  for (const action of ACTIONS) {
    const { calls } = await relay(action)
    assert.equal(calls.length, 1, `${action.name} 应该只发一次请求`)
    const [call] = calls
    assert.ok(
      call.url.startsWith(`http://dsh.local/api/${action.route.replace(/^\/api\//, '')}`),
      `${action.name} 没落到 ${action.route}：${call.url}`,
    )
    const method = call.init.method ?? 'GET'
    assert.equal(method, action.relay.method, `${action.name} 的 HTTP 方法不对`)
  }
})

test('every action sends exactly the fields its row declares', async () => {
  for (const action of ACTIONS) {
    const { calls } = await relay(action)
    const [call] = calls
    const url = new URL(call.url)
    for (const key of action.relay.query ?? []) {
      if (key === 'v' && action.name !== 'asset') continue
      assert.equal(url.searchParams.get(key) !== null, true, `${action.name} 的请求没带 ${key}`)
    }
    if (Array.isArray(action.relay.body)) {
      const body = JSON.parse(call.init.body)
      assert.deepEqual(Object.keys(body).sort(), [...action.relay.body].sort(), `${action.name} 的请求体字段不对`)
      if (action.relay.body.includes('surface')) assert.equal(body.surface, SURFACE)
      if (action.relay.body.includes('sessionId')) assert.equal(body.sessionId, 'session-1')
      if (action.relay.body.includes('payload')) {
        assert.deepEqual(body.payload, PAYLOAD[action.name], `${action.name} 的 payload 没有原样带上`)
      }
    }
  }
})

test('每行的回执按自己声明的形状翻回来', async () => {
  const answers = new Map()
  for (const action of ACTIONS) {
    const { result } = await relay(action)
    answers.set(action.name, result.value)
    if (action.relay.kind === 'bytes') {
      assert.ok(result.value.bytes instanceof ArrayBuffer, `${action.name} 应该拿到原始字节`)
      assert.equal(result.value.type, 'image/png')
    }
  }
  assert.deepEqual(answers.get('draftRead'), { draft: { saved: true } }, '读草稿要能把内容交回页面')
  assert.equal(answers.get('upload').ok, true)
  assert.equal(answers.get('command').ok, false, '后端拒绝是结果，不是桥丢了消息')
  assert.equal(answers.get('wake').state, 'in-turn')
})

test('读草稿这个动作真的被接上了：GET 同一个入口，读取回执原样交回', async () => {
  const draftRead = ACTIONS.find((action) => action.name === 'draftRead')
  assert.ok(draftRead, '表里必须有 draftRead')
  const { calls, result } = await relay(draftRead)
  assert.equal(calls[0].init.method ?? 'GET', 'GET')
  assert.match(calls[0].url, /\/api\/review\.draft\?surface=/)
  assert.deepEqual(result.value, { draft: { saved: true } })
})

test('写草稿不需要 session：存字不该看起来像「让模型开始」', async () => {
  const draft = ACTIONS.find((action) => action.name === 'draft')
  const { calls } = await relay(draft)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(Object.hasOwn(body, 'sessionId'), false)
})

test('wake 的重复提交与无法核验都说清楚，而不是报失败', async () => {
  const wake = ACTIONS.find((action) => action.name === 'wake')
  const duplicate = await carry(wake, {
    surface: SURFACE,
    sessionId: 'session-1',
    payload: PAYLOAD.wake,
    endpoint: (name) => `http://dsh.local/api/${name}`,
    fetch: async () => jsonResponse(409, { state: 'duplicate', error: 'already delivered' }),
  })
  assert.equal(duplicate.value.ok, true)
  assert.equal(duplicate.value.duplicate, true)
  assert.match(duplicate.note, /之前已送达/)

  const unverified = await carry(wake, {
    surface: SURFACE,
    sessionId: 'session-1',
    payload: PAYLOAD.wake,
    endpoint: (name) => `http://dsh.local/api/${name}`,
    fetch: async () => jsonResponse(200, { ok: true, state: 'accepted-unverified', warning: '无法核验' }),
  })
  assert.equal(unverified.value.unverified, true)
  assert.match(unverified.note, /无法核验/)
})

test('upload 拿不到字节时明确拒绝，而不是发一个空请求体', async () => {
  const upload = ACTIONS.find((action) => action.name === 'upload')
  await assert.rejects(
    () => carry(upload, {
      surface: SURFACE,
      sessionId: 'session-1',
      payload: { rel: 'x.bin' },
      endpoint: (name) => `http://dsh.local/api/${name}`,
      fetch: async () => jsonResponse(200, {}),
    }),
    /ArrayBuffer/,
  )
})
