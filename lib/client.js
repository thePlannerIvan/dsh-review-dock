/**
 * Client half of dsh-review-dock.
 *
 * One native right-Sidebar tab. Its body is a `sandbox="allow-scripts allow-same-origin"`
 * iframe showing whatever page the surface names, plus the bridge that page
 * talks to. The page is same-origin with DSH so an embedded player (e.g. the
 * HyperFrames engineering preview) can run; that also means a review page is
 * trusted code. There is no review UI here on purpose: what is reviewed, how it
 * is displayed, and what a decision means all belong to the page itself.
 *
 *   parent → frame   `contentWindow.postMessage(msg, '*')`
 *                    (`'null'` can never be a matching targetOrigin for an
 *                    opaque origin, so `'*'` is the only option)
 *   frame → parent   `event.source === frame.contentWindow`, then the frame's own
 *                    nonce echoed on every later message (`event.origin` is the
 *                    string `"null"` for every opaque document, so it
 *                    authenticates nothing)
 *
 * The parent is the one that talks to the Host: it is same-origin and carries
 * the Session cookie. A `fetch` from inside the opaque frame would be a
 * cross-origin request with no cookie — measured as `Sec-Fetch-Site: cross-site`
 * and refused 403 before authentication.
 */

globalThis.__ModuleLoader__?.load({
  id: 'dsh-review-dock',
  factory: (require) => {
    const React = require('react')

    /** Registry id and tab kind. Surfaces are scoped to the active DSH session. */
    const ID = 'dsh-review-dock'
    const KIND = 'review'

    const C = React.createElement
    const FONT = { fontSize: 12, lineHeight: 1.45, color: 'var(--dsw-alias-label-primary)' }
    const MUTED = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }

    /** How often a conversation asks the Host which surfaces it has to show. */
    const CURRENT_POLL_MS = 2000

    /**
     * One review surface = one tab, so the panel keeps three small external
     * stores keyed by (conversation, surface):
     *
     *   revision — `review_open` on a surface already on screen steps this, and the
     *              frame's `src` carries it, so a REGENERATED page really reloads
     *              (a path that never changes was the 0.2.x bug behind "修了跟没修
     *              一样").
     *   changed  — the Host saw the watched files' metadata move. One step = one
     *              `review/changed` poke into that one page, not all of them.
     *   title    — what the tab chip says, so several open reviews are telling
     *              apart at a glance instead of "审阅 / 审阅 / 审阅".
     *
     * Nothing here is global: another conversation's surface is a different key
     * and can never repoint or poke this tab.
     */
    const keyOf = (sessionId, surface) => `${sessionId}\u0000${surface}`

    const surfaceStore = {
      revisions: new Map(),
      titles: new Map(),
      changed: new Map(),
      latestBy: new Map(),
      listeners: new Set(),
      notify() {
        for (const listener of Array.from(this.listeners)) listener()
      },
      revision(sessionId, surface) { return this.revisions.get(keyOf(sessionId, surface)) || 0 },
      title(sessionId, surface) { return this.titles.get(keyOf(sessionId, surface)) || '' },
      changedSeq(sessionId, surface) { return this.changed.get(keyOf(sessionId, surface)) || 0 },
      latest(sessionId) { return this.latestBy.get(sessionId) || '' },
      setLatest(sessionId, surface) {
        if (sessionId && surface) this.latestBy.set(sessionId, surface)
      },
      setRevision(sessionId, surface, revision, title) {
        if (!sessionId || !surface) return
        const key = keyOf(sessionId, surface)
        const step = Number(revision) || 0
        let moved = false
        if (this.revisions.get(key) !== step) {
          this.revisions.set(key, step)
          moved = true
        }
        if (typeof title === 'string' && title !== '' && this.titles.get(key) !== title) {
          this.titles.set(key, title)
          moved = true
        }
        // Same path, new revision still has to notify: re-opening the SAME entry
        // HTML is exactly that case, and the frame must re-key on it.
        if (moved) this.notify()
      },
      bumpChanged(sessionId, surface) {
        if (!sessionId || !surface) return
        const key = keyOf(sessionId, surface)
        this.changed.set(key, (this.changed.get(key) || 0) + 1)
        this.notify()
      },
    }

    /** Re-render on any store change; `read` decides what this component cares about. */
    function useStoreValue(read) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((n) => n + 1)
        surfaceStore.listeners.add(listener)
        return () => surfaceStore.listeners.delete(listener)
      }, [])
      return read()
    }

    /** 帧的 src 跟着 revision 走，Agent 每次交接都会真的重新取一次页面。 */
    function useRevision(sessionId, surface) {
      return useStoreValue(() => surfaceStore.revision(sessionId, surface))
    }

    /** 标签名跟着面走：几个面同时开着时，「审阅 / 审阅 / 审阅」等于没有标签。 */
    function useSurfaceTitle(sessionId, surface) {
      return useStoreValue(() => surfaceStore.title(sessionId, surface))
    }

    /** 只有这一个面的戳会让这一帧 re-key，别的面的变化不碰它。 */
    function useChanged(sessionId, surface) {
      return useStoreValue(() => surfaceStore.changedSeq(sessionId, surface))
    }

    /** 人手开的一个空标签（没有 params）用它接上本对话最新的一份面。 */
    function useLatestSurface(sessionId) {
      return useStoreValue(() => surfaceStore.latest(sessionId))
    }

    /**
     * One poll per conversation, not one per tab.
     *
     * The poll used to live inside the frame, which was right while a
     * conversation owned exactly one tab. With one tab per surface, N frames
     * would each poll and each call `openTab`, opening every surface N times.
     *
     * This state outlives the last unmount on purpose: `seen` remembers which
     * revisions have already been shown, so a tab the human closed stays closed
     * until the Agent opens that surface again — which steps its revision.
     */
    const sessionStates = new Map()

    function sessionState(sessionId) {
      let state = sessionStates.get(sessionId)
      if (state === undefined) {
        state = { timer: null, busy: false, seen: new Map(), claimed: new Map(), unbound: 0 }
        sessionStates.set(sessionId, state)
      }
      return state
    }

    /**
     * A tab that is open but has no surface of its own yet. The poller must NOT
     * open a tab for a surface while one of these exists: the hand-opened tab
     * adopts it instead, and opening a second tab for it would show the same
     * review twice (once there, once here).
     */
    function registerUnbound(sessionId) {
      const state = sessionState(sessionId)
      state.unbound += 1
      return () => {
        state.unbound = Math.max(0, state.unbound - 1)
      }
    }

    /** Count this tab as showing `surface`; the returned function undoes it. */
    function claimSurface(sessionId, surface) {
      const state = sessionState(sessionId)
      state.claimed.set(surface, (state.claimed.get(surface) || 0) + 1)
      return () => {
        const count = state.claimed.get(surface) || 0
        if (count <= 1) state.claimed.delete(surface)
        else state.claimed.set(surface, count - 1)
      }
    }

    function openSurface(host, sessionId, surface) {
      // `host` is the plugin ctx, passed down because these helpers sit outside
      // `apply()` and must not capture a ctx the factory never had.
      if (!sessionId || !surface) return
      let tries = 0
      const attempt = () => {
        tries += 1
        // Reveal first: without the column open the tab exists but the frame is
        // 0×0 and the human sees nothing (measured, 0.2.0).
        try {
          host.get('layout')?.openRightbar?.(true, false)
        } catch {
          /* no seat to act on yet */
        }
        try {
          // `multiple: true` on the tab type: every call is its own tab, with
          // its own navigation params, its own frame and its own state.
          host.sidebarRight.openTab(KIND, { params: { surface, sessionId } })
          return
        } catch {
          /* the seat is not bound yet */
        }
        if (tries < 40) window.setTimeout(attempt, 150)
      }
      window.setTimeout(attempt, 150)
    }

    function tick(host, sessionId) {
      const state = sessionState(sessionId)
      if (state.busy) return
      state.busy = true
      const url = new URL('api/review.current', window.location.href)
      url.searchParams.set('sessionId', sessionId)
      fetch(url, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (value === null) return
          const list = Array.isArray(value?.surfaces) ? value.surfaces : []
          for (const entry of list) {
            const surface = String(entry?.surface ?? '')
            if (surface === '') continue
            const revision = Number(entry?.revision ?? 0)
            const changedSeq = Number(entry?.changedSeq ?? 0)
            const title = typeof entry?.title === 'string' ? entry.title : ''
            const seen = state.seen.get(surface)
            if (seen === undefined || seen.revision !== revision) {
              // New surface, or the same one re-opened: step the frame's key.
              state.seen.set(surface, { revision, changed: changedSeq })
              surfaceStore.setRevision(sessionId, surface, revision, title)
              surfaceStore.setLatest(sessionId, surface)
              // A closed tab is NOT reopened by a plain poll — only a revision
              // step brings it back, so the human's close wins until the Agent
              // really opens that surface again.
              if ((state.claimed.get(surface) || 0) === 0 && state.unbound === 0) {
                openSurface(host, sessionId, surface)
              }
            } else if (changedSeq > seen.changed) {
              seen.changed = changedSeq
              surfaceStore.bumpChanged(sessionId, surface)
            }
          }
        })
        .catch(() => {
          /* the Host may be restarting; the next tick retries */
        })
        .finally(() => {
          state.busy = false
        })
    }

    function ensurePolling(host, sessionId) {
      const state = sessionState(sessionId)
      if (state.timer !== null) return
      tick(host, sessionId)
      state.timer = window.setInterval(() => tick(host, sessionId), CURRENT_POLL_MS)
    }

    return {
      // `layout` is a real dependency, not a nicety: without it declared, the
      // session seat is not bound when the panel tries to reveal the column, the
      // reveal is a silent no-op, and the tab opens inside a collapsed column
      // (measured: frame 0×0, inert pane, nothing on screen).
      inject: ['layout', 'slots', 'sidebarRightTabs', 'sidebarRight'],

      apply(ctx) {
        /**
         * The surface this tab shows: whatever the opener passed, else the
         * remembered one. `remembered` is a parameter rather than a hook call in
         * here, because a hook that only runs on one branch of an if is exactly
         * the kind of thing that breaks the first time the branch flips.
         */
        function tabParams(props) {
          try {
            return props?.useTabInfo?.()?.tab?.navigation?.params || {}
          } catch {
            /* no tab info available in this seat */
          }
          return {}
        }

        function sessionFor(props) {
          const params = tabParams(props)
          return String(props?.sessionId ?? params.sessionId ?? props?.session?.id ?? '').trim()
        }

        function surfaceFor(props, remembered) {
          const fromParams = tabParams(props).surface
          if (typeof fromParams === 'string' && fromParams !== '') return fromParams
          return remembered
        }

        /**
         * A tab the human opened by hand (the guide's 「审阅」) has no surface in
         * its params. It adopts this conversation's NEWEST surface once, then
         * stays there.
         *
         * Following "newest" for ever would be wrong twice over: the tab would
         * jump to a different review every time the Agent opens one, and it would
         * show the same page as the tab the poller just opened for that surface.
         * Keyed by tab id so the body and the tab chip always agree.
         */
        const adoptedByTab = new Map()

        function tabIdOf(props) {
          try {
            return String(props?.useTabInfo?.()?.tab?.id ?? '')
          } catch {
            return ''
          }
        }

        function surfaceOfTab(props, latest) {
          const own = surfaceFor(props, '')
          if (own !== '') return own
          const tabId = tabIdOf(props)
          if (tabId === '') return ''
          const held = adoptedByTab.get(tabId)
          if (held !== undefined) return held
          if (latest === '') return ''
          adoptedByTab.set(tabId, latest)
          return latest
        }

        function ReviewFrame(props) {
          // Each tab carries its OWN surface in its navigation params. There is no
          // shared "surface on screen" any more: that shared value was what made a
          // second `review_open` take the first review away from the human.
          const sessionId = sessionFor(props)
          const latest = useLatestSurface(sessionId)
          // Own params win; a hand-opened tab pins the newest surface once.
          const surface = surfaceOfTab(props, latest)
          const surfaceRevision = useRevision(sessionId, surface)
          const changedSeq = useChanged(sessionId, surface)
          const postRef = React.useRef(null)
          const frameRef = React.useRef(null)
          const [note, setNote] = React.useState('')

          React.useEffect(() => {
            const frame = frameRef.current
            if (frame === null || surface === '') return () => {}

            const endpoint = (name) => new URL(`api/${name}`, window.location.href).href
            let childNonce = ''
            let live = true

            const post = (payload) => {
              const child = frame.contentWindow
              if (child === null || childNonce === '') return
              child.postMessage(Object.assign({ __review: true, nonce: childNonce }, payload), '*')
            }
            const settle = (id, ok, value, error) => {
              if (!ok) post({ type: 'result', id, ok: false, error: String(error) })
              else post({ type: 'result', id, ok: true, value })
            }
            const describe = (error) => String(error?.message ?? error)

            /**
             * Fetch on the frame's behalf and hand back raw bytes, never base64.
             * `asset` and `read` share this: same route, same realpath check, same
             * cookie. They differ only in what the FRAME does next — `asset` turns
             * the bytes into a blob URL, `read`/`readText` decode them.
             */
            const loadBytes = async (payload) => {
              const query = new URLSearchParams({
                surface,
                rel: String(payload?.rel ?? ''),
              })
              if (payload?.v !== undefined && payload.v !== null && payload.v !== '') {
                query.set('v', String(payload.v))
              }
              const response = await fetch(`${endpoint('review.asset')}?${query.toString()}`, {
                cache: 'no-store',
              })
              if (!response.ok) {
                if (response.status === 404 && payload?.optional === true) {
                  return { bytes: new ArrayBuffer(0), type: 'text/plain', missing: true }
                }
                throw new Error(`资产未找到：${String(payload?.rel ?? '')}（HTTP ${response.status}）`)
              }
              const bytes = await response.arrayBuffer()
              return {
                bytes,
                type: response.headers.get('content-type') ?? 'application/octet-stream',
              }
            }

            const handleCall = async (data) => {
              const method = String(data.method ?? '')
              const payload = data.payload ?? {}
              try {
                if (method === 'asset' || method === 'read') {
                  settle(data.id, true, await loadBytes(payload))
                  return
                }
                if (method === 'command') {
                  const response = await fetch(endpoint('review.command'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ surface, payload }),
                  })
                  const value = await response.json()
                  if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
                  // A backend rejection is a result, not a lost bridge message.
                  settle(data.id, true, value)
                  return
                }
                if (method === 'write') {
                  const response = await fetch(endpoint('review.write'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // The Host keys the wake identity on this submission, so the
                    // write has to say which session it belongs to.
                    body: JSON.stringify({ surface, sessionId, payload: payload ?? null }),
                  })
                  const value = await response.json().catch(() => null)
                  if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
                  settle(data.id, true, value)
                  return
                }
                if (method === 'draft') {
                  // The UNSENT draft. Same relay as `write`, a different file and a
                  // different meaning: no session, no wake identity — saving what you
                  // are typing must never look like "tell the model to start".
                  const response = await fetch(endpoint('review.draft'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ surface, payload: payload ?? null }),
                  })
                  const value = await response.json().catch(() => null)
                  if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
                  settle(data.id, true, value)
                  return
                }
                if (method === 'wake') {
                  const response = await fetch(endpoint('review.wake'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      surface,
                      unit: String(payload?.unit ?? ''),
                      // The page may override the whole sentence (a batch submit
                      // is not "只改这一页"); the surface template is the fallback.
                      text: String(payload?.text ?? ''),
                      sessionId,
                    }),
                  })
                  const value = await response.json().catch(() => null)
                  // `duplicate` (409) is NOT a failure, and must not be shown as one.
                  // The write landed, and an earlier call already delivered exactly
                  // this submission — the notification is in place. Reporting
                  // "保存失败" here would be a false negative, the mirror image of
                  // the false green the Host-side check was fixed to stop telling.
                  // The page is told what actually happened, in words.
                  if (response.status === 409 && value?.state === 'duplicate') {
                    setNote('已写入；本次没有新增通知（同一次提交之前已送达）')
                    settle(data.id, true, {
                      ...value,
                      ok: true,
                      duplicate: true,
                      notice: '已写入；本次没有新增通知（同一次提交之前已送达）',
                    })
                    return
                  }
                  if (!response.ok || value?.ok === false) {
                    throw new Error(value?.error ?? `HTTP ${response.status}`)
                  }
                  setNote(value?.verified?.equalsWakeText ? '已唤醒模型（已在会话日志里核对）' : '已唤醒模型')
                  settle(data.id, true, value)
                  return
                }
                if (method === 'upload') {
                  // The bridge hands over `{ rel, name, bytes }` as an ArrayBuffer
                  // (see review-bridge.js: `file.arrayBuffer()`), so the bytes go
                  // to the Host as the raw body — never base64. `rel` is relative
                  // to the surface's dir; the Host re-checks containment and never
                  // trusts it. The reply is the same shape the no-plugin host
                  // returns, so a page cannot tell the two hosts apart.
                  const rel = String(payload?.rel ?? '')
                  const bytes = payload?.bytes
                  if (!(bytes instanceof ArrayBuffer)) {
                    throw new Error('upload 需要 ArrayBuffer 字节（桥会先做 file.arrayBuffer()）')
                  }
                  const query = new URLSearchParams({ surface, rel })
                  const response = await fetch(`${endpoint('review.upload')}?${query}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: bytes,
                  })
                  const value = await response.json().catch(() => null)
                  if (!response.ok || value?.ok === false) {
                    throw new Error(value?.error ?? `HTTP ${response.status}`)
                  }
                  setNote(`图片已上传（${Number(value?.bytes ?? bytes.byteLength)} 字节 → ${rel}）`)
                  settle(data.id, true, value)
                  return
                }
                throw new Error(`未知的桥方法：${method}`)
              } catch (error) {
                setNote(`${method} 失败：${describe(error)}`)
                settle(data.id, false, undefined, describe(error))
              }
            }

            const onMessage = (event) => {
              // The only reliable check available to the parent.
              if (event.source !== frame.contentWindow) return
              const data = event.data
              if (data === null || typeof data !== 'object' || data.__review !== true) return
              if (data.type === 'hello') {
                childNonce = String(data.nonce ?? '')
                if (childNonce === '') return
                // `init` carries the Surface's own declarations; the Host adds
                // nothing of its own to them.
                fetch(`${endpoint('review.surface')}?surface=${encodeURIComponent(surface)}`, {
                  cache: 'no-store',
                })
                  .then((response) => response.json())
                  .then((value) => {
                    if (!live) return
                    const info = value?.ok === true ? value.surface : null
                    post({
                      type: 'init',
                      assetBase: new URL('.', window.location.href).href,
                      surface: info === null ? null : { id: info.id, title: info.title },
                      capabilities: Array.isArray(info?.capabilities) ? info.capabilities : [],
                      host: { name: 'dsh-review-dock', version: '0.3.0' },
                    })
                  })
                  .catch((error) => {
                    if (!live) return
                    post({
                      type: 'init',
                      assetBase: new URL('.', window.location.href).href,
                      surface: null,
                      capabilities: [],
                      host: null,
                    })
                    setNote(`读 surface 元信息失败：${describe(error)}`)
                  })
                return
              }
              if (childNonce === '' || data.nonce !== childNonce) return
              if (data.type === 'call') handleCall(data)
            }

            postRef.current = post
            window.addEventListener('message', onMessage)
            return () => {
              live = false
              postRef.current = null
              window.removeEventListener('message', onMessage)
            }
          }, [surface, sessionId])

          // One poller per conversation, shared by every tab of it (see
          // `ensurePolling`). It is deliberately not torn down on unmount: the
          // "already shown" revisions must survive a tab closing.
          React.useEffect(() => {
            if (sessionId === '') return
            ensurePolling(ctx, sessionId)
          }, [sessionId])

          // This tab owns one surface, and says so: while it is mounted the poller
          // must not open a second tab for the same surface, and when the human
          // closes it the surface stays closed until the Agent re-opens it.
          React.useEffect(() => {
            if (sessionId === '' || surface === '') return
            return claimSurface(sessionId, surface)
          }, [sessionId, surface])

          // Open but unclaimed: the poller parks the next surface here instead of
          // opening another tab for it.
          React.useEffect(() => {
            if (sessionId === '' || surface !== '') return
            return registerUnbound(sessionId)
          }, [sessionId, surface])

          // One poke per step. No payload: the Host only knows metadata moved, and
          // the page is the only side that can tell what that means.
          React.useEffect(() => {
            if (changedSeq === 0) return
            const post = postRef.current
            if (post !== null) post({ type: 'review/changed' })
          }, [changedSeq])

          if (surface === '') {
            return C(
              'div',
              { style: Object.assign({}, FONT, MUTED, { padding: 14 }) },
              '这个标签还没有接上审阅页。本对话里一有 review_open，它就会自己出现在这里。',

            )
          }

          // `r` 不参与服务端路由，只用来换 URL：revision 一动，帧就是一次真正的重新加载。
          const src = new URL(`api/review.page?surface=${encodeURIComponent(surface)}&r=${surfaceRevision}`, window.location.href).href
          return C(
            'div',
            {
              style: {
                position: 'relative',
                flex: 1,
                minHeight: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
              },
            },
            C('iframe', {
              ref: frameRef,
              key: `${sessionId}:${surface}`,
              src,
              // Same-origin is required by embedded players that create their own
              // same-origin iframe (HyperFrames player). This makes the review page
              // trusted code: it can reach this application's DOM, storage, and API.
              sandbox: 'allow-scripts allow-same-origin',
              title: 'review surface',
              style: { flex: 1, minHeight: 0, width: '100%', border: '0', background: '#fff' },
            }),
            note === ''
              ? null
              : C('div', { style: Object.assign({}, MUTED, { flex: 'none', padding: '4px 8px' }) }, note),
          )
        }

        /**
         * The tab chip says WHICH review it is. With one tab per surface, three
         * chips all reading 「审阅」 is the same as having no chip at all.
         */
        function ReviewTitle(props) {
          const sessionId = sessionFor(props)
          const latest = useLatestSurface(sessionId)
          const title = useSurfaceTitle(sessionId, surfaceOfTab(props, latest))
          return C('span', { style: { whiteSpace: 'nowrap' } }, title !== '' ? title : '审阅')
        }

        ctx.effect(() => {
          const disposeType = ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            title: () => '审阅',
            // ONE TAB PER SURFACE. Without this every `openTab` of this kind
            // resolves to the same content address and the second review replaces
            // the first; `multiple: true` gives each open its own address, its own
            // navigation params and its own frame, which is the whole point.
            multiple: true,
            // Without this the body is unmounted the moment the tab is not
            // visible, so a half-written review inside the frame dies the first
            // time the human glances at the terminal.
            keepMounted: true,
            guide: [
              {
                id: 'review',
                order: 30,
                title: () => '审阅',
                description: () => '承载产出方自己的审阅页（review-surface.json）',
              },
            ],
          })
          return () => disposeType?.()
        }, 'dsh-review-dock: tab type')

        ctx.effect(() => {
          return ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, ReviewFrame),
          )
        }, 'dsh-review-dock: tab body')

        ctx.effect(() => {
          return ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, ReviewTitle),
          )
        }, 'dsh-review-dock: tab title')

      },
    }
  },
})
