/**
 * 谁拥有哪个标签、什么时候放上去 —— 只用三个动作驱动。
 *
 * 这一半过去住在 React 闭包里，仓库只能靠读 `lib/client.js` 的源码文字来"检查"。
 * 现在它是 `createPanel()` 返回的普通对象：喂一次清单（observe）、放一个标签
 * （place）、转交一次请求（relay）。这些用例只经由它看行为：哪个对话多了一个
 * 标签、哪个对话被碰了、失败留下了什么原因。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { answer, createFakeHost, loadClient } from './support/panel-harness.mjs'

const client = await loadClient()
const { createPanel } = client

const A = '/review/a/surface.json'
const B = '/review/b/surface.json'

function panelFor(fake, extra = {}) {
  return createPanel({ host: fake.host, ...extra })
}

test('一次清单把一个标签放进它自己的对话，即使屏幕上正开着别的对话', () => {
  const fake = createFakeHost({ onScreen: 'conversation-B' })
  fake.mount('conversation-A', '')
  const panel = panelFor(fake)

  const receipt = panel.observe('conversation-A', answer([{ surface: A, revision: 1, title: 'A 的审阅' }]))

  assert.equal(fake.opened.length, 1, '应当恰好开一个标签')
  const [opened] = fake.opened
  assert.equal(opened.via, 'tab', '必须走该对话自己的标签动作')
  assert.equal(opened.sessionId, 'conversation-A')
  assert.deepEqual(opened.options.params, { surface: A, sessionId: 'conversation-A' })
  assert.deepEqual(receipt.placed, [{ surface: A, via: 'tab' }])
  assert.equal(panel.revision('conversation-A', A), 1)
})

test('一个对话的轮询不碰另一个对话的标签与画面', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  fake.mount('conversation-B', '')
  const panel = panelFor(fake)
  panel.observe('conversation-A', answer([{ surface: A, revision: 1, title: 'A' }]))
  const before = {
    opened: fake.opened.length,
    revision: panel.revision('conversation-A', A),
    title: panel.title('conversation-A', A),
  }

  panel.observe('conversation-B', answer([{ surface: B, revision: 3, title: 'B' }]))

  assert.equal(panel.revision('conversation-A', A), before.revision, 'A 的帧不能因为 B 的清单重画')
  assert.equal(panel.title('conversation-A', A), before.title)
  assert.equal(fake.opened.length, before.opened + 1)
  assert.equal(fake.opened.at(-1).sessionId, 'conversation-B')
  assert.equal(panel.revision('conversation-B', B), 3)
})

test('放不进去的面先等着；轮到它的对话时再放，并且只为它展开右栏', () => {
  const fake = createFakeHost({ onScreen: 'conversation-B' })
  const panel = panelFor(fake)

  const first = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  assert.equal(fake.opened.length, 0, 'A 不在屏幕上，也没有自己的标签可放：宁可不放，也不放错')
  assert.deepEqual(first.waiting, [{ surface: A, reason: 'not-on-screen' }])
  assert.equal(first.failed.length, 0)
  assert.deepEqual(fake.reveals, [], '不能为后台对话展开 B 的右栏')

  fake.show('conversation-A')
  const second = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  assert.equal(fake.opened.length, 1)
  assert.equal(fake.opened[0].via, 'screen')
  assert.equal(fake.opened[0].sessionId, 'conversation-A')
  assert.deepEqual(fake.reveals, ['conversation-A'], '只展开这个面自己所在对话的右栏')
  assert.deepEqual(second.placed, [{ surface: A, via: 'screen' }])
})

test('放置失败要留下原因，而不是和「还没轮到」混成同一种等待', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = panelFor(fake)
  fake.failOpening('右栏没有可用的控制器')

  const failed = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  assert.equal(failed.waiting.length, 0, '尝试过并失败，不能算「等待」')
  assert.deepEqual(failed.failed, [{ surface: A, reason: '右栏没有可用的控制器' }])
  const problems = panel.problems()
  assert.equal(problems.length, 1)
  assert.equal(problems[0].surface, A)
  assert.match(problems[0].reason, /右栏没有可用的控制器/)

  fake.failOpening('')
  const retried = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  assert.equal(fake.opened.length, 1, '失败的面必须在下一轮重试，不能永久丢掉')
  assert.deepEqual(retried.placed, [{ surface: A, via: 'screen' }])
  assert.deepEqual(panel.problems(), [], '重试成功后原因要清掉')
})

test('同一份面在同一对话里不会并排开两个标签', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = panelFor(fake)

  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  panel.observe('conversation-A', answer([{ surface: A, revision: 2 }]))

  assert.equal(fake.opened.length, 1, 'revision 变化只该换帧的 key，不该再开一个标签')
  assert.equal(panel.revision('conversation-A', A), 2)
})

test('人关掉的标签靠轮询不会自己回来，重新交接才重建', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  let clock = 0
  const panel = panelFor(fake, { now: () => clock })

  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.equal(fake.opened.length, 1)

  fake.close('conversation-A', A)
  clock += 60_000
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.equal(fake.opened.length, 1, '普通轮询不许把关闭的标签开回来')

  panel.observe('conversation-A', answer([{ surface: A, revision: 2 }]))
  assert.equal(fake.opened.length, 2, 'Agent 重新交接（revision 走一格）时必须重建')
})

test('布局探针抛错与布局为空不是一回事：抛错不许被当成「人关掉了所有标签」', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  let clock = 0
  const panel = panelFor(fake, { now: () => clock })
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  fake.close('conversation-A', A)
  fake.probeWith(() => {
    throw new Error('tabsIn 不存在')
  })
  clock += 60_000
  const unknown = panel.observe('conversation-A', answer([{ surface: A, revision: 2 }]))

  assert.equal(fake.opened.length, 1, '探针失败时不能重开标签（那正是重复标签的来源）')
  assert.equal(unknown.layout.known, false)
  assert.match(unknown.layout.reason, /tabsIn 不存在/)
  assert.equal(unknown.waiting.length, 1)
  assert.equal(unknown.waiting[0].reason, 'layout-unknown')
  assert.ok(panel.problems().some((entry) => entry.kind === 'layout' && /tabsIn 不存在/.test(entry.reason)))

  fake.probeWith(null)
  const known = panel.observe('conversation-A', answer([{ surface: A, revision: 2 }]))
  assert.equal(known.layout.known, true)
  assert.equal(known.layout.count, 0)
  assert.equal(fake.opened.length, 2, '证据恢复后，空的布局才算「人关掉了」')
})

test('标签数变少不能独自判定关闭：还挂着的面必须被别的证据保住', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  let clock = 0
  const panel = panelFor(fake, { now: () => clock })
  panel.observe('conversation-A', answer([
    { surface: A, revision: 1 },
    { surface: B, revision: 1 },
  ]))
  // Both frames mount: each reports itself as a live tab of this conversation.
  fake.mount('conversation-A', A)
  fake.mount('conversation-A', B)
  // The human closes B; A is still mounted and claims itself.
  fake.close('conversation-A', B)
  clock += 60_000

  panel.observe('conversation-A', answer([
    { surface: A, revision: 2 },
    { surface: B, revision: 1 },
  ]))
  assert.equal(fake.opened.length, 2, 'A 还挂着，revision 变化只能展开/复用，不能重开')

  panel.observe('conversation-A', answer([
    { surface: A, revision: 2 },
    { surface: B, revision: 2 },
  ]))
  assert.equal(fake.opened.length, 3, '真正关掉的 B 被重新交接时应当只补回一个')
  assert.equal(fake.opened.at(-1).options.params.surface, B)
})

test('探针说「少了」但挂载证据与它矛盾时，谁都不许被忘掉', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  let clock = 0
  const panel = panelFor(fake, { now: () => clock })
  panel.observe('conversation-A', answer([
    { surface: A, revision: 1 },
    { surface: B, revision: 1 },
  ]))
  fake.mount('conversation-A', A)
  fake.mount('conversation-A', B)
  // The layout probe lies: both tabs are still mounted, it reports one.
  fake.probeWith(() => [{ kind: 'review' }])
  clock += 60_000

  const receipt = panel.observe('conversation-A', answer([
    { surface: A, revision: 2 },
    { surface: B, revision: 2 },
  ]))

  assert.equal(receipt.layout.known, false, '与被挂载证据矛盾的清单不可信')
  assert.equal(fake.opened.length, 2, '不能因为一个矛盾的计数就把两份面都当成关了')
})

test('空标签认领了较早的一份面之后，后来交接的仍能开出来', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = panelFor(fake)
  const release = fake.mount('conversation-A', '', { unbound: 1 })

  const first = panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.deepEqual(first.waiting, [{ surface: A, reason: 'empty-tab' }])

  // The empty tab pins A; a second surface handed over afterwards must still
  // get its own tab instead of being swallowed by the now-adopted tab.
  release()
  fake.mount('conversation-A', A)
  const second = panel.observe('conversation-A', answer([
    { surface: A, revision: 1 },
    { surface: B, revision: 1 },
  ]))

  assert.deepEqual(second.waiting, [])
  assert.deepEqual(second.placed, [{ surface: B, via: 'tab' }])
  assert.equal(fake.opened.length, 1)
  assert.equal(fake.opened[0].options.params.surface, B)
})

test('宿主没有标签清单入口时，布局是「不知道」，不是 0', () => {
  const panel = createPanel({ host: { onScreen: () => 'conversation-A' } })
  const receipt = panel.observe('conversation-A', answer([]))
  assert.equal(receipt.layout.known, false)
  assert.match(receipt.layout.reason, /标签清单/)
  assert.ok(panel.problems().some((entry) => entry.kind === 'layout'))
})

test('刚放上去的面有一段宽限：布局还没来得及反映时不算被关掉', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  let clock = 0
  const panel = panelFor(fake, { now: () => clock })
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  // The open has not reached the layout snapshot yet — the probe still says empty.
  fake.layouts.get('conversation-A').length = 0

  clock += 1_000
  panel.observe('conversation-A', answer([{ surface: A, revision: 2 }]))
  assert.equal(fake.opened.length, 1, '宽限期内不许把刚开的标签当成被关掉再开一个')

  clock += 10_000
  panel.observe('conversation-A', answer([{ surface: A, revision: 3 }]))
  assert.equal(fake.opened.length, 2, '宽限期过后，空的布局仍然算关闭')
})
