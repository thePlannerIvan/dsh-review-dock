/**
 * The bridge is the one piece of the seam owned by `planners-review-core`; this
 * Host only injects it. These tests pin the three page shapes the contract has to
 * tolerate, plus the two rules that decide whether a page can talk at all:
 * a missing marker is filled in before `</body>` (never emitted as bare text or
 * nested inside another script), and `annotate: true` adds the shared annotation
 * layer only after the bridge is in place.
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
const ANNOTATE = join(CORE, 'assets', 'annotate', 'annotate.js')
const hasBridge = existsSync(BRIDGE)
const coreTest = (name, fn) => test(name, { skip: !hasBridge && 'requires planners-review-core' }, fn)
const annotateTest = (name, fn) => test(name, { skip: (!hasBridge || !existsSync(ANNOTATE)) && 'requires planners-review-core annotate asset' }, fn)

async function fixture(t, { contractVersion = 'review-surface/2.0.0', capabilities = [], annotate = false } = {}) {
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
    ...(annotate ? { annotate: true } : {}),
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

coreTest('an entry without any marker still gets a complete bridge before </body>', async (t) => {
  // 2026-11: this used to be a 409 ("refusing beats serving a page that can never
  // reach its Host"). Both hosts now append the block themselves, which is what
  // lets an ordinary artifact be reviewed without editing it first.
  const f = await fixture(t)
  const response = await f.page('<!doctype html><html><body><p>no marker</p></body></html>')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.equal(scriptCount(html), 1)
  assert.match(html, /ReviewBridge\.VERSION|var VERSION/)
  assert.ok(html.indexOf('<script') < html.indexOf('</body>'), '桥必须在 </body> 之前')
  assert.match(html, /<p>no marker<\/p>/)
})

annotateTest('annotate:true appends the shared annotation layer after the bridge', async (t) => {
  const f = await fixture(t, { annotate: true })
  const response = await f.page('<!doctype html><html><body><p>plain artifact</p></body></html>')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.equal(scriptCount(html), 2, '桥 + 批注层，各一个完整 script')
  assert.match(html, /ReviewAnnotate/)
  assert.ok(html.indexOf('window.ReviewBridge =') < html.indexOf('window.ReviewAnnotate ='),
    '桥必须先就位，批注层才连得上')
})

annotateTest('annotate:true replaces a bare {{REVIEW_ANNOTATE}} whole', async (t) => {
  const f = await fixture(t, { annotate: true })
  const response = await f.page('<!doctype html><html><body>\n{{REVIEW_BRIDGE}}\n{{REVIEW_ANNOTATE}}\n</body></html>')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.equal(html.includes('{{REVIEW_ANNOTATE}}'), false)
  assert.equal(scriptCount(html), 2)
})

coreTest('a surface that does not ask for annotate gets no annotation layer', async (t) => {
  const f = await fixture(t)
  const response = await f.page('<!doctype html><html><body><p>x</p></body></html>')
  const html = await response.text()
  assert.equal(scriptCount(html), 1)
  assert.equal(html.includes('ReviewAnnotate'), false)
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
