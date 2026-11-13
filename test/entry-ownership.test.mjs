/**
 * 同一份产物被两个面打开时，宿主必须出声。
 *
 * 它不做锁（宿主不写产物，锁也管不住模型直接改文件），但"两个面各自提交、
 * 后者覆盖前者"是这个缝里最容易静默发生的事故 —— 所以 `review_open` 的
 * warnings 里必须有一句人话。
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
const hasBridge = existsSync(join(CORE, 'assets', 'review-bridge.js'))
const coreTest = (name, fn) => test(name, { skip: !hasBridge && 'requires planners-review-core' }, fn)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'review')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><p>artifact</p>', 'utf8')
  const tools = []
  const services = { tools: { register(definition) { tools.push(definition); return () => {} } } }
  const get = (name) => services[name]
  const bridgeCtx = {
    connection: { fetch: { register() { return () => {} } } },
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
    tools,
    async surface(name, id) {
      const path = join(dir, name)
      await writeFile(path, JSON.stringify({
        contract_version: 'review-surface/2.0.0',
        id,
        title: id,
        project_root: '.',
        dir: '.',
        entry: 'index.html',
        feedback: `${name}.feedback.json`,
        wake: { mode: 'steer', text: '{unit}' },
      }), 'utf8')
      return path
    },
  }
}

const open = (tool, surface, sessionId) => tool.execute({ surface }, { agent: { session: { id: sessionId } } })

coreTest('second surface over the same entry warns, the first does not', async (t) => {
  const f = await fixture(t)
  const a = await f.surface('a.json', 'demo/a')
  const b = await f.surface('b.json', 'demo/b')
  const tool = f.tools[0]

  const first = await open(tool, a, 's1')
  assert.equal(first.ok, true)
  assert.equal(first.warnings.some((w) => w.includes('同一份产物')), false, '第一个面不该有这条警告')

  // 同一个面再打开一次（刷新标签）不是"另一个面"。
  const refresh = await open(tool, a, 's1')
  assert.equal(refresh.warnings.some((w) => w.includes('同一份产物')), false, '刷新同一个面不该告警')

  const second = await open(tool, b, 's2')
  assert.equal(second.ok, true)
  assert.ok(
    second.warnings.some((w) => w.includes('同一份产物') && w.includes(a)),
    `第二个面必须被告知产物已被谁打开：${JSON.stringify(second.warnings)}`,
  )

  // 反过来再开 a：现在的登记者是 b，同样该告警（这就是覆盖会发生的那一刻）。
  const back = await open(tool, a, 's1')
  assert.ok(back.warnings.some((w) => w.includes('同一份产物') && w.includes(b)))
})
