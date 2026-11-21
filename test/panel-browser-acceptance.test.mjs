/**
 * 真浏览器验收进入测试：A 对话开面、切到 B 看不见、切回 A 还在。
 *
 * 缺 Playwright 或缺 planners-review-core 时跳过并说明原因，不伪造通过。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadPlaywright } from './browser/draft-reload.browser.mjs'
import { run } from './browser/panel-conversations.browser.mjs'

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

test('A 对话开面、切到 B 看不见、切回 A 还在（真浏览器）', { skip, timeout: 120000 }, async () => {
  process.env.DSH_REVIEW_CORE_DIR = core
  const evidence = await run()

  assert.equal(evidence.opened.ok, true)
  assert.equal(evidence.noteAfter, evidence.noteBefore, '切回 A 时，页面上写的字必须还在')
  assert.equal(evidence.bornAfter, evidence.bornBefore, '切回 A 必须是同一个文档，不能是重新加载出来的')

  assert.equal(evidence.beforeSwitch.onScreen, 'session-A')
  assert.deepEqual(evidence.beforeSwitch.frames.map((frame) => frame.sessionId), ['session-A'])
  assert.equal(
    evidence.beforeSwitch.layouts.find((entry) => entry.sessionId === 'session-A').tabs.length,
    1,
    'A 只有它自己的一份面，且只有一个标签',
  )

  assert.equal(evidence.afterSwitch.onScreen, 'session-B')
  assert.equal(evidence.aColumnVisibleInB, false, '切到 B 时，A 的审阅面不能还在屏幕上')
  assert.equal(evidence.bFrameCountInB, 0, 'B 的栏里不能出现 A 开的审阅面')
  assert.equal(
    evidence.afterSwitch.frames.filter((frame) => frame.sessionId === 'session-A').length,
    1,
    'A 的标签只是不在屏幕上，没有被拆掉',
  )
  assert.deepEqual(
    evidence.afterSwitch.layouts.filter((entry) => entry.sessionId === 'session-B').flatMap((entry) => entry.tabs),
    [],
    'B 的布局里不该多出一个标签',
  )

  assert.equal(evidence.aFrameCountAfter, 1, '切回 A 不能变成两个标签（重复放置）')
  assert.equal(
    evidence.afterReturn.layouts.find((entry) => entry.sessionId === 'session-A').tabs.length,
    1,
    '几轮轮询之后，A 也不能多出第二个标签',
  )
  assert.equal(
    evidence.afterReturn.frames.filter((frame) => frame.sessionId === 'session-A').length,
    1,
  )
  assert.deepEqual(evidence.consoleErrors, [], '页面与控制台不该有错误')
  assert.equal(evidence.feedbackExists, false, '这次验收没有提交，feedback 文件不该出现')
})
