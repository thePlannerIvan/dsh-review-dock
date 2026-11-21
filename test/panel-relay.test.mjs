/**
 * 转交：页面的一句话怎么落到宿主入口，以及取不到动作表时人看到什么。
 *
 * 0.4.0 之前，旧副本先应答时页面拿到的是「未知的桥方法：draftRead」—— 一句让人
 * 去查桥的话，而真正的原因是宿主那边没有动作表。失败信息必须点名原因。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createFakeHost, loadClient } from './support/panel-harness.mjs'

const client = await loadClient()
const { createPanel } = client

const SURFACE = '/review/a/surface.json'

const TABLE = {
  actions: [
    {
      name: 'draftRead',
      required: false,
      capability: 'draft',
      route: '/api/review.draft',
      methods: ['GET'],
      requestBody: 'buffered',
      relay: { kind: 'json', method: 'GET', query: ['surface'], reply: 'value' },
    },
    {
      name: 'draft',
      required: false,
      capability: 'draft',
      route: '/api/review.draft',
      methods: ['POST'],
      requestBody: 'buffered',
      relay: { kind: 'json', method: 'POST', body: ['surface', 'payload'], reply: 'value' },
    },
  ],
}

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

function panelWith(respond) {
  const calls = []
  const panel = createPanel({
    host: createFakeHost({ onScreen: 'conversation-A' }).host,
    endpoint: (name) => `http://dsh.local/api/${name}`,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return respond(String(url), init ?? {})
    },
  })
  return { panel, calls }
}

test('动作表取不到时，失败信息点名原因，而不是「未知的桥方法」', async () => {
  const cases = [
    ['旧副本没有这条入口（404）', () => jsonResponse(404, {})],
    ['连接被拒绝', () => { throw new Error('Failed to fetch') }],
    ['回执不是动作表', () => jsonResponse(200, { hello: 'world' })],
  ]
  for (const [name, respond] of cases) {
    const { panel } = panelWith(respond)
    await assert.rejects(
      () => panel.relay({ sessionId: 'conversation-A', surface: SURFACE, method: 'draftRead', payload: {} }),
      (error) => {
        assert.match(error.message, /宿主没有提供动作表——可能是一份旧副本在应答/, `${name} 必须说清是动作表的问题`)
        assert.doesNotMatch(error.message, /未知的桥方法/, `${name} 不能把宿主的问题说成桥的问题`)
        return true
      },
    )
  }
})

test('动作表在、但表里没有这个方法时，才说「未知的桥方法」', async () => {
  const { panel } = panelWith(() => jsonResponse(200, TABLE))
  await assert.rejects(
    () => panel.relay({ sessionId: 'conversation-A', surface: SURFACE, method: 'nope', payload: {} }),
    /未知的桥方法：nope/,
  )
})

test('转交按表走：落到它声明的入口，带上这个面，回执原样交回', async () => {
  const { panel, calls } = panelWith((url) => {
    if (url.endsWith('/api/review.actions')) return jsonResponse(200, TABLE)
    return jsonResponse(200, { draft: { text: '还没提交的字' } })
  })

  const result = await panel.relay({
    sessionId: 'conversation-A',
    surface: SURFACE,
    method: 'draftRead',
    payload: {},
  })

  assert.deepEqual(result.value, { draft: { text: '还没提交的字' } })
  const page = calls.find((call) => call.url.includes('/api/review.draft'))
  assert.ok(page, '必须真的打到草稿入口')
  assert.match(page.url, /surface=%2Freview%2Fa%2Fsurface\.json/)
})

test('动作表整页只取一次，不是每个标签各取一次', async () => {
  const { panel, calls } = panelWith((url) => {
    if (url.endsWith('/api/review.actions')) return jsonResponse(200, TABLE)
    return jsonResponse(200, { ok: true })
  })
  await panel.relay({ sessionId: 'conversation-A', surface: SURFACE, method: 'draft', payload: { text: 'a' } })
  await panel.relay({ sessionId: 'conversation-A', surface: SURFACE, method: 'draft', payload: { text: 'b' } })
  const tables = calls.filter((call) => call.url.endsWith('/api/review.actions'))
  assert.equal(tables.length, 1, '动作表只该取一次')
})

test('动作表取失败后允许重试：下一句话仍可能成功', async () => {
  let available = false
  const { panel } = panelWith((url) => {
    if (url.endsWith('/api/review.actions')) {
      return available ? jsonResponse(200, TABLE) : jsonResponse(503, {})
    }
    return jsonResponse(200, { ok: true })
  })
  await assert.rejects(() => panel.relay({ sessionId: 'conversation-A', surface: SURFACE, method: 'draft', payload: {} }))
  available = true
  const result = await panel.relay({ sessionId: 'conversation-A', surface: SURFACE, method: 'draft', payload: { text: 'x' } })
  assert.deepEqual(result.value, { ok: true })
})
