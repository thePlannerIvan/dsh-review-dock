import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { ACTIONS } from '../lib/action-table.js'
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

/**
 * 入口准入：没声明 `command` 的面，连核心都不该被问到。
 *
 * 这不是「核心会不会拒」的问题 —— 核心的 runner 只管后端认不认可，它不知道
 * 这份面自己声明了什么。和草稿一样，声明的门在宿主这一侧。
 */
test('命令入口先过能力准入：没有声明 command 的面直接 403', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-command-admission-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const surface = join(root, 'surface.json')
  await writeFile(join(root, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/command-admission',
    title: 'Command admission',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities: [],
  }))
  const response = await handleReviewCommand(new Request('http://dsh.local/api/review.command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surface, payload: { op: 'state' } }),
  }), '')
  assert.equal(response.status, 403, '没声明 command 能力的面不该走到 runner')
  assert.match((await response.json()).error, /没有声明 command 能力/)
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
  // Admission reads the same answer as the page and the receipt: a backend Core
  // will not run is refused at the door, before a runner ever gets asked.
  const notAdmitted = await handleReviewCommand(request(f, { op: 'state' }), f.core)
  assert.equal(notAdmitted.status, 403)
  assert.equal((await notAdmitted.json()).code, 'command_not_admitted')
  assert.equal((await f.calls()).length, 0, '被准入挡下时不该真的跑一次命令')
  await f.setSurface({ capabilities: [] })
  assert.deepEqual((await meta()).capabilities, [])
  const old = await commandFixture(t)
  await rm(join(old.core, 'scripts/lib/review-command.mjs'))
  // A fresh fixture has no import cache entry; an old core cannot be advertised.
  const oldMeta = await (await handleReviewSurface(new Request('http://dsh.local/api/review.surface?surface=' + encodeURIComponent(old.surface)), old.core)).json()
  assert.deepEqual(oldMeta.surface.capabilities, [])
  // 没有 runner = 这个能力此刻不成立：入口同样在门口拒绝，而不是先 200 再报错。
  assert.equal((await handleReviewCommand(request(old, { op: 'state' }), old.core)).status, 403)
  assert.equal((await handleReviewCommand(request(f, { op: 'state' }), join(f.base, 'missing-core'))).status, 403)
})

integrationTest('plugin validates method, content-type and malformed requests', async (t) => {
  const f = await commandFixture(t)
  assert.equal((await handleReviewCommand(new Request('http://dsh.local/api/review.command'), f.core)).status, 405)
  assert.equal((await handleReviewCommand(new Request('http://dsh.local/api/review.command', { method: 'POST', body: '{}' }), f.core)).status, 415)
  assert.equal((await handleReviewCommand(new Request('http://dsh.local/api/review.command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), f.core)).status, 400)
})

integrationTest('DSH registration uses exported command handler, not a model tool', async (t) => {
  const f = await commandFixture(t)
  const g = await commandFixture(t)
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
  const reviewOpen = tools[0]
  // No conversation identity is NOT a refusal any more: the surface waits to be
  // claimed by the conversation whose panel is actually on screen.
  const missingSession = await reviewOpen.execute({ surface: f.surface }, { agent: { session: {} } })
  assert.equal(missingSession.ok, true)
  assert.equal(missingSession.session_unknown, true)
  assert.match(missingSession.warnings.join(' '), /认领/)
  const openedVideo = await reviewOpen.execute({ surface: f.surface }, { agent: { session: { id: 'video-session' } } })
  const openedPpt = await reviewOpen.execute({ surface: g.surface }, { agent: { session: { id: 'ppt-session' } } })
  assert.equal(openedVideo.ok, true)
  assert.equal(openedPpt.ok, true)
  const current = routes.find((entry) => entry.path === '/api/review.current')
  assert.ok(current)
  const currentFor = async (sessionId) => (await current.fetch(new Request(
    'http://dsh.local/api/review.current?sessionId=' + encodeURIComponent(sessionId),
  ))).json()
  // The first poll after that identity-less open claims it; the other
  // conversation must never see it.
  const video = await currentFor('video-session')
  assert.deepEqual(video.surfaces.map((entry) => entry.surface), [f.surface])
  const ppt = await currentFor('ppt-session')
  assert.deepEqual(ppt.surfaces.map((entry) => entry.surface), [g.surface])
  assert.equal(video.surface, f.surface)
  assert.equal(ppt.surface, g.surface)

  // Two surfaces in ONE conversation: two entries, independent revisions, and the
  // first one is still there (0.2.x would have kept only the second).
  const again = await reviewOpen.execute({ surface: g.surface }, { agent: { session: { id: 'video-session' } } })
  assert.equal(again.ok, true)
  const firstRevision = video.surfaces[0].revision
  const both = await currentFor('video-session')
  assert.deepEqual(both.surfaces.map((entry) => entry.surface), [f.surface, g.surface])
  assert.deepEqual(both.surfaces.map((entry) => entry.revision), [firstRevision, 1])
  const reopened = await reviewOpen.execute({ surface: f.surface }, { agent: { session: { id: 'video-session' } } })
  assert.equal(reopened.revision, firstRevision + 1, '同一份面再开只让它的 revision 走一格')
  const afterReopen = await currentFor('video-session')
  assert.deepEqual(
    afterReopen.surfaces.map((entry) => entry.surface).sort(),
    [f.surface, g.surface].sort(),
    '刷新不许改变面的个数',
  )
  const revisionOf = (body, surface) => body.surfaces.find((entry) => entry.surface === surface).revision
  assert.equal(revisionOf(afterReopen, f.surface), firstRevision + 1, '被再开的那一份 revision 走一格')
  assert.equal(revisionOf(afterReopen, g.surface), 1, '别的面的 revision 不受牵连')
  assert.equal((await current.fetch(new Request('http://dsh.local/api/review.current'))).status, 400)
  // The relay is table-driven; its wiring for `command` is proven behaviourally
  // in test/relay.test.mjs, which drives every row of the table through the real
  // sidebar relay. Reading client.js for branch text was what let `draftRead`
  // stay missing while three "checks" stayed green.
  const commandAction = ACTIONS.find((action) => action.name === 'command')
  assert.equal(commandAction.route, '/api/review.command')
  assert.equal(commandAction.relay.method, 'POST')
  assert.deepEqual(commandAction.relay.body, ['surface', 'payload'])
})
