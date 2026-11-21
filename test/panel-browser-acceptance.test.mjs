/**
 * 真浏览器验收进入测试：A 对话开面、切到 B 看不见、切回 A 还在。
 *
 * 缺 Playwright 或缺 planners-review-core 时跳过并说明原因，不伪造通过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { run } from './browser/panel-conversations.browser.mjs'
import { core, skip } from './support/browser-core.mjs'

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
  assert.match(
    evidence.tableFailure,
    /宿主没有提供动作表——可能是一份旧副本在应答/,
    '取不到动作表时，页面必须看到点名原因',
  )
  assert.doesNotMatch(
    evidence.tableFailure,
    /未知的桥方法/,
    '不能把宿主没有动作表说成桥的问题',
  )
  assert.deepEqual(evidence.consoleErrors, [], '页面与控制台不该有错误')
  assert.equal(evidence.feedbackExists, false, '这次验收没有提交，feedback 文件不该出现')
})
