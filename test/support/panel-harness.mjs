/**
 * 侧栏状态机的测试夹具。
 *
 * 状态机住在 `lib/client.js` 里 —— DSH 把这一份文件当成整块 bundle 加载，
 * 它不能 import 同目录的另一个文件；所以这里按 DSH 的方式加载它：先给一个
 * `__ModuleLoader__`，再从注册表里取出 factory。Node 里拿到的是和浏览器同一份
 * 实现，不另写一份测试专用版本。
 *
 * 宿主是假的：屏幕上是哪个对话、布局里有哪些标签、挂了哪些标签、开标签落到哪，
 * 全部由测试摆布；状态机只经由三个动作被驱动。
 */

export const KIND = 'review'

/** Load the real sidebar module the way DSH does, once per process. */
export async function loadClient() {
  if (globalThis.__clientModule !== undefined) return globalThis.__clientModule
  globalThis.__ModuleLoader__ = {
    load(registration) {
      globalThis.__reviewRegistration = registration
    },
  }
  await import('../../lib/client.js')
  globalThis.__clientModule = globalThis.__reviewRegistration.factory(() => ({ createElement() {} }))
  return globalThis.__clientModule
}

/** One `GET /api/review.current` answer. */
export function answer(entries, { pollMs } = {}) {
  return {
    ...(pollMs === undefined ? {} : { pollMs }),
    surfaces: entries.map((entry) => ({
      surface: entry.surface,
      revision: entry.revision ?? 1,
      changedSeq: entry.changedSeq ?? 0,
      title: entry.title ?? '',
    })),
  }
}

/**
 * A fake Host: one layout per conversation, one set of mounted tabs per
 * conversation, and a screen that shows exactly one conversation.
 */
export function createFakeHost({ onScreen = '' } = {}) {
  const layouts = new Map()
  const seats = new Map()
  const opened = []
  const reveals = []
  let screen = onScreen
  let probe = null
  let openFailure = ''

  function layoutOf(sessionId) {
    let layout = layouts.get(sessionId)
    if (layout === undefined) {
      layout = []
      layouts.set(sessionId, layout)
    }
    return layout
  }

  function seatOf(sessionId) {
    let seat = seats.get(sessionId)
    if (seat === undefined) {
      seat = { placer: undefined, surfaces: new Map() }
      seats.set(sessionId, seat)
    }
    return seat
  }

  const host = {
    onScreen() {
      return screen
    },
    reviewTabs(sessionId) {
      if (probe !== null) return probe(sessionId)
      return layoutOf(sessionId).map((entry) => ({ kind: entry.kind }))
    },
    mountedTabs(sessionId) {
      const seat = seats.get(sessionId)
      return {
        placer: seat?.placer,
        surfaces: new Set(seat === undefined ? [] : seat.surfaces.keys()),
        unbound: seat?.unbound ?? 0,
      }
    },
    reveal() {
      reveals.push(screen)
    },
    openTab(kind, options) {
      if (openFailure !== '') throw new Error(openFailure)
      // The global controller acts on the conversation on screen; recording the
      // screen here is what makes a wrong-conversation placement visible.
      opened.push({ via: 'screen', sessionId: screen, kind, options })
      layoutOf(screen).push({ kind, params: options?.params })
    },
  }

  return {
    host,
    opened,
    reveals,
    layouts,
    /** Pretend the human switched conversations. */
    show(sessionId) {
      screen = sessionId
    },
    /** A mounted tab of `sessionId` that can place tabs for that conversation. */
    mount(sessionId, surface, { placer = true, unbound = 0 } = {}) {
      const seat = seatOf(sessionId)
      if (surface !== '') seat.surfaces.set(surface, (seat.surfaces.get(surface) ?? 0) + 1)
      if (unbound > 0) seat.unbound = (seat.unbound ?? 0) + unbound
      if (placer && seat.placer === undefined) {
        seat.placer = (kind, options) => {
          if (openFailure !== '') throw new Error(openFailure)
          opened.push({ via: 'tab', sessionId, kind, options })
          layoutOf(sessionId).push({ kind, params: options?.params })
        }
      }
      if (surface !== '' && !layoutOf(sessionId).some((entry) => entry.params?.surface === surface)) {
        layoutOf(sessionId).push({ kind: KIND, params: { surface, sessionId } })
      }
      return () => {
        const held = seat.surfaces.get(surface) ?? 0
        if (held <= 1) seat.surfaces.delete(surface)
        else seat.surfaces.set(surface, held - 1)
        if (unbound > 0) seat.unbound = Math.max(0, (seat.unbound ?? 0) - unbound)
        if (seat.surfaces.size === 0 && (seat.unbound ?? 0) === 0) seat.placer = undefined
      }
    },
    /** The human closed one review tab of `sessionId`. */
    close(sessionId, surface) {
      const seat = seats.get(sessionId)
      if (seat !== undefined && surface !== undefined) {
        const held = seat.surfaces.get(surface) ?? 0
        if (held <= 1) seat.surfaces.delete(surface)
        else seat.surfaces.set(surface, held - 1)
      }
      const layout = layoutOf(sessionId)
      const index = layout.findIndex((entry) => surface === undefined || entry.params?.surface === surface)
      if (index !== -1) layout.splice(index, 1)
    },
    /** Replace the layout probe for the next observations; `null` restores it. */
    probeWith(next) {
      probe = next
    },
    /** Make every placement attempt throw this message; `''` restores it. */
    failOpening(reason) {
      openFailure = reason
    },
  }
}
