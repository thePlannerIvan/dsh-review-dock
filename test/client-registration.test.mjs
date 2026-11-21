/**
 * 界面那一层对 DSH 的契约：一种标签、三个 effect、一张注入表。
 *
 * 这不是源码文字检查，而是把 `apply()` 挂在一个假 ctx 上看它登记了什么 ——
 * 换个内部写法、甚至把整个状态机再挪走，只要对 DSH 的接口不变，这一组就仍然
 * 描述得对；标签类型少 `multiple: true` 时它会红。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClient } from './support/panel-harness.mjs'

const client = await loadClient()

function applyToFakeCtx() {
  const registered = { tabType: null, slots: [], effects: [] }
  const slots = {
    inject(name, run) {
      run()
      return () => {}
    },
    register(definition, component) {
      registered.slots.push({ ...definition, component })
      return () => {}
    },
  }
  const ctx = {
    effect(run, label) {
      registered.effects.push(label)
      return run() ?? (() => {})
    },
    slots,
    sidebarRightTabs: {
      register(definition) {
        registered.tabType = definition
        return () => {}
      },
    },
  }
  client.apply(ctx)
  return registered
}

test('一种标签、三个 effect：DSH 的加载契约不变', () => {
  assert.equal(typeof client.createPanel, 'function', '状态机必须能在浏览器外被驱动')
  assert.equal(typeof client.carry, 'function', '转交仍只有一份实现')
  assert.deepEqual(
    client.inject,
    ['layout', 'slots', 'sidebarRightTabs', 'sidebarRight'],
    'rightbar 的展开依赖 layout 注入，少一个展开就是静默无效',
  )

  const registered = applyToFakeCtx()
  assert.deepEqual(registered.effects, [
    'dsh-review-dock: tab type',
    'dsh-review-dock: tab body',
    'dsh-review-dock: tab title',
  ])
  assert.deepEqual(registered.slots.map((entry) => entry.name), [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])
  assert.equal(typeof registered.slots[0].component, "function")
})

test('标签类型声明了多实例与保活，并在指南里出现', () => {
  const { tabType } = applyToFakeCtx()
  assert.equal(tabType.id, 'dsh-review-dock')
  assert.equal(tabType.kind, 'review')
  assert.equal(tabType.multiple, true, '不声明 multiple，第二次开标签会顶掉第一次')
  assert.equal(tabType.keepMounted, true, '不保活，人切走一次标签里写了一半的审阅就没了')
  assert.equal(tabType.title(), '审阅')
  assert.equal(tabType.guide.length, 1)
  assert.equal(tabType.guide[0].title(), '审阅')
})
