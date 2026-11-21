/**
 * 「页面能请宿主做什么」只有一张表。
 *
 * 这一组检查表驱动的三样东西：宿主入口的注册、桥的完整性清单、以及侧栏那份
 * 转交。表里每一行都必须在三处出现 —— 加一个动作只改表，漏一处就红。
 *
 * 不读源码文字：入口是真的从 apply() 里注册出来的路由，桥的完整性是真的走
 * 一遍页面请求，转交是真的把一行交给 client 的 relay 跑一次。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ACTIONS, RELAY_KINDS, optionalBridgeApi, requiredBridgeApi } from '../lib/action-table.js'
import { apply } from '../lib/index.js'
import { fakeCordis } from './support/fake-cordis.mjs'

/** A minimal `planners-review-core` whose bridge mentions exactly `names`. */
async function fakeCore(t, names) {
  const root = await mkdtemp(join(tmpdir(), 'review-core-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'review-bridge.js'), names.map((name) => `// ${name}`).join('\n'))
  return root
}

const ALL_BRIDGE_NAMES = [...requiredBridgeApi(), ...optionalBridgeApi()]

/** GET one registered route. */
async function get(f, path, params = {}) {
  const url = new URL('http://dsh.local' + path)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const route = f.routes.find((entry) => entry.path === path)
  assert.ok(route, `没有注册 ${path}`)
  return route.fetch(new Request(url))
}

/**
 * Mount the plugin on a fake Cordis context and return the routes it registered.
 * `coreDir` may point at a synthetic `planners-review-core` or at nothing at all.
 */
async function mount(t, { coreDir = '', surface: extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-table-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  const surface = join(reviewDir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/table',
    title: 'Table probe',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities: [],
    ...extra,
  }))
  const plugin = fakeCordis({ tools: true })
  apply(plugin.ctx, coreDir === '' ? {} : { reviewCoreDir: coreDir })
  return { root, reviewDir, surface, routes: plugin.routes, tools: plugin.tools }
}

test('every action in the table has a host entry, registered with its own method and body mode', async (t) => {
  const f = await mount(t)
  for (const action of ACTIONS) {
    const route = f.routes.find((entry) => entry.path === action.route)
    assert.ok(route, `动作 ${action.name} 没有入口：${action.route}`)
    for (const method of action.methods) {
      assert.ok(route.methods.includes(method), `${action.name} 的 ${method} 没有注册：${route.methods}`)
    }
    assert.equal(route.requestBody, action.requestBody, `${action.name} 的请求体模式不一致`)
  }
})

test('every action in the table is carried by the sidebar relay, with a relay kind it knows', async (t) => {
  const f = await mount(t)
  const response = await routeOf(f, '/api/review.actions').fetch(new Request('http://dsh.local/api/review.actions'))
  assert.equal(response.status, 200)
  const { actions } = await response.json()
  assert.deepEqual(actions.map((action) => action.name), ACTIONS.map((action) => action.name))
  for (const action of actions) {
    assert.ok(action.relay, `动作 ${action.name} 没有说明转交方式`)
    assert.ok(RELAY_KINDS.includes(action.relay.kind), `${action.name} 的转交方式 ${action.relay.kind} 侧栏不认识`)
  }
})

const routeOf = (f, path) => {
  const route = f.routes.find((entry) => entry.path === path)
  assert.ok(route, `没有注册 ${path}`)
  return route
}

test('a bridge missing a required action refuses the page and names what is missing', async (t) => {
  const forEachRequired = async (name) => {
    const core = await fakeCore(t, ALL_BRIDGE_NAMES.filter((entry) => entry !== name))
    const f = await mount(t, { coreDir: core })
    const response = await get(f, '/api/review.page', { surface: f.surface })
    const body = await response.json()
    assert.equal(response.status, 500, `少了必须动作 ${name} 仍然放行了：${JSON.stringify(body)}`)
    assert.match(JSON.stringify(body), new RegExp(`\\b${name}\\b`), `回执没有说清缺 ${name}`)
  }
  // One representative is enough per run for the page route; the table check
  // below proves the list is derived, not hand-written.
  await forEachRequired('write')
  await forEachRequired('connect')
})

test('the bridge list is exactly the table: dropping any action from a complete bridge changes the verdict', async (t) => {
  const complete = await fakeCore(t, ALL_BRIDGE_NAMES)
  const ok = await mount(t, { coreDir: complete })
  assert.equal((await get(ok, '/api/review.page', { surface: ok.surface })).status, 200)
  for (const name of ALL_BRIDGE_NAMES) {
    const core = await fakeCore(t, ALL_BRIDGE_NAMES.filter((entry) => entry !== name))
    const f = await mount(t, { coreDir: core })
    const response = await get(f, '/api/review.page', { surface: f.surface })
    const action = ACTIONS.find((entry) => entry.name === name)
    if (action !== undefined && !action.required) {
      assert.equal(response.status, 200, `可选动作 ${name} 缺席不该拒绝页面`)
      continue
    }
    assert.equal(response.status, 500, `必须动作 ${name} 缺席仍然放行了`)
  }
})

test('一份能写草稿但没有 draftRead 的桥：存得下，读回才降级', async (t) => {
  const core = await fakeCore(t, ALL_BRIDGE_NAMES.filter((name) => name !== 'draftRead'))
  const f = await mount(t, {
    coreDir: core,
    surface: { draft: 'draft.json', capabilities: ['draft', 'asset-upload'] },
  })
  assert.equal((await get(f, '/api/review.page', { surface: f.surface })).status, 200)
  const meta = await (await get(f, '/api/review.surface', { surface: f.surface })).json()
  // 「能不能存」与「能不能读回」是两件事：一份 0.3.x 的桥能写草稿，人写的东西就
  // 必须存得下来 —— 不能因为读回那个动作缺席，把存也一起关掉。
  assert.deepEqual(meta.surface.capabilities, ['draft', 'asset-upload'])

  const draftRoute = routeOf(f, '/api/review.draft')
  const written = await draftRoute.fetch(new Request('http://dsh.local/api/review.draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surface: f.surface, payload: { text: '还在写' } }),
  }))
  assert.equal(written.status, 200, '能写草稿的桥必须让存')
  assert.deepEqual(JSON.parse(await readFile(join(f.reviewDir, 'draft.json'), 'utf8')), { text: '还在写' })

  // 读回不可用这件事仍然要说出口：可选动作降级的警告照旧点名 draftRead。
  const receipt = await f.tools[0].execute({ surface: f.surface }, { agent: { session: { id: 's1' } } })
  assert.match(receipt.warnings.join(' '), /draftRead/)
})
