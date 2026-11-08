/**
 * The bridge is the one piece of the seam owned by `planners-review-core`; this
 * Host only injects it. These tests pin the three page shapes the contract has to
 * tolerate and the "no injection point is a dead page, so refuse" rule — the last
 * one matters because emitting the bridge source as bare text (or nesting one
 * script in another) produces a page that looks alive and never talks.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const CORE = process.env.DSH_REVIEW_CORE_DIR || resolve(here, '../../../02-skills-library/00-system/planners-review-core')
const BRIDGE = join(CORE, 'assets', 'review-bridge.js')
const hasBridge = existsSync(BRIDGE)
const coreTest = (name, fn) => test(name, { skip: !hasBridge && 'requires planners-review-core' }, fn)

async function fixture(t, { contractVersion = 'review-surface/2.0.0', capabilities = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-bridge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  const surface = join(reviewDir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: contractVersion,
    id: 'probe/page',
    title: 'Page probe',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities,
  }))
  const routes = []
  const tools = []
  const services = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
  }
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
  apply(ctx, { reviewCoreDir: CORE })
  return {
    root,
    surface,
    routes,
    tools,
    async page(html) {
      await writeFile(join(reviewDir, 'index.html'), html)
      const url = new URL('http://dsh.local/api/review.page')
      url.searchParams.set('surface', surface)
      return routes.find((route) => route.path === '/api/review.page').fetch(new Request(url))
    },
  }
}

const scriptCount = (html) => (html.match(/<script\b/gi) ?? []).length

coreTest('the canonical bare marker becomes one complete script', async (t) => {
  const f = await fixture(t)
  const response = await f.page('<!doctype html>\n{{REVIEW_BRIDGE}}\n<p>hello</p>')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.equal(html.includes('{{REVIEW_BRIDGE}}'), false, '注入点必须被整体换掉')
  assert.equal(scriptCount(html), 1, '桥必须在一个完整的 <script> 里，且只有一个')
  assert.match(html, /ReviewBridge\.VERSION|var VERSION/)
  assert.match(html, /<p>hello<\/p>/, '页面其余部分保持原样')
})

coreTest('the two legacy element shapes are replaced whole, never nested', async (t) => {
  const f = await fixture(t)
  for (const html of [
    '<!doctype html><script src="{{REVIEW_BRIDGE}}"></script><p>x</p>',
    '<!doctype html><script>{{REVIEW_BRIDGE}}</script><p>x</p>',
  ]) {
    const response = await f.page(html)
    assert.equal(response.status, 200)
    const injected = await response.text()
    assert.equal(scriptCount(injected), 1, `嵌套脚本会静默死掉：${html}`)
    assert.equal(injected.includes('{{REVIEW_BRIDGE}}'), false)
    assert.match(injected, /ReviewBridge\.VERSION|var VERSION/)
  }
})

coreTest('an entry without the injection point is refused, not served dead', async (t) => {
  const f = await fixture(t)
  const response = await f.page('<!doctype html><p>no marker</p>')
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /REVIEW_BRIDGE/)
})

coreTest('review_open warns when the surface was written for another contract version', async (t) => {
  const f = await fixture(t, { contractVersion: 'review-surface/1.9.0' })
  await f.page('{{REVIEW_BRIDGE}}')
  const tool = f.tools[0]
  assert.equal(tool.name, 'review_open')
  const result = await tool.execute({ surface: f.surface }, { agent: { session: { id: 's1' } } })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((warning) => warning.includes('contract_version')), result.warnings.join('\n'))
  assert.deepEqual(result.tab, { id: 'probe/page', title: 'Page probe', revision: 1 })
})

coreTest('review_open accepts a matching contract version without a version warning', async (t) => {
  const f = await fixture(t)
  await f.page('{{REVIEW_BRIDGE}}')
  const result = await f.tools[0].execute({ surface: f.surface }, { agent: { session: { id: 's1' } } })
  assert.equal(result.ok, true)
  assert.equal(result.warnings.some((warning) => warning.includes('contract_version')), false)
})
