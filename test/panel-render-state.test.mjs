/**
 * 帧看什么、标签叫什么、哪个对话算它的 —— 这些也从 React 闭包里出来了。
 *
 * 旧的三条源码文字检查（帧重载 / 对话绑定 / 多面共存）里，属于渲染状态的那一半
 * 在这里变成行为断言：同一路径重新交接必须让 revision 真的走一格、戳只落到那一
 * 份面上、人手开的空标签只认领一次最新面，而「这是哪个对话」只有一套答案。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { answer, createFakeHost, loadClient } from './support/panel-harness.mjs'

const client = await loadClient()
const { createPanel, conversationOf, isMisfiled } = client

const A = '/review/a/surface.json'
const B = '/review/b/surface.json'

test('同一份面的路径没变、revision 变了：帧的 key 必须跟着走', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  const notifications = []
  panel.subscribe(() => notifications.push(panel.revision('conversation-A', A)))

  panel.observe('conversation-A', answer([{ surface: A, revision: 1, title: '第一版' }]))
  assert.equal(panel.revision('conversation-A', A), 1)
  assert.equal(panel.title('conversation-A', A), '第一版')

  panel.observe('conversation-A', answer([{ surface: A, revision: 2, title: '第二版' }]))
  assert.equal(panel.revision('conversation-A', A), 2, '路径相同、revision 变了也必须真的换 URL')
  assert.equal(panel.title('conversation-A', A), '第二版')
  assert.deepEqual(notifications, [1, 2], '两次变化都要叫醒订阅者，不能因为路径没变早退')
  assert.equal(fake.opened.length, 1, '重新交接同一份面只是换帧，不是再开一个标签')
})

test('戳只落到变了的那一份面，别的面不重画', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  panel.observe('conversation-A', answer([
    { surface: A, revision: 1, changedSeq: 0 },
    { surface: B, revision: 1, changedSeq: 0 },
  ]))
  const notifications = []
  panel.subscribe(() => notifications.push('store'))

  const receipt = panel.observe('conversation-A', answer([
    { surface: A, revision: 1, changedSeq: 1 },
    { surface: B, revision: 1, changedSeq: 0 },
  ]))

  assert.deepEqual(receipt.poked, [A])
  assert.equal(panel.changedSeq('conversation-A', A), 1)
  assert.equal(panel.changedSeq('conversation-A', B), 0, 'B 没有被戳')
  assert.deepEqual(notifications, ['store'], '一次戳只通知一次')

  panel.observe('conversation-A', answer([
    { surface: A, revision: 1, changedSeq: 1 },
    { surface: B, revision: 1, changedSeq: 0 },
  ]))
  assert.equal(panel.changedSeq('conversation-A', A), 1, '没有新变化就不许再走一格')
})

test('人手开的空标签只认领一次最新面，之后钉住不动', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  panel.observe('conversation-A', answer([
    { surface: A, revision: 1 },
    { surface: B, revision: 1 },
  ]))
  assert.equal(panel.latest('conversation-A'), B)

  const first = panel.surfaceForTab({ sessionId: 'conversation-A', tabId: 'tab-empty' })
  assert.equal(first, B, '空标签接上最新的一份面')

  panel.observe('conversation-A', answer([{ surface: '/review/c/surface.json', revision: 1 }]))
  assert.equal(
    panel.surfaceForTab({ sessionId: 'conversation-A', tabId: 'tab-empty' }),
    B,
    '认领过就钉住：不能再跟着最新面乱跳',
  )
  assert.equal(
    panel.surfaceForTab({ sessionId: 'conversation-A', tabId: 'tab-other' }),
    '/review/c/surface.json',
    '另一个空标签接它出现时的最新面',
  )
})

test('标签自己的 surface 参数永远优先于认领', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.equal(
    panel.surfaceForTab({ sessionId: 'conversation-A', tabId: 'tab-1', named: B }),
    B,
  )
})

test('「这是哪个对话」只有一套推导：帧、守卫、轮询用同一个答案', () => {
  const facts = { seat: 'conversation-B', named: 'conversation-A' }
  assert.equal(conversationOf(facts), 'conversation-B', '标签所在布局的对话说了算')
  assert.equal(isMisfiled(facts), true, '声明了另一个对话 = 放错了地方，拒渲染')

  // The seat exposes no conversation id: the frame and the guard still agree on
  // the one the opener named, instead of the guard silently switching off while
  // the frame trusts params.
  const unnamedSeat = { seat: '', named: 'conversation-A' }
  assert.equal(conversationOf(unnamedSeat), 'conversation-A')
  assert.equal(isMisfiled(unnamedSeat), false)

  assert.equal(conversationOf({}), '')
  assert.equal(isMisfiled({}), false)
})

test('空标签在的时候，轮询不许为同一份面再开一个标签', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  // The guide's 「审阅」 tab: open, no surface of its own.
  const release = fake.mount('conversation-A', '', { unbound: 1 })

  const receipt = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  assert.equal(fake.opened.length, 0, '空标签会认领这份面；再开一个就会看到两份同样的审阅')
  assert.deepEqual(receipt.waiting, [{ surface: A, reason: 'empty-tab' }])
  // The shell reports the adoption: the empty tab becomes a tab showing A.
  release()
  fake.mount('conversation-A', A)

  const settled = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.deepEqual(settled.waiting, [])
  assert.equal(fake.opened.length, 0, '面已经在某个标签上，轮询不该再动手')
})
