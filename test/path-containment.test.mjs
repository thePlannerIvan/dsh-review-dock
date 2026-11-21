/**
 * 入口只做一件事：把围栏的回答映射成 403 或 404。
 *
 * 「这个路径在不在这个根里面」只有一份答案，在 `lib/paths.js`，由
 * `test/path-fence.test.mjs` 直接打那三个动作来测（软链祖先算不算越界、真实
 * 路径怎么比、绝对目标怎么管，都在那儿）。这一份只证明入口照着理由回话，
 * 不再绕远路去测包含性本身。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { fakeCordis } from './support/fake-cordis.mjs'

/** Mount the plugin and hand back its two writers. */
function writers() {
  const plugin = fakeCordis()
  apply(plugin.ctx, {})
  const routeOf = (path) => {
    const route = plugin.routes.find((entry) => entry.path === path)
    assert.ok(route, `没有注册 ${path}`)
    return route
  }
  return { draft: routeOf('/api/review.draft'), write: routeOf('/api/review.write') }
}

const post = (route, surface) => route.fetch(new Request('http://dsh.local' + route.path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ surface, payload: { kind: 'x' } }),
}))

/** A surface in its own project directory; `data` overrides what it declares. */
async function project(t, data) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-mapping-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'project', 'review')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html>\n{{REVIEW_BRIDGE}}\n')
  const surface = join(dir, 'surface.json')
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'probe/path-mapping',
    title: 'Path mapping',
    dir: '.',
    entry: 'index.html',
    wake: { mode: 'steer', text: '{unit}' },
    capabilities: ['draft'],
    ...data,
  }))
  return { root, dir, surface }
}

test('越界写是 403：两个写入口读同一份围栏答案', async (t) => {
  const { root, dir, surface } = await project(t, {
    project_root: '.',
    feedback: 'leak/feedback.json',
    draft: 'leak/draft.json',
  })
  // `project_root: '.'` 把围栏留在 review 目录：软链目标在它外面，字面上却合法。
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(dir, 'leak'), 'dir')

  const { draft, write } = writers()
  assert.equal((await post(draft, surface)).status, 403)
  assert.equal((await post(write, surface)).status, 403)
})

test('围栏根不存在是 404，而不是也报 403', async (t) => {
  // 目标字面上在根里面、根自己却解析不出来：这正是 `missing` 的那一种理由。
  const { surface } = await project(t, {
    project_root: '../gone',
    feedback: '../gone/feedback.json',
    draft: '../gone/draft.json',
  })
  const { draft, write } = writers()
  assert.equal((await post(draft, surface)).status, 404)
  assert.equal((await post(write, surface)).status, 404)
})
