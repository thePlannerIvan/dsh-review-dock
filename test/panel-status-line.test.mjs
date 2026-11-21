/**
 * 外壳在帧底下说的那一行。
 *
 * 规格 story 24：「当宿主不在或连接断了，我希望看到一行原因，而不是一片空白」。
 * 所以这一行只在有失败（放置失败、轮询失败）时有内容，失败消失之后一个字都不留；
 * 没有失败时它不是什么「正常 / 已连接」的状态装饰 —— 那种字已经在这个仓库里被
 * 明确否过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { answer, createFakeHost, loadClient } from './support/panel-harness.mjs'

const client = await loadClient()
const { createPanel, statusLine } = client

const A = '/review/a/surface.json'

test('放置失败时那一行点名原因；没有失败时它是空的', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  assert.equal(
    statusLine({ sessionId: 'conversation-A', problems: panel.problems(), note: '' }),
    '',
    '什么都没发生时，外壳不说话',
  )

  fake.failOpening('右栏没有可用的控制器')
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))

  const line = statusLine({ sessionId: 'conversation-A', problems: panel.problems(), note: '' })
  assert.match(line, /放置失败/)
  assert.match(line, /右栏没有可用的控制器/)
  assert.equal(line.includes('\n'), false, '一行就是一行')

  // A later tick succeeds: the reason goes away with the failure.
  fake.failOpening('')
  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.equal(
    statusLine({ sessionId: 'conversation-A', problems: panel.problems(), note: '' }),
    '',
    '恢复之后不留残字',
  )
})

test('轮询失败走同一条路：原因说给人听，下一次拿到清单就消失', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })

  panel.observe('conversation-A', { error: '连接不到宿主' })
  const line = statusLine({ sessionId: 'conversation-A', problems: panel.problems(), note: '' })
  assert.match(line, /轮询失败/)
  assert.match(line, /连接不到宿主/)

  panel.observe('conversation-A', answer([{ surface: A, revision: 1 }]))
  assert.equal(
    statusLine({ sessionId: 'conversation-A', problems: panel.problems(), note: '' }),
    '',
    '轮询恢复之后不留残字',
  )
})

test('别的对话的失败不写到这一行上；没有失败时状态回执照旧', () => {
  const fake = createFakeHost({ onScreen: 'conversation-A' })
  const panel = createPanel({ host: fake.host })
  panel.observe('conversation-B', { error: 'B 的连接断了' })

  assert.equal(
    statusLine({ sessionId: 'conversation-A', problems: panel.problems(), note: '' }),
    '',
    'A 的标签不该替 B 报错',
  )
  assert.equal(statusLine({ sessionId: 'conversation-A', problems: [], note: '已提交' }), '已提交')
})
