import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/* 帧必须跟着 `review_open` 的 revision 走，而不是只跟着 surface 路径。
 *
 * 症状（2026-10-16 真人反馈）：Agent 重新生成了**同一份** entry HTML 再 review_open，
 * 路径一字未变，于是 `surfaceStore.set` 早退、帧的 src 也不变 —— 浏览器不会重新取
 * `/api/review.page`，人盯着的还是修之前的旧文档（界面上一切正常，就是修了跟没修一样）。
 *
 * 这一半是 React 组件，仓库里没有客户端渲染的接缝，所以这里钉的是**源码契约**：
 * 三条承重线缺任何一条，症状都会回来。等有了客户端 harness 换成行为测试。
 */
const source = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

test('frame src is keyed by the revision, not only by the surface path', () => {
  const src = source.match(/api\/review\.page\?surface=\$\{[^}]*\}([^`]*)`/)
  assert.ok(src, 'frame src 模板必须还在')
  assert.match(src[1], /&r=\$\{/, 'frame src 必须带上 revision（`&r=`），否则同一路径的重新交接不会重载')
})

test('the surface store treats a revision-only change as a change', () => {
  assert.match(source, /revisions: new Map\(\)/, 'store 必须记得 revision')
  // 0.3.0: 键从「会话」变成「会话 + 面」，但早退判据仍然是 revision ——
  // 路径没变、revision 变了必须继续通知，否则同一路径的重新交接不会重载。
  assert.match(
    source,
    /if \(this\.revisions\.get\(key\) !== step\)/,
    '路径相同但 revision 变了时必须继续通知，不能早退',
  )
  assert.match(source, /if \(moved\) this\.notify\(\)/, '有变化就必须叫醒订阅者')
})

test('the poll hands the revision to the store', () => {
  assert.match(source, /surfaceStore\.setRevision\(sessionId, surface, revision, title\)/,
    '轮询拿到 revision 后必须交给 store，否则帧的 src 永远不变')
})
