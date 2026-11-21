/**
 * 草稿回读：页面在侧栏里写的字，刷新之后要能取回来。
 *
 * 这一组只走宿主入口：写一份草稿、读回来、看落盘的字节。页面那一侧的
 * `review.draftRead()` 由真浏览器验收覆盖（test/browser/draft-reload.browser.mjs）。
 * 两条规则在这里钉死：
 *   - 读和写都要求这份面声明过 draft 能力，拒绝时说清是哪一条没声明；
 *   - 有内容返回内容，没有返回空（与无插件宿主逐字节/逐形状一致）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { optionalBridgeApi, requiredBridgeApi } from '../lib/action-table.js'
import { apply } from '../lib/index.js'
import { fakeCordis } from './support/fake-cordis.mjs'

const ALL_BRIDGE_NAMES = [...requiredBridgeApi(), ...optionalBridgeApi()]

/** A tiny `planners-review-core` whose bridge mentions exactly `names`. */
async function fakeCore(t, names) {
  const root = await mkdtemp(join(tmpdir(), 'review-draft-core-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'review-bridge.js'), names.map((name) => `// ${name}`).join('\n'))
  return root
}

async function fixture(t, { capabilities = ['draft'], draft = 'draft.json', coreDir = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-draft-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  const surface = join(reviewDir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/draft',
    title: 'Draft probe',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    ...(draft === '' ? {} : { draft }),
    wake: { mode: 'queue', text: '{unit}' },
    capabilities,
  }))
  const plugin = fakeCordis()
  apply(plugin.ctx, coreDir === '' ? {} : { reviewCoreDir: coreDir })
  const { routes } = plugin
  return {
    root,
    reviewDir,
    surface,
    routes,
    draftFile: join(reviewDir, draft === '' ? 'none.json' : draft),
    get() {
      const url = new URL('http://dsh.local/api/review.draft')
      url.searchParams.set('surface', surface)
      return routes.find((route) => route.path === '/api/review.draft').fetch(new Request(url))
    },
    post(payload) {
      return routes.find((route) => route.path === '/api/review.draft').fetch(new Request('http://dsh.local/api/review.draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface, payload }),
      }))
    },
  }
}

test('读草稿：存过什么就取回什么', async (t) => {
  const f = await fixture(t)
  const saved = { annotations: [{ id: 'a1', text: '这句再短一点' }] }
  await writeFile(f.draftFile, JSON.stringify(saved))
  const response = await f.get()
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).draft, saved)
})

test('读草稿：什么都没存过就是空，而不是一个错误', async (t) => {
  const f = await fixture(t)
  const response = await f.get()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { draft: null })
})

test('读草稿：面没声明 draft 能力就拒绝，并说清是哪一条', async (t) => {
  const f = await fixture(t, { capabilities: [] })
  const response = await f.get()
  const body = await response.json()
  assert.equal(response.status, 403, JSON.stringify(body))
  assert.match(body.error, /没有声明 draft 能力/)
  assert.match(body.error, /读草稿/)
})

test('读草稿：声明了但这份桥不会说 draft，拒绝理由是宿主做不到', async (t) => {
  // 让这份桥缺的是 `draft` 自己（它撑起能力），不是 `draftRead`：后者缺席只让
  // 读回不可用，不会把存草稿也关掉（见 test/action-table.test.mjs 那条）。
  const core = await fakeCore(t, ALL_BRIDGE_NAMES.filter((name) => name !== 'draft'))
  const f = await fixture(t, { coreDir: core })
  const response = await f.get()
  const body = await response.json()
  assert.equal(response.status, 403, JSON.stringify(body))
  assert.match(body.error, /宿主当前做不到 draft/)
})

test('写草稿：面没声明 draft 能力就拒绝，且一个字节都不落盘', async (t) => {
  const f = await fixture(t, { capabilities: [] })
  const response = await f.post({ kind: 'draft' })
  const body = await response.json()
  assert.equal(response.status, 403, JSON.stringify(body))
  assert.match(body.error, /没有声明 draft 能力/)
  assert.match(body.error, /写草稿/)
  await assert.rejects(() => readFile(f.draftFile), /ENOENT/)
})

test('写草稿：声明了能力但没写 draft 文件，回执说清是文件没声明', async (t) => {
  const f = await fixture(t, { draft: '' })
  const response = await f.post({ kind: 'draft' })
  const body = await response.json()
  assert.equal(response.status, 409, JSON.stringify(body))
  assert.match(body.error, /draft 文件/)
})

test('写草稿：原样落盘，形状与无插件宿主一致', async (t) => {
  const f = await fixture(t)
  const payload = { annotations: [{ id: 'a1', text: '保留这一句' }] }
  const response = await f.post(payload)
  assert.equal(response.status, 200, await response.text())
  assert.equal(await readFile(f.draftFile, 'utf8'), `${JSON.stringify(payload, null, 2)}\n`)
})
