/**
 * 真浏览器验收：「界面上永远没有保存按钮」这条约定要有一条会失败的检查。
 *
 * 规格原话是「这次不为它写文档，而是写一条会失败的检查」—— 保存按钮被加回来过
 * 三次。检查断言的是外壳真的渲染出来的 DOM：没有控件，也没有任何写着保存/提交的
 * 东西；顺带证明一次放置失败会在帧底下留一行点名原因，而没有失败时那一行不存在。
 *
 * 缺 Playwright 或缺 planners-review-core 时跳过并说明原因，不伪造通过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { run } from './browser/shell-controls.browser.mjs'
import { core, skip } from './support/browser-core.mjs'

test('外壳渲染出的控件里没有保存按钮；放置失败留一行原因（真浏览器）', { skip, timeout: 120000 }, async () => {
  // Pin the core this test was skipped-checked against, so the mount and this
  // test cannot disagree about which copy is in use.
  process.env.DSH_REVIEW_CORE_DIR = core
  const evidence = await run()

  assert.deepEqual(
    evidence.quietControls,
    [],
    `外壳不许渲染任何控件，更不能有保存按钮：${evidence.quietControls.join(' / ')}`,
  )
  assert.deepEqual(evidence.quietLines, [], '没有失败时，外壳不加状态废话（没有「正常 / 已连接」这类字）')
  assert.match(evidence.failureLine, /^放置失败：/, '放置失败要留下原因，而不是一片空白')
  assert.match(evidence.failureLine, /右栏没有可用的控制器/)
  assert.deepEqual(
    evidence.loudControls,
    [],
    `有失败时也不许冒出保存类控件：${evidence.loudControls.join(' / ')}`,
  )
  assert.deepEqual(evidence.consoleErrors, [], '页面与控制台不该有错误')
})
