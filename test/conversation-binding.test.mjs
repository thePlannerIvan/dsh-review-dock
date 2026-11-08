/**
 * Regression: a review tab must be born in ITS OWN conversation's sidebar.
 *
 * Reported bug: a PPT review opened by the agent in conversation A appeared in
 * the sidebar of conversation B because the panel's poller used
 * `ctx.sidebarRight.openTab`, and that controller always acts on whatever
 * conversation is ON SCREEN. A hidden conversation's review therefore wrote into
 * the visible conversation's layout (and revealed its column).
 *
 * The fix has three load-bearing parts, all pinned here:
 *
 *   1. placement goes through a tab's own `tab.actions.openTab` (DSH documents
 *      that it targets the session the tab is in, even after a switch), or the
 *      on-screen controller ONLY when the surface's conversation is the on-screen
 *      one;
 *   2. a surface that cannot be placed yet is parked and placed when its
 *      conversation becomes placeable — never into someone else's sidebar;
 *   3. a tab that names a different conversation than the one whose layout holds
 *      it (written by an older build, or restored from such a layout) refuses to
 *      render instead of showing the wrong conversation's review.
 *
 * The repository has no client render harness, so these are source contracts in
 * the same style as the other client tests.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

test('placement targets the surface’s own conversation, not the on-screen one', () => {
  assert.match(source, /function registerTabPlacer\(sessionId, place\)/, '必须为每个对话登记自己的放置器')
  assert.match(
    source,
    /return registerTabPlacer\(sessionId, \(kind, options\) => tabActions\.openTab\(kind, options\)\)/,
    '放置必须走 tab.actions.openTab：它按标签所在对话落位，切走对话后仍落在原对话',
  )
  assert.match(source, /function placerOf\(sessionId\)/, '轮询必须能取到该对话自己的放置器')
  assert.match(
    source,
    /if \(place === undefined && !onScreen\) return false/,
    '没有本对话的放置器、且本对话不在屏幕上时，必须拒绝放置（宁可不弹，也不弹错对话）',
  )
  assert.doesNotMatch(
    source,
    /host\.sidebarRight\.openTab\(KIND, \{ params: \{ surface, sessionId \} \}\)/,
    '旧写法：全局 openTab 作用在屏幕上的对话，正是这个 bug',
  )
})

test('the column is only revealed for the conversation that is on screen', () => {
  assert.match(source, /function onScreenSession\(host\)[\s\S]{0,300}?mounted\?\.getSnapshot/, '必须读侧栏的「屏幕上的对话」')
  assert.match(
    source,
    /if \(onScreen\) \{[\s\S]{0,220}?openRightbar/,
    '展开右栏必须按「这个面自己的对话是否在屏幕上」来闸门',
  )
})

test('a surface that cannot be placed yet is parked, then placed later', () => {
  assert.match(source, /state\.unplaced\.set\(surface, revision\)/, '放不进去的面必须记着，不能丢')
  assert.match(
    source,
    /for \(const \[surface, revision\] of \[\.\.\.state\.unplaced\]\)/,
    '后续轮询必须重试停着的面（用户切回该对话后就该出现）',
  )
  assert.match(source, /function reviewTabCount\(host, sessionId\)/, '关掉标签后必须能发现布局里的审阅标签变少了')
  assert.match(source, /state\.placed\.clear\(\)/, '人关掉标签后要忘掉「已放置」，否则 Agent 再开时补不回来')
})

test('an already-placed surface re-reveals the column instead of opening a second tab', () => {
  assert.match(
    source,
    /if \(state\.placed\.has\(surface\)\) \{[\s\S]{0,700}?openRightbar/,
    '标签已经存在但帧没挂载（侧栏收起/对话未绘制）时，revision 变化应当展开右栏，而不是再开一个标签',
  )
})

test('a misfiled tab refuses to render another conversation’s review', () => {
  assert.match(
    source,
    /const misplaced = namedSession !== '' && tabSession !== '' && namedSession !== tabSession/,
    '必须能识别「标签所在对话 ≠ 标签声明的对话」',
  )
  assert.match(source, /这个审阅标签属于另一个对话，不在这里显示/, '错放的标签必须说出来，而不是继续显示别人的审阅页')
})
