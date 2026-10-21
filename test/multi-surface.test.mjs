/**
 * Regression for 0.3.0: a conversation owns SEVERAL review surfaces.
 *
 * Two things had to change together and both are load-bearing:
 *
 *   1. `lib/client.js` must key the frame, the poke and the tab chip on the
 *      SURFACE, not on the conversation. 0.2.x had one "surface on screen" per
 *      session, so a second `review_open` took the first review away from the
 *      human mid-review.
 *   2. The tab type must be declared `multiple: true`, otherwise every open of
 *      this kind resolves to the same content address and the second review
 *      lands on top of the first.
 *
 * The repository has no client render harness, so these are source contracts —
 * the same style as client-frame-reload.test.mjs. Each assertion names the
 * symptom that comes back when it is dropped.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

test('the tab type declares multiple instances', () => {
  assert.match(
    source,
    /sidebarRightTabs\.register\(\{[\s\S]{0,400}?multiple: true/,
    '不声明 multiple: true，第二次 review_open 会顶掉第一次（多个标签会抢同一个内容地址）',
  )
})

test('the frame takes its surface from its own tab params', () => {
  assert.match(source, /const own = surfaceFor\(props, ''\)/, '帧必须读自己这个标签的 params.surface')
  assert.match(source, /const surface = surfaceOfTab\(props, latest\)/, '帧的面只能来自它自己这个标签')
  assert.match(
    source,
    /adoptedByTab\.set\(tabId, latest\)/,
    '人手开的空标签只认领一次最新的面；否则它会跟着最新一份面乱跳，还会和轮询为那份面开的标签重复',
  )
})

test('the poke is keyed by surface, not by session', () => {
  assert.match(source, /bumpChanged\(sessionId, surface\)/, '戳必须落到某一个面，否则一处变、整排标签都重画')
  assert.match(source, /changedSeq\(sessionId, surface\)/, '帧只订阅自己这一份面的戳')
})

test('only one poller runs per conversation', () => {
  assert.match(source, /function ensurePolling\(host, sessionId\)/, '必须有一个按对话的轮询拥有者')
  assert.match(source, /if \(state\.timer !== null\) return/, '第二个标签不能再起一个轮询（会重复开标签）')
  assert.doesNotMatch(
    source,
    /setInterval\(tick, CURRENT_POLL_MS\)[\s\S]{0,400}?window\.clearInterval\(timer\)/,
    '轮询不能在帧卸载时拆掉：已显示过的 revision 必须留着，否则人一关标签它就自己开回来',
  )
})

test('a closed tab is not reopened by a plain poll', () => {
  assert.match(
    source,
    /if \(\(state\.claimed\.get\(surface\) \|\| 0\) === 0 && state\.unbound === 0\)/,
    '只有 revision 变了才补开；人手动关掉的标签必须保持关闭',
  )
})

test('an empty hand-opened tab is used before a new tab is opened', () => {
  assert.match(source, /function registerUnbound\(sessionId\)/, '空标签必须登记，否则轮询会为同一份面再开一个标签')
  assert.match(source, /state\.unbound === 0/, '有空标签时轮询不得再开新标签（同一份面会显示两次）')
})

test('the tab chip says which surface it is', () => {
  assert.match(source, /function ReviewTitle\(props\)/, '标题必须知道是哪一个标签')
  assert.match(source, /title !== '' \? title : '审阅'/, '拿不到面名时才退回「审阅」')
})
