import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { handleReviewCommand, handleReviewSurface, apply } from '../lib/index.js'

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const workspaceCore = resolve(thisDir, '../../../02-skills-library/00-system/planners-review-core')
const coreDir = process.env.DSH_REVIEW_CORE_DIR || workspaceCore
const fixturePath = join(coreDir, 'evals', 'command-transport-fixture.mjs')
const hasCoreFixture = existsSync(fixturePath)
const { commandFixture, seedWorkbench } = hasCoreFixture
  ? await import(pathToFileURL(fixturePath).href)
  : { commandFixture: null, seedWorkbench: null }

const integrationTest = (name, fn) => test(name, { skip: !hasCoreFixture && 'requires planners-review-core eval fixture' }, fn)

const request = (f, payload) => new Request('http://dsh.local/api/review.command', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ surface: f.surface, payload }),
})

integrationTest('plugin exported command boundary uses the explicitly configured core runner for all operations', async (t) => {
  const f = await commandFixture(t)
  for (const op of ['get', 'state', 'save', 'feedback', 'snapshot', 'restore', 'order']) {
    const payload = { op, author: 'human', operation_id: 'op_' + op, page_key: 'page_01', edits: [{ element_id: 'title', kind: 'text', value: 'Human' }] }
    const response = await handleReviewCommand(request(f, payload), f.core)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.deepEqual(result.payload, payload)
    assert.deepEqual(result.args, ['--root', f.project, '--command-json', '--browser'])
  }
  assert.equal((await f.calls()).length, 7)
})

integrationTest('plugin passes backend false/code/error/details unchanged, including CLI exit 1', async (t) => {
  const f = await commandFixture(t)
  const response = await handleReviewCommand(request(f, { op: 'save', operation_id: 'op_retry', fixture_mode: 'conflict' }), f.core)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: false, code: 'conflict', error: 'Changed', current_revision: 'r_new', operation_id: 'op_retry' })
})

integrationTest('plugin refuses command shape/model/executable/root overrides before spawning', async (t) => {
  const f = await commandFixture(t)
  for (const payload of [null, [], { op: 'resolve' }, { op: 'checkout' }, { op: 'save', author: 'model' }, { op: 'save', root: '/tmp/other' }, { op: 'state', executable: '/bin/sh' }]) {
    assert.equal((await (await handleReviewCommand(request(f, payload), f.core)).json()).ok, false)
  }
  assert.equal((await f.calls()).length, 0)
})

integrationTest('plugin exported boundary works with the latest candidate store and preserves real conflict receipt', async (t) => {
  const f = await commandFixture(t, { backend: 'candidate' })
  await seedWorkbench(f)
  const command = async (payload) => (await handleReviewCommand(request(f, payload), f.core)).json()
  const initial = await command({ op: 'get', page_key: 'page_01' })
  assert.equal(initial.ok, true)
  const payload = { op: 'save', operation_id: 'plugin_save', author: 'human', page_key: 'page_01', base_revision: initial.revision, edits: [{ element_id: 'title', kind: 'text', value: 'From sidebar' }] }
  const saved = await command(payload)
  assert.equal(saved.ok, true)
  assert.deepEqual(await command(payload), saved)
  const conflict = await command({ ...payload, operation_id: 'plugin_stale' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'conflict')
  assert.equal(conflict.current_revision, saved.revision)
  assert.equal(conflict.operation_id, 'plugin_stale')
  assert.match((await command({ op: 'get', page_key: 'page_01' })).svg, />From sidebar</)
  assert.equal((await command({ ...payload, operation_id: 'plugin_candidate', base_revision: saved.revision, candidate: 'candidate.svg' })).code, 'invalid_candidate')
  assert.equal((await command({ op: 'feedback', operation_id: 'plugin_feedback', scope: 'page', pages: { page_01: { revision: saved.revision, feedback: 'Revise this page', rewrite_elements: ['title'] } } })).ok, true)
})

integrationTest('plugin capability intersection and older/missing core are explicit', async (t) => {
  const f = await commandFixture(t)
  const meta = async () => (await (await handleReviewSurface(new Request('http://dsh.local/api/review.surface?surface=' + encodeURIComponent(f.surface)), f.core)).json()).surface
  assert.deepEqual((await meta()).capabilities, ['command'])
  await f.setSurface({ command_backend: '/bin/sh' })
  assert.deepEqual((await meta()).capabilities, [])
  assert.equal((await (await handleReviewCommand(request(f, { op: 'state' }), f.core)).json()).code, 'command_not_enabled')
  await f.setSurface({ capabilities: [] })
  assert.deepEqual((await meta()).capabilities, [])
  const old = await commandFixture(t)
  await rm(join(old.core, 'scripts/lib/review-command.mjs'))
  // A fresh fixture has no import cache entry; an old core cannot be advertised.
  const oldMeta = await (await handleReviewSurface(new Request('http://dsh.local/api/review.surface?surface=' + encodeURIComponent(old.surface)), old.core)).json()
  assert.deepEqual(oldMeta.surface.capabilities, [])
  assert.equal((await (await handleReviewCommand(request(old, { op: 'state' }), old.core)).json()).code, 'command_runner_missing')
  assert.equal((await (await handleReviewCommand(request(f, { op: 'state' }), join(f.base, 'missing-core'))).json()).code, 'command_runner_missing')
})

integrationTest('plugin validates method, content-type and malformed requests', async (t) => {
  const f = await commandFixture(t)
  assert.equal((await handleReviewCommand(new Request('http://dsh.local/api/review.command'), f.core)).status, 405)
  assert.equal((await handleReviewCommand(new Request('http://dsh.local/api/review.command', { method: 'POST', body: '{}' }), f.core)).status, 415)
  assert.equal((await handleReviewCommand(new Request('http://dsh.local/api/review.command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), f.core)).status, 400)
})

integrationTest('DSH registration uses exported command handler, not a model tool', async (t) => {
  const f = await commandFixture(t)
  const routes = []
  const tools = []
  const context = {
    inject(_names, fn) { fn({ connection: { fetch: { register(route) { routes.push(route); return () => {} } } }, effect(fn) { fn() }, logger: {} }) },
    effect(fn) { fn() }, get() { return { register(value) { tools.push(value); return () => {} } } }, logger: {},
  }
  apply(context, { reviewCoreDir: f.core })
  const route = routes.find((entry) => entry.path === '/api/review.command')
  assert.ok(route)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal((await (await route.fetch(request(f, { op: 'state' }))).json()).ok, true)
  assert.equal(tools.length, 1, 'Only existing review_open is registered; model commands use CLI')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /method === 'command'/)
  assert.match(source, /endpoint\('review.command'\)/)
  assert.match(source, /JSON.stringify\(\{ surface, payload \}\)/)
})
