/**
 * 「页面能用哪些功能」只由两件事决定：宿主做得到什么，以及核心认不认可。
 *
 * 插件里不许再出现后端名或后端名单（ADR 0001）。这一组用一个只存在于测试里的
 * 后端名 `x-workbench/1` 证明：只要 `planners-review-core` 说行，宿主就说行；
 * 核心说不行，宿主就不亮。再加一条「算一次」：页面的初始化、`review_open`
 * 的回执、入口的准入读的是同一份结果，核心只会被问一次。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { optionalBridgeApi, requiredBridgeApi } from '../lib/action-table.js'
import { apply } from '../lib/index.js'

const ALL_BRIDGE_NAMES = [...requiredBridgeApi(), ...optionalBridgeApi()]

/**
 * A `planners-review-core` that accepts one backend nobody in this repo names,
 * and records every time it is asked. The bridge is complete.
 */
async function fakeCore(t, { accepts = 'x-workbench/1', includeRunner = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-caps-core-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'scripts', 'lib'), { recursive: true })
  const calls = join(root, 'command-asked.log')
  await writeFile(
    join(root, 'assets', 'review-bridge.js'),
    [...ALL_BRIDGE_NAMES.map((name) => `// ${name}`), "command: function (payload) { return payload }"].join('\n'),
  )
  if (includeRunner) {
    await writeFile(join(root, 'scripts', 'lib', 'review-command.mjs'), `
import { appendFileSync } from 'node:fs'
const LOG = ${JSON.stringify(calls)}
export function commandEnabled(data) {
  appendFileSync(LOG, 'asked\\n')
  return data?.command_backend === ${JSON.stringify(accepts)}
    && Array.isArray(data?.capabilities) && data.capabilities.includes('command')
}
export async function runBrowserCommand() { return { ok: true } }
`)
  }
  return { root, calls }
}

async function fixture(t, { core, capabilities, backend }) {
  const root = await mkdtemp(join(tmpdir(), 'review-caps-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  const surface = join(reviewDir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/caps',
    title: 'Caps probe',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    draft: 'draft.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities,
    ...(backend === undefined ? {} : { command_backend: backend }),
  }))
  const routes = []
  const tools = []
  const services = { tools: { register(definition) { tools.push(definition); return () => {} } } }
  const get = (name) => services[name]
  const bridgeCtx = {
    connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
    effect: (run) => (run() ?? (() => {})),
    logger: {},
    get,
  }
  const ctx = {
    inject(_names, fn) { fn(bridgeCtx) },
    effect: (run) => (run() ?? (() => {})),
    get,
    logger: {},
  }
  apply(ctx, { reviewCoreDir: core.root })
  const meta = async () => {
    const url = new URL('http://dsh.local/api/review.surface')
    url.searchParams.set('surface', surface)
    const route = routes.find((entry) => entry.path === '/api/review.surface')
    return (await (await route.fetch(new Request(url))).json()).surface
  }
  return { root, reviewDir, surface, routes, tools, meta }
}

test('a backend only the core knows about is advertised, because the plugin has no list', async (t) => {
  const core = await fakeCore(t, { accepts: 'x-workbench/1' })
  const f = await fixture(t, { core, capabilities: ['command'], backend: 'x-workbench/1' })
  assert.deepEqual((await f.meta()).capabilities, ['command'])
  const receipt = await f.tools[0].execute({ surface: f.surface }, { agent: { session: { id: 's1' } } })
  assert.deepEqual(receipt.capabilities, ['command'])
})

test('the same backend name is refused when the core refuses it', async (t) => {
  const core = await fakeCore(t, { accepts: 'x-workbench/1' })
  const f = await fixture(t, { core, capabilities: ['command'], backend: 'svg-workbench/1' })
  assert.deepEqual((await f.meta()).capabilities, [])
  const receipt = await f.tools[0].execute({ surface: f.surface }, { agent: { session: { id: 's1' } } })
  assert.deepEqual(receipt.capabilities, [])
})

test('a core without a runner advertises no command capability', async (t) => {
  const core = await fakeCore(t, { includeRunner: false })
  const f = await fixture(t, { core, capabilities: ['command'], backend: 'x-workbench/1' })
  assert.deepEqual((await f.meta()).capabilities, [])
})

test('page init, review_open receipt and route admission read the same answer, computed once', async (t) => {
  const core = await fakeCore(t, { accepts: 'x-workbench/1' })
  const f = await fixture(t, {
    core,
    capabilities: ['command', 'draft', 'asset-upload'],
    backend: 'x-workbench/1',
  })
  const init = (await f.meta()).capabilities
  const receipt = (await f.tools[0].execute({ surface: f.surface }, { agent: { session: { id: 's1' } } })).capabilities
  const again = (await f.meta()).capabilities
  assert.deepEqual(init, ['command', 'draft', 'asset-upload'])
  assert.deepEqual(receipt, init)
  assert.deepEqual(again, init)

  // Admission reads the same answer: a declared-and-available capability is not
  // refused by the entry, and the core was asked once for all four readers.
  const draft = f.routes.find((entry) => entry.path === '/api/review.draft')
  const url = new URL('http://dsh.local/api/review.draft')
  url.searchParams.set('surface', f.surface)
  assert.equal((await draft.fetch(new Request(url))).status, 200)
  const asked = (await readFile(core.calls, 'utf8')).trim().split('\n').filter(Boolean)
  assert.equal(asked.length, 1, `核心被问了 ${asked.length} 次：能力要一次算清`)
})
