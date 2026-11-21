/**
 * 路径围栏只回答三件事：能不能读、能不能写、没写出来的文件会落在哪。
 *
 * 答案里的理由只有三种 —— 越界（escape）、不存在（missing）、经过符号链接
 * （symlink）。调用现场只做一件事：照着理由回 403 或 404，不再自己拼真实路径、
 * 不再自己比前缀。这一组直接打这三下，比绕入口测包含性短得多。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canRead, canWrite, landingOf, statusForReason } from '../lib/paths.js'

async function project(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-fence-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'project', 'review')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'page.html'), '<p>page</p>')
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'secret.txt'), 'secret')
  return { root, dir }
}

test('能不能读：围栏里的文件给出真实路径', async (t) => {
  const { dir } = await project(t)
  const result = await canRead(dir, 'page.html')
  assert.equal(result.ok, true)
  assert.equal(result.real, join(await realpath(dir), 'page.html'))
})

test('能不能读：越界、缺文件、经过符号链接是三种不同的理由', async (t) => {
  const { dir, root } = await project(t)
  assert.deepEqual(await canRead(dir, '../outside/secret.txt'), { ok: false, reason: 'escape' })
  assert.deepEqual(await canRead(dir, 'nope.html'), { ok: false, reason: 'missing' })
  await symlink(join(root, 'outside'), join(dir, 'leak'), 'dir')
  assert.deepEqual(await canRead(dir, 'leak/secret.txt'), { ok: false, reason: 'symlink' })
})

test('能不能读：根自己经过符号链接不算越界（macOS 的 /tmp 就是一条软链）', async (t) => {
  const { root, dir } = await project(t)
  await symlink(dir, join(root, 'alias'), 'dir')
  const result = await canRead(join(root, 'alias'), 'page.html')
  assert.equal(result.ok, true)
})

test('能不能写：还没写出来的文件也回答它落在哪', async (t) => {
  const { dir } = await project(t)
  const result = await canWrite(dir, 'shots/page-01.png')
  assert.equal(result.ok, true)
  assert.equal(result.target, join(await realpath(dir), 'shots', 'page-01.png'))
})

test('能不能写：越界与指向外面的符号链接都拒绝，理由分开', async (t) => {
  const { dir, root } = await project(t)
  assert.deepEqual(await canWrite(dir, '../outside/new.txt'), { ok: false, reason: 'escape' })
  await symlink(join(root, 'outside'), join(dir, 'leak'), 'dir')
  assert.deepEqual(await canWrite(dir, 'leak/new.txt'), { ok: false, reason: 'symlink' })
  await symlink(join(root, 'outside', 'secret.txt'), join(dir, 'linked.txt'))
  assert.deepEqual(await canWrite(dir, 'linked.txt'), { ok: false, reason: 'symlink' })
})

test('能不能写：绝对目标同样受围栏管，调用方不用自己比前缀', async (t) => {
  const { dir, root } = await project(t)
  const inside = await canWrite(dir, join(dir, 'notes', 'draft.json'))
  assert.equal(inside.ok, true)
  const outside = await canWrite(dir, join(root, 'outside', 'draft.json'))
  assert.deepEqual(outside, { ok: false, reason: 'escape' })
})

test('没写出来的文件会落在哪：不存在的目标给出真实落点', async (t) => {
  const { dir } = await project(t)
  const result = await landingOf(dir, 'state.json')
  assert.equal(result.ok, true)
  assert.equal(result.target, join(await realpath(dir), 'state.json'))
})

test('没写出来的文件会落在哪：根不存在时说不存在，不留半截路径', async (t) => {
  const { root } = await project(t)
  const result = await landingOf(join(root, 'no-such-root'), 'state.json')
  assert.deepEqual(result, { ok: false, reason: 'missing' })
})

test('理由只有三种，且只分到两个 HTTP 状态', async () => {
  for (const reason of ['escape', 'symlink']) assert.equal(statusForReason(reason), 403)
  assert.equal(statusForReason('missing'), 404)
})
