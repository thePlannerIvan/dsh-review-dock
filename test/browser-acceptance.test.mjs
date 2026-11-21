/**
 * 真浏览器验收进入测试：写 → 刷新 → 字还在。
 *
 * 这是 ticket 里唯一的「验收」，不是接缝：它用真 Chromium 打开一份装进 iframe 的
 * 审阅页，在输入框里打字，等草稿落盘，刷新，断言字回到页面上。父页面用的是
 * lib/client.js 里那个真正的转交（`carry`），表从宿主读 —— 与侧栏同一条路。
 *
 * 缺 Playwright 或缺 planners-review-core 时跳过并说明原因，不伪造通过。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadPlaywright, run } from './browser/draft-reload.browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** The same search the plugin does, narrowed to the copies a test can rely on. */
function coreDir() {
  const candidates = [
    process.env.DSH_REVIEW_CORE_DIR,
    join(homedir(), '.dsh', 'skills', 'planners-review-core'),
    join(homedir(), '.claude', 'skills', 'planners-review-core'),
    join(homedir(), '.codex', 'skills', 'planners-review-core'),
    resolve(here, '../../../02-skills-library/00-system/planners-review-core'),
  ].filter((value) => typeof value === 'string' && value !== '')
  return candidates.find((dir) => existsSync(join(dir, 'assets', 'review-bridge.js'))) ?? ''
}

const core = coreDir()
const { playwright, error } = loadPlaywright()
const skip = core === ''
  ? 'requires planners-review-core (set DSH_REVIEW_CORE_DIR)'
  : playwright === undefined
    ? error
    : false

test('侧栏里写字、刷新，字还在（真浏览器）', { skip, timeout: 120000 }, async () => {
  // Pin the core this test was skipped-checked against, so the mount and this
  // test cannot disagree about which copy is in use.
  process.env.DSH_REVIEW_CORE_DIR = core
  const evidence = await run()
  assert.equal(evidence.restored, '刷新之后这句话还在')
  assert.equal(evidence.restoredStatus, 'restored')
  assert.deepEqual(evidence.relayErrors, [], '转交里不该有任何失败')
  assert.deepEqual(evidence.consoleErrors, [], '页面与控制台不该有错误')
  assert.equal(evidence.feedbackExists, false, '草稿不是提交：feedback 文件不该出现')
})
