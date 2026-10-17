/**
 * Regression for 0.2.4: a surface opened through a symlinked ancestor.
 *
 * The write/draft guards realpath'd `project_root` but compared it against the
 * surface's merely *lexical* target path. On macOS `/tmp` is a symlink to
 * `/private/tmp`, so a perfectly legal surface under `/tmp/...` got 403 from
 * both writers while the Core's own validator accepted the same file — the page
 * was told its save had left `project_root` when it had not.
 *
 * The escape case must stay refused: comparing real paths must not turn the
 * containment check into a no-op.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

const applyRoutes = () => {
  const routes = []
  const context = {
    inject(_names, fn) {
      fn({
        connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
        effect(fn) { fn() },
        logger: {},
      })
    },
    effect(fn) { fn() },
    get() { return { register() { return () => {} } } },
    logger: {},
  }
  apply(context, {})
  return routes
}

const post = (route, surface, payload) => route.fetch(new Request('http://dsh.local' + route.path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ surface, payload }),
}))

const writeSurface = async (dir, data) => {
  const surface = join(dir, 'surface.json')
  await writeFile(join(dir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'fixture/symlink',
    title: 'Symlink',
    dir: '.',
    entry: 'index.html',
    wake: { mode: 'steer', text: '{unit}' },
    capabilities: [],
    ...data,
  }))
  return surface
}

test('write and draft through a symlinked ancestor land inside project_root', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-symlink-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const real = join(root, 'real project')
  await mkdir(join(real, 'review'), { recursive: true })
  await symlink(real, join(root, 'link'), 'dir')

  // The surface is addressed through the symlink; `project_root` is its parent.
  const surface = await writeSurface(join(root, 'link', 'review'), {
    project_root: '..',
    feedback: 'feedback.json',
    draft: 'draft.json',
  })
  const routes = applyRoutes()
  const draft = routes.find((item) => item.path === '/api/review.draft')
  const write = routes.find((item) => item.path === '/api/review.write')
  assert.ok(draft && write)

  const draftResponse = await post(draft, surface, { kind: 'draft' })
  assert.equal(draftResponse.status, 200, await draftResponse.text())
  assert.deepEqual(JSON.parse(await readFile(join(real, 'review', 'draft.json'), 'utf8')), { kind: 'draft' })

  const writeResponse = await post(write, surface, { kind: 'decision' })
  assert.equal(writeResponse.status, 200, await writeResponse.text())
  assert.deepEqual(JSON.parse(await readFile(join(real, 'review', 'feedback.json'), 'utf8')), { kind: 'decision' })
})

test('a real symlink escape is still refused 403', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-escape-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const dir = join(project, 'review')
  await mkdir(dir, { recursive: true })
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(dir, 'leak'), 'dir')

  // `project_root: '.'` keeps the guard at the review directory: the linked
  // target resolves outside it even though every lexical segment looks legal.
  const surface = await writeSurface(dir, {
    project_root: '.',
    feedback: 'leak/feedback.json',
    draft: 'leak/draft.json',
  })
  const routes = applyRoutes()
  const draft = routes.find((item) => item.path === '/api/review.draft')
  const write = routes.find((item) => item.path === '/api/review.write')

  const draftResponse = await post(draft, surface, { kind: 'draft' })
  assert.equal(draftResponse.status, 403, await draftResponse.text())
  const writeResponse = await post(write, surface, { kind: 'decision' })
  assert.equal(writeResponse.status, 403, await writeResponse.text())
})
