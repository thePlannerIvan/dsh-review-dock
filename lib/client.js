/**
 * Client half of dsh-review-dock.
 *
 * One native right-Sidebar tab. Its body is an opaque `sandbox="allow-scripts"`
 * iframe showing whatever page the surface names, plus the bridge that page
 * talks to. There is no review UI here on purpose: what is reviewed, how it is
 * displayed, and what a decision means all belong to the page itself.
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

    /** Registry id, tab kind, and the key the last surface is remembered under. */
    const ID = 'dsh-review-dock'
    const KIND = 'review'
    const SURFACE_KEY = 'dsh-review-dock:surface'

    const C = React.createElement
    const FONT = { fontSize: 12, lineHeight: 1.45, color: 'var(--dsw-alias-label-primary)' }
    const MUTED = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }

    /** How often the panel asks the Host whether a different surface was opened. */
    const CURRENT_POLL_MS = 2000

    /**
     * The surface on screen, as a tiny external store: `review_open` can repoint
     * the tab while it is already open, and the frame must re-key when it does.
     */
    const surfaceStore = {
      value: '',
      listeners: new Set(),
      set(next) {
        if (this.value === next) return
        this.value = next
        try {
          window.localStorage.setItem(SURFACE_KEY, next)
        } catch {
          /* private mode */
        }
        for (const listener of Array.from(this.listeners)) listener()
      },
    }
    try {
      surfaceStore.value = window.localStorage.getItem(SURFACE_KEY) || ''
    } catch {
      /* private mode */
    }

    /**
     * "Something the surface watches moved." A bare counter: the Host sends no
     * payload because it does not know what changed, and the page decides what
     * to re-read. Steps are delivered to the frame as one `review/changed`.
     */
    const changedStore = {
      seq: 0,
      listeners: new Set(),
      bump() {
        this.seq += 1
        for (const listener of Array.from(this.listeners)) listener(this.seq)
      },
    }

    function useChanged() {
      const [seq, setSeq] = React.useState(changedStore.seq)
      React.useEffect(() => {
        const listener = (next) => setSeq(next)
        changedStore.listeners.add(listener)
        return () => changedStore.listeners.delete(listener)
      }, [])
      return seq
    }

    function useSurface() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((n) => n + 1)
        surfaceStore.listeners.add(listener)
        return () => surfaceStore.listeners.delete(listener)
      }, [])
      return surfaceStore.value
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
        function surfaceFor(props, remembered) {
          try {
            const params = props?.useTabInfo?.()?.tab?.navigation?.params
            const fromParams = params?.surface
            if (typeof fromParams === 'string' && fromParams !== '') return fromParams
          } catch {
            /* no tab info available in this seat */
          }
          return remembered
        }

        /**
         * Reveal the right column and claim the tab.
         *
         * Both steps live INSIDE the retry on purpose. The controller needs the
         * session seat to be bound, and at plugin-activation time it is not — a
         * reveal attempted then is silently a no-op, which leaves a live frame
         * sitting in a collapsed column (measured: the tab opened, the frame
         * stayed 0×0, the human saw nothing). Retrying the pair costs nothing
         * because `openRightbar` on an open column is a no-op too.
         */
        function openPanel() {
          let tries = 0
          const attempt = () => {
            tries += 1
            try {
              ctx.get('layout')?.openRightbar?.(true, false)
            } catch {
              /* no seat to act on yet */
            }
            try {
              ctx.sidebarRight.openTab(KIND, { params: { surface: surfaceStore.value } })
              return
            } catch {
              /* not bound yet */
            }
            if (tries < 40) window.setTimeout(attempt, 150)
            if (tries < 40) window.setTimeout(attempt, 150)
          }
          window.setTimeout(attempt, 150)
        }

        function ReviewFrame(props) {
          // Subscribed unconditionally: this is also how `review_open` repoints an
          // already-open tab at a different surface.
          const remembered = useSurface()
          const surface = surfaceFor(props, remembered)
          const changedSeq = useChanged()
          const postRef = React.useRef(null)
          const sessionId = String(props?.sessionId ?? '')
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
              if (!response.ok) throw new Error(`资产取回失败 HTTP ${response.status}`)
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
                  // Capability is passed through so the page can plan for it, but
                  // the write side is not built yet; say so instead of half-doing it.
                  throw new Error('asset-upload 能力尚未实现（B8.4b）')
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
                      host: { name: 'dsh-review-dock', version: '0.2.0' },
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
              '这个审阅页还没有绑定 surface。用 review_open 指定一个 review-surface.json。',
            )
          }

          const src = new URL(`api/review.page?surface=${encodeURIComponent(surface)}`, window.location.href).href
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
              key: surface,
              src,
              // No allow-same-origin: the Skill page gets an opaque origin and
              // cannot reach this application's DOM, storage, or API.
              sandbox: 'allow-scripts',
              title: 'review surface',
              style: { flex: 1, minHeight: 0, width: '100%', border: '0', background: '#fff' },
            }),
            note === ''
              ? null
              : C('div', { style: Object.assign({}, MUTED, { flex: 'none', padding: '4px 8px' }) }, note),
          )
        }

        function ReviewTitle() {
          const surface = useSurface()
          const name = surface === '' ? '' : surface.split('/').slice(-2)[0] || ''
          return C('span', { style: { whiteSpace: 'nowrap' } }, name === '' ? '审阅' : `审阅 · ${name}`)
        }

        ctx.effect(() => {
          const disposeType = ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            title: () => '审阅',
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

        // "The Agent opened a surface" — the only way the Host can currently tell
        // the panel anything, because there is no push channel yet. One request
        // for a small in-memory object; B8.4c replaces it with the SSE
        // `review/changed` frame.
        ctx.effect(() => {
          let stopped = false
          let busy = false
          let seenRevision = -1
          // null = "adopt the Host's counter without treating it as a change".
          let seenChanged = null
          const tick = async () => {
            if (stopped || busy) return
            busy = true
            try {
              const url = new URL('api/review.current', window.location.href).href
              const response = await fetch(url, { cache: 'no-store' })
              if (response.ok) {
                const value = await response.json()
                const surface = typeof value?.surface === 'string' ? value.surface : ''
                const revision = Number(value?.revision ?? 0)
                if (surface !== '' && revision !== seenRevision) {
                  seenRevision = revision
                  // a different surface resets the Host's change counter with it
                  seenChanged = null
                  surfaceStore.set(surface)
                  openPanel()
                }
                const changed = Number(value?.changedSeq ?? 0)
                if (seenChanged === null) seenChanged = changed
                else if (changed > seenChanged) {
                  seenChanged = changed
                  changedStore.bump()
                }
              }
            } catch {
              /* the Host may be restarting; the next tick retries */
            } finally {
              busy = false
            }
          }
          tick()
          const timer = window.setInterval(tick, CURRENT_POLL_MS)
          return () => {
            stopped = true
            window.clearInterval(timer)
          }
        }, 'dsh-review-dock: follow the opened surface')
      },
    }
  },
})
