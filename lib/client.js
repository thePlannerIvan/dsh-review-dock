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
 *   parent → frame   `contentWindow.postMessage(msg, window.location.origin)`
 *                    The frame is same-origin since 0.2.5 (the sandbox carries
 *                    `allow-same-origin` for embedded players), so a concrete
 *                    targetOrigin is available; `'*'` is kept only for the
 *                    impossible "origin is null" fallback.
 *   frame → parent   `event.source === frame.contentWindow`, then the frame's own
 *                    nonce echoed on every later message. The source check is what
 *                    authenticates the frame; the nonce keeps a stale or foreign
 *                    document in that frame from speaking for it.
 *
 * The parent is the one that talks to the Host: it is same-origin and carries
 * the Session cookie. A `fetch` from inside the opaque frame would be a
 * cross-origin request with no cookie — measured as `Sec-Fetch-Site: cross-site`
 * and refused 403 before authentication.
 *
 * A review tab belongs to the conversation whose layout holds it. Placement goes
 * through that conversation's own `tab.actions.openTab` (which targets the tab's
 * session, even when another conversation is on screen), and the global
 * `ctx.sidebarRight.openTab` is a fallback only for the on-screen conversation.
 * Before 0.3.1 the global controller was the only path, so a review opened by a
 * background conversation popped into the sidebar — and the column of — whichever
 * conversation the human happened to be looking at.
 *
 * 0.4.0 moved every decision about tab ownership out of the React closures and
 * into `createPanel()` below: a plain object with three actions (observe a poll
 * answer, place a tab, relay a bridge call), driven by tests through a fake
 * Host. The React half now only renders, listens, and forwards messages.
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

    /**
     * What the page is told about this Host in `init.host`. The version comes
     * from the Host's answer, not from a literal in this file: the literal went
     * stale once already (0.2.4 fixed a frozen `0.2.0`), and a page that reports
     * the wrong Host version is worse than one that reports none.
     */
    let hostInfo = { name: 'dsh-review-dock', version: '' }

    /** How often a conversation asks the Host which surfaces it has to show. */
    const CURRENT_POLL_MS = 2000

    /**
     * A just-placed tab may not have reached the layout snapshot yet. For this
     * long, "zero review tabs in the layout" must not be read as "the human
     * closed it" — opening a second tab for the same surface is the defect.
     */
    const PLACED_GRACE_MS = 5000

    const keyOf = (sessionId, surface) => `${sessionId}\u0000${surface}`

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
    function createSurfaceStore() {
      return {
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
    }

    /**
     * 「这是哪个对话」—— 唯一一套推导。
     *
     * `seat` 是标签所在布局的对话（框架给的），`named` 是开它的那次交接写进
     * 参数里的对话。两者不一致 = 这个标签被旧版本放错了地方。界面层和状态机
     * 读同一个答案：帧显示哪个对话的审阅页、标签算谁的、错放守卫拦不拦，全部
     * 从这里来。0.3.x 的守卫只读 `props.sessionId`，而帧还信任 `params.sessionId`；
     * 一个不暴露 `props.sessionId` 的座位会静默关掉守卫，这正是要消灭的分叉。
     *
     * @param {{ seat?: string, named?: string }} facts
     * @returns the conversation this tab belongs to ('' when nothing names one).
     */
    function conversationOf({ seat = '', named = '' } = {}) {
      const own = String(seat ?? '').trim()
      if (own !== '') return own
      return String(named ?? '').trim()
    }

    /**
     * A tab whose layout conversation differs from the conversation its opener
     * named was misfiled by an older build (or restored from a layout one wrote).
     * With `seat` unknown the two sides cannot disagree, so the guard stays off —
     * and the frame shows the same conversation the guard checked.
     */
    function isMisfiled({ seat = '', named = '' } = {}) {
      const own = String(seat ?? '').trim()
      const claimed = String(named ?? '').trim()
      return own !== '' && claimed !== '' && own !== claimed
    }

    /**
     * 外壳在帧底下说的那一行。
     *
     * 只有两种东西配占这一行：一次失败的原因（放置失败 / 轮询失败），和一个必须
     * 让人看见的回执（已提交 / 没送到 / 重复提交）。没有失败时不渲染任何状态词 ——
     * 「正常」不是信息，这个仓库明确否过装饰性的状态文字。
     *
     * @param {{ note?: string, problems?: Array<{kind: string, sessionId: string, reason: string}>, sessionId?: string }} input
     * @returns one line, or '' when there is nothing the human must see.
     */
    function statusLine({ note = '', problems = [], sessionId = '' } = {}) {
      const parts = []
      for (const problem of Array.isArray(problems) ? problems : []) {
        if (problem?.sessionId !== String(sessionId ?? '')) continue
        // A `layout` problem means "cannot tell which tab was closed", not "the
        // panel is broken": it never blanks the page, so it does not take the line.
        const what = problem.kind === 'place' ? '放置失败' : problem.kind === 'poll' ? '轮询失败' : ''
        if (what === '') continue
        const reason = String(problem.reason ?? '').trim()
        const text = reason === '' ? what : `${what}：${reason}`
        if (!parts.includes(text)) parts.push(text)
      }
      const said = String(note ?? '').trim()
      if (said !== '' && !parts.includes(said)) parts.push(said)
      return parts.join('；')
    }

    /**
     * The sidebar state machine. Three actions, and that is the whole interface:
     *
     *   observe(sessionId, answer)                 看一次清单
     *   place({ sessionId, surface, revision })    放一个标签
     *   relay({ sessionId, surface, method, payload })  转交一次请求
     *
     * Everything that decides ownership and placement lives here: which
     * conversation a tab belongs to, whether this is its turn to get a tab,
     * whether a closed tab may come back, and what the frames should show.
     *
     * It uses no `window`, no `document` and no React. The Host adapter supplies
     * what only the sidebar knows:
     *
     *   onScreen()                the conversation the panel is showing
     *   reviewTabs(sessionId)     that conversation's layout tabs (or throws)
     *   mountedTabs(sessionId)    live tabs: { placer?, surfaces, unbound }
     *   reveal()                  open the right column for the on-screen one
     *   openTab(kind, options)    the global controller (on-screen only)
     *
     * The store read surface below (`revision` / `title` / `changedSeq` /
     * `latest` / `subscribe` / `surfaceForTab`) is what the shell renders from;
     * it holds no placement decisions.
     */
    function createPanel({ host, fetch: send, endpoint, now = Date.now }) {
      const store = createSurfaceStore()
      const sessions = new Map()
      const adoptedByTab = new Map()
      const problems = new Map()
      const sendRequest = send ?? ((url, init) => globalThis.fetch(url, init))
      const endpointOf = endpoint ?? ((name) => new URL(`api/${name}`, globalThis.location.href).href)
      const actionTableMissing = '宿主没有提供动作表——可能是一份旧副本在应答'
      let actionTable = null

      const describe = (error) => String(error?.message ?? error)
      const problemKey = (kind, sessionId, surface) => `${kind}\u0000${sessionId}\u0000${surface}`
      const report = (kind, sessionId, surface, reason) => {
        const key = problemKey(kind, sessionId, surface)
        const held = problems.get(key)
        problems.set(key, { kind, sessionId, surface, reason })
        // The shell renders this list, so a NEW or CHANGED reason has to bring it
        // back to the screen; an unchanged one must not (a notify per poll tick
        // would rebuild every frame). This is what carries a failure to the human
        // instead of leaving only tests able to read `problems()`.
        if (held === undefined || held.reason !== reason) store.notify()
      }
      const settle = (kind, sessionId, surface) => {
        const key = problemKey(kind, sessionId, surface)
        if (!problems.delete(key)) return
        store.notify()
      }

      function stateOf(sessionId) {
        let state = sessions.get(sessionId)
        if (state === undefined) {
          state = {
            seen: new Map(),         // surface -> { revision, changed }
            placed: new Map(),       // surface -> { revision, at }
            parked: new Map(),       // surface -> { revision, reason }
            // Before the first probe, the panel's own placements are the only
            // evidence there is; only a failed or contradictory probe makes the
            // layout unknown.
            layout: { known: true, count: -1, reason: '' },
            lastCount: -1,
            pollMs: CURRENT_POLL_MS,
          }
          sessions.set(sessionId, state)
        }
        return state
      }

      function onScreen() {
        try {
          return String(host?.onScreen?.() ?? '').trim()
        } catch {
          return ''
        }
      }

      /** What is actually mounted in one conversation right now. */
      function mountedOf(sessionId) {
        try {
          const value = host?.mountedTabs?.(sessionId)
          const surfaces = value?.surfaces instanceof Set
            ? value.surfaces
            : new Set(Array.isArray(value?.surfaces) ? value.surfaces : [])
          return {
            placer: typeof value?.placer === 'function' ? value.placer : undefined,
            surfaces,
            unbound: Number(value?.unbound ?? 0) || 0,
          }
        } catch {
          return { placer: undefined, surfaces: new Set(), unbound: 0 }
        }
      }

      /** Open the right column for a conversation, never for another one. */
      function revealFor(sessionId) {
        if (onScreen() !== sessionId) return false
        try {
          host?.reveal?.()
          return true
        } catch {
          return false
        }
      }

      /**
       * Reconcile the placement records against the layout.
       *
       * A smaller review-tab count is NOT enough to conclude which surface was
       * closed: with more than one surface open, the count cannot say which one
       * is gone, and a probe that throws or contradicts the mounted tabs cannot
       * say anything at all. Only when every remaining tab is a mounted tab we
       * know by surface (or the layout is empty and nothing is mounted) are the
       * unclaimed records conclusive. Everything else leaves the records alone
       * and parks re-handing for a later look.
       */
      function reconcile(sessionId) {
        const state = stateOf(sessionId)
        let tabs
        try {
          if (typeof host?.reviewTabs !== 'function') throw new Error('宿主没有提供标签清单')
          tabs = host.reviewTabs(sessionId)
          if (!Array.isArray(tabs)) throw new Error('宿主回答的标签清单形状不对')
        } catch (error) {
          const reason = describe(error)
          state.layout = { known: false, count: state.lastCount, reason }
          report('layout', sessionId, '', reason)
          return state.layout
        }
        const count = tabs.filter((tab) => tab?.kind === KIND).length
        const mounted = mountedOf(sessionId)
        const claimed = mounted.surfaces
        let reason = ''
        let ambiguous = false
        if (count < state.placed.size) {
          if (claimed.size > count) {
            // The probe says fewer tabs than the ones this conversation reports
            // as mounted. No surface-level truth here.
            ambiguous = true
          } else if (claimed.size < count) {
            // Some existing tab is unmounted, so we cannot tell whether the
            // re-handed surface is the one that was closed.
            ambiguous = true
          } else {
            // Every existing tab is one we know by surface: an unclaimed placed
            // surface is definitely gone. A just-placed one gets a grace period
            // while its open travels to the layout snapshot.
            const at = now()
            for (const [surface, held] of [...state.placed]) {
              if (claimed.has(surface)) continue
              if (at - held.at < PLACED_GRACE_MS) continue
              state.placed.delete(surface)
            }
          }
        }
        if (ambiguous) reason = '标签清单与挂载证据不一致，无法判断哪一份面被关掉'
        state.lastCount = count
        state.layout = { known: !ambiguous, count, reason }
        if (ambiguous) report('layout', sessionId, '', reason)
        else settle('layout', sessionId, '')
        return state.layout
      }

      /**
       * Place one surface's tab in its OWN conversation.
       *
       * Returns a receipt, never a bare boolean: `waiting` means the
       * conversation cannot take it yet (and may keep waiting), `failed` means a
       * placement was attempted and the Host refused (the reason is recorded),
       * `opened` / `already` mean the surface has its tab.
       */
      function place(request) {
        const sessionId = String(request?.sessionId ?? '').trim()
        const surface = String(request?.surface ?? '')
        const revision = Number(request?.revision ?? 0)
        if (sessionId === '' || surface === '') return { status: 'waiting', reason: 'no-target' }
        const state = stateOf(sessionId)
        const mounted = mountedOf(sessionId)
        const screen = onScreen() === sessionId

        if (mounted.surfaces.has(surface)) {
          // The surface has a mounted tab: opening another would show it twice.
          state.placed.set(surface, { revision, at: now() })
          state.parked.delete(surface)
          settle('place', sessionId, surface)
          return { status: 'already', mounted: true }
        }

        if (mounted.unbound > 0) {
          // A hand-opened empty tab adopts this conversation's newest surface
          // (see `surfaceForTab`); opening one now would show it twice. Park it
          // so that if the empty tab pins an EARLIER surface instead, the retry
          // after it adopts still gives this one a tab.
          state.parked.set(surface, { revision, reason: 'empty-tab' })
          return { status: 'waiting', reason: 'empty-tab' }
        }

        if (state.placed.has(surface)) {
          // Believed placed. `reconcile` decides whether that is still true; with
          // an unknown or contradictory layout the re-hand is parked instead of
          // opening a possible duplicate.
          revealFor(sessionId)
          if (state.layout.known === false) {
            state.parked.set(surface, { revision, reason: 'layout-unknown' })
            return { status: 'waiting', reason: 'layout-unknown' }
          }
          state.parked.delete(surface)
          settle('place', sessionId, surface)
          return { status: 'already', mounted: false }
        }

        if (mounted.placer === undefined && !screen) {
          // Nowhere safe to put it yet: never fall back to the on-screen conversation.
          state.parked.set(surface, { revision, reason: 'not-on-screen' })
          return { status: 'waiting', reason: 'not-on-screen' }
        }

        // Without the column open the tab exists but the frame is 0×0 and the
        // human sees nothing (measured, 0.2.0). Reveal only for THIS conversation.
        if (screen) revealFor(sessionId)
        const options = { params: { surface, sessionId } }
        try {
          // `multiple: true` on the tab type: every call is its own tab, with its
          // own navigation params, its own frame and its own state.
          if (mounted.placer !== undefined) {
            mounted.placer(KIND, options)
            state.placed.set(surface, { revision, at: now() })
            state.parked.delete(surface)
            settle('place', sessionId, surface)
            return { status: 'opened', via: 'tab' }
          }
          if (typeof host?.openTab !== 'function') throw new Error('宿主没有提供开标签的入口')
          host.openTab(KIND, options)
          state.placed.set(surface, { revision, at: now() })
          state.parked.delete(surface)
          settle('place', sessionId, surface)
          return { status: 'opened', via: 'screen' }
        } catch (error) {
          const reason = describe(error)
          state.parked.set(surface, { revision, reason })
          report('place', sessionId, surface, reason)
          return { status: 'failed', reason }
        }
      }

      function record(receipt, surface, result) {
        if (result.status === 'opened') receipt.placed.push({ surface, via: result.via })
        else if (result.status === 'waiting') receipt.waiting.push({ surface, reason: result.reason })
        else if (result.status === 'failed') receipt.failed.push({ surface, reason: result.reason })
        else if (result.status === 'already' && result.mounted === false) receipt.held.push({ surface })
      }

      /**
       * 看一次清单：consume one `GET /api/review.current` answer. It owns the
       * revision/title/poke bookkeeping and every placement decision that answer
       * implies; the shell only fetches and forwards.
       *
       * A poll that never got an answer is the same action with no list to read:
       * `{ error }` records WHY on the same path, so "宿主不在或连接断了" reaches
       * the human's eyes instead of leaving a blank panel.
       */
      function observe(sessionId, value) {
        const id = String(sessionId ?? '').trim()
        const receipt = {
          pollMs: CURRENT_POLL_MS,
          placed: [],
          held: [],
          waiting: [],
          failed: [],
          poked: [],
          layout: { known: false, count: -1, reason: '还没有清单' },
        }
        if (id === '') return receipt
        const state = stateOf(id)
        const pollFailure = typeof value?.error === 'string' ? value.error.trim() : ''
        if (pollFailure !== '') {
          // Nothing was placed or poked: this tick has no evidence at all.
          receipt.layout = { known: false, count: state.lastCount, reason: pollFailure }
          report('poll', id, '', pollFailure)
          return receipt
        }
        settle('poll', id, '')
        const reportedPollMs = Number(value?.pollMs)
        if (Number.isFinite(reportedPollMs) && reportedPollMs >= 500) state.pollMs = reportedPollMs
        receipt.pollMs = state.pollMs
        receipt.layout = reconcile(id)

        const attempted = new Set()
        const list = Array.isArray(value?.surfaces) ? value.surfaces : []
        for (const entry of list) {
          const surface = String(entry?.surface ?? '')
          if (surface === '') continue
          const revision = Number(entry?.revision ?? 0)
          const changedSeq = Number(entry?.changedSeq ?? 0)
          const title = typeof entry?.title === 'string' ? entry.title : ''
          let seen = state.seen.get(surface)
          if (seen === undefined) {
            seen = { revision: -1, changed: 0 }
            state.seen.set(surface, seen)
          }
          if (seen.revision !== revision) {
            // New surface, or the same one re-opened: step the frame's key.
            seen.revision = revision
            seen.changed = changedSeq
            store.setRevision(id, surface, revision, title)
            store.setLatest(id, surface)
            // A plain poll never revives a closed tab — only a revision step
            // brings it back, so the human's close wins until the Agent really
            // opens that surface again.
            record(receipt, surface, place({ sessionId: id, surface, revision }))
            attempted.add(surface)
          } else if (changedSeq > seen.changed) {
            seen.changed = changedSeq
            store.bumpChanged(id, surface)
            receipt.poked.push(surface)
          }
        }

        // Surfaces that were handed over but could not be placed yet (the
        // conversation was not on screen, the open failed, or the layout could
        // not say whether the tab was still there) are retried every tick.
        for (const [surface, held] of [...state.parked]) {
          if (attempted.has(surface)) continue
          record(receipt, surface, place({ sessionId: id, surface, revision: held.revision }))
        }
        return receipt
      }

      /**
       * The action table, fetched once per page. A page whose table cannot be
       * fetched must hear WHY: an older copy of this plugin answering first does
       * not implement this route, and "未知的桥方法" would send the reader
       * looking at the wrong side of the bridge.
       */
      function readActions() {
        if (actionTable !== null) return actionTable
        actionTable = Promise.resolve()
          .then(() => sendRequest(endpointOf('review.actions'), { cache: 'no-store' }))
          .then((response) => {
            if (response?.ok !== true) {
              throw new Error(`${actionTableMissing}（HTTP ${response?.status ?? '?'}）`)
            }
            return response.json()
          })
          .then((value) => {
            if (!Array.isArray(value?.actions)) {
              throw new Error(`${actionTableMissing}（回执里没有 actions）`)
            }
            return value.actions
          })
          .catch((error) => {
            actionTable = null
            const reason = describe(error)
            if (reason.includes(actionTableMissing)) throw new Error(reason)
            throw new Error(`${actionTableMissing}（${reason}）`)
          })
        return actionTable
      }

      /**
       * 转交一次请求：one bridge call, dispatched through the Host's own table.
       * Resolves to `{ value, note? }`; a refusal throws and the shell turns it
       * into the page's `result` with `ok: false`.
       */
      async function relay(request) {
        const method = String(request?.method ?? '')
        let actions
        try {
          actions = await readActions()
        } catch (error) {
          throw new Error(`无法读取动作表：${describe(error)}`)
        }
        const action = actions.find((entry) => entry?.name === method)
        if (action === undefined) throw new Error(`未知的桥方法：${method}`)
        return carry(action, {
          surface: String(request?.surface ?? ''),
          sessionId: String(request?.sessionId ?? ''),
          payload: request?.payload ?? {},
          endpoint: endpointOf,
          fetch: sendRequest,
        })
      }

      /**
       * Which surface a tab shows. Its own params win; a hand-opened tab (the
       * guide's 「审阅」) adopts this conversation's NEWEST surface once, then
       * stays there. Following "newest" for ever would be wrong twice over: the
       * tab would jump to a different review every time the Agent opens one, and
       * it would show the same page as the tab the poller just opened.
       */
      function surfaceForTab({ sessionId, tabId, named = '' } = {}) {
        const own = String(named ?? '').trim()
        if (own !== '') return own
        const id = String(tabId ?? '')
        if (id === '') return ''
        const held = adoptedByTab.get(id)
        if (held !== undefined) return held
        const latest = store.latest(String(sessionId ?? ''))
        if (latest === '') return ''
        adoptedByTab.set(id, latest)
        return latest
      }

      return {
        observe,
        place,
        relay,
        // Read surface for the shell. These are not actions: they only report
        // what the three actions decided.
        revision: (sessionId, surface) => store.revision(sessionId, surface),
        title: (sessionId, surface) => store.title(sessionId, surface),
        changedSeq: (sessionId, surface) => store.changedSeq(sessionId, surface),
        latest: (sessionId) => store.latest(sessionId),
        subscribe(listener) {
          store.listeners.add(listener)
          return () => { store.listeners.delete(listener) }
        },
        surfaceForTab,
        problems: () => [...problems.values()],
      }
    }

    /**
     * Carry one bridge call to the Host, using the table the Host serves.
     *
     * This is the whole relay. `relay()` above looks up the row whose `name`
     * matches and hands it here; a new action is a new row, not a new branch.
     * The six-branch if-chain this replaces is exactly how `draftRead` went
     * missing: the bridge provided it, the Host route implemented it, and the
     * relay had nowhere to put it.
     *
     * Every action resolves to `{ value, note? }`; a refusal throws and the
     * caller turns it into the page's `result` with `ok: false`.
     *
     * @param action - one row of GET /api/review.actions.
     * @param context - `{ surface, sessionId, payload, endpoint, fetch }`.
     */
    async function carry(action, context) {
      const send = context.fetch
      const endpoint = context.endpoint
      const surface = context.surface
      const payload = context.payload ?? {}
      const relay = action?.relay
      if (relay === undefined || typeof relay.kind !== 'string') {
        throw new Error(`动作 ${String(action?.name ?? '')} 没有说明转交方式`)
      }
      // The row says which fields travel; this is the only place they are read.
      const source = {
        surface,
        sessionId: context.sessionId,
        payload: context.payload ?? null,
        unit: String(payload?.unit ?? ''),
        text: String(payload?.text ?? ''),
        rel: String(payload?.rel ?? ''),
        v: payload?.v === undefined || payload?.v === null ? '' : String(payload.v),
      }
      const endpointOf = (route) => endpoint(String(route).replace(/^\/api\//, ''))
      const queryOf = () => {
        const query = new URLSearchParams()
        for (const key of relay.query ?? []) {
          // `v` is a cache-buster and is omitted when absent, exactly as before.
          if (key === 'v' && source.v === '') continue
          query.set(key, source[key] ?? '')
        }
        return query
      }

      if (relay.kind === 'bytes') {
        const response = await send(`${endpointOf(action.route)}?${queryOf().toString()}`, { cache: 'no-store' })
        if (!response.ok) {
          if (response.status === 404 && payload?.optional === true) {
            return { value: { bytes: new ArrayBuffer(0), type: 'text/plain', missing: true } }
          }
          throw new Error(`资产未找到：${source.rel}（HTTP ${response.status}）`)
        }
        return {
          value: {
            bytes: await response.arrayBuffer(),
            type: response.headers.get('content-type') ?? 'application/octet-stream',
          },
        }
      }

      if (relay.kind === 'raw') {
        // The bridge hands over `{ rel, name, bytes }` as an ArrayBuffer; the
        // bytes go to the Host as the raw body, never base64. The Host re-checks
        // containment and never trusts `rel`.
        const bytes = payload?.bytes
        if (!(bytes instanceof ArrayBuffer)) {
          throw new Error('upload 需要 ArrayBuffer 字节（桥会先做 file.arrayBuffer()）')
        }
        const response = await send(`${endpointOf(action.route)}?${queryOf().toString()}`, {
          method: relay.method,
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        })
        const value = await response.json().catch(() => null)
        if (!response.ok || value?.ok === false) throw new Error(value?.error ?? `HTTP ${response.status}`)
        return { value, note: `图片已上传（${Number(value?.bytes ?? bytes.byteLength)} 字节 → ${source.rel}）` }
      }

      const url = new URL(endpointOf(action.route))
      for (const [key, value] of queryOf().entries()) url.searchParams.set(key, value)
      const init = { method: relay.method, cache: 'no-store' }
      if (Array.isArray(relay.body)) {
        const body = {}
        for (const key of relay.body) body[key] = source[key]
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await send(url.href, init)
      const value = await response.json().catch(() => null)
      if (relay.reply === 'wake') return interpretWake(response, value)
      // `command` answers HTTP 200 with a backend refusal in the body: that is a
      // result, not a lost bridge message, so only the transport status throws.
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
      return { value }
    }

    /**
     * The four-state wake receipt, in words the human can read.
     *
     * `duplicate` (409) is NOT a failure: the write landed and an earlier call
     * already delivered this submission. `accepted-unverified` is not a failure
     * either: the Host accepted the prompt but this DSH has no read API to check
     * delivery. Saying "sent" for either would be the false green the four-state
     * table exists to prevent.
     */
    function interpretWake(response, value) {
      if (response.status === 409 && value?.state === 'duplicate') {
        const notice = '已写入；本次没有新增通知（同一次提交之前已送达）'
        return { value: { ...value, ok: true, duplicate: true, notice }, note: notice }
      }
      if (!response.ok || value?.ok === false) {
        throw new Error(value?.error ?? `HTTP ${response.status}`)
      }
      if (value?.state === 'accepted-unverified') {
        const notice = typeof value?.warning === 'string' && value.warning !== ''
          ? value.warning
          : '已提交；但当前宿主无法核对是否送达'
        return { value: { ...value, ok: true, unverified: true, notice }, note: notice }
      }
      return {
        value,
        note: value?.verified?.equalsWakeText ? '已唤醒模型（已在会话日志里核对）' : '已唤醒模型',
      }
    }

    return {
      // Exported so the three actions and the relay can be driven outside a
      // browser (the behavior tests and the real-browser harness use this one
      // implementation; the React shell below uses the same object).
      createPanel,
      conversationOf,
      isMisfiled,
      statusLine,
      carry,
      // `layout` is a real dependency, not a nicety: without it declared, the
      // session seat is not bound when the panel tries to reveal the column, the
      // reveal is a silent no-op, and the tab opens inside a collapsed column
      // (measured: frame 0×0, inert pane, nothing on screen).
      inject: ['layout', 'slots', 'sidebarRightTabs', 'sidebarRight'],

      apply(ctx) {
        /**
         * The facts of one mounted tab, read once per render. `useTabInfo` is a
         * hook, so it is called once here and the plain values are handed to the
         * single conversation derivation used by the frame, the guard, the seat
         * and the poller.
         */
        function tabFacts(props) {
          let info = null
          try {
            info = props?.useTabInfo?.() ?? null
          } catch {
            /* no tab info available in this seat */
          }
          const params = info?.tab?.navigation?.params || {}
          return {
            seat: String(props?.sessionId ?? props?.session?.id ?? '').trim(),
            named: String(params?.sessionId ?? '').trim(),
            surface: typeof params?.surface === 'string' ? params.surface : '',
            tabId: String(info?.tab?.id ?? ''),
            tabActions: info?.tab?.actions,
          }
        }

        /**
         * What this conversation has mounted, in the plain shape the panel asks
         * for. This is facts about rendering, not placement decisions: the panel
         * decides what may be placed; the shell only reports what is on screen.
         */
        const seats = new Map()

        function seatOf(sessionId) {
          let seat = seats.get(sessionId)
          if (seat === undefined) {
            seat = { placers: new Set(), surfaces: new Map(), unbound: 0 }
            seats.set(sessionId, seat)
          }
          return seat
        }

        function firstPlacer(seat) {
          for (const place of seat.placers.values()) return place
          return undefined
        }

        /**
         * Register one mounted tab as: a placer for ITS conversation, a claim on
         * its surface (or an open, unbound tab), and nothing else. The returned
         * function withdraws all three.
         */
        function mountSeat(sessionId, { surface, openTab }) {
          const seat = seatOf(sessionId)
          if (typeof openTab === 'function') seat.placers.add(openTab)
          if (surface === '') {
            seat.unbound += 1
          } else {
            seat.surfaces.set(surface, (seat.surfaces.get(surface) ?? 0) + 1)
          }
          return () => {
            if (typeof openTab === 'function') seat.placers.delete(openTab)
            if (surface === '') {
              seat.unbound = Math.max(0, seat.unbound - 1)
            } else {
              const held = seat.surfaces.get(surface) ?? 0
              if (held <= 1) seat.surfaces.delete(surface)
              else seat.surfaces.set(surface, held - 1)
            }
            if (seat.placers.size === 0 && seat.surfaces.size === 0 && seat.unbound === 0) {
              seats.delete(sessionId)
            }
          }
        }

        const panel = createPanel({
          host: {
            onScreen: () => {
              try {
                return String(ctx.sidebarRight?.mounted?.getSnapshot?.() ?? '').trim()
              } catch {
                return ''
              }
            },
            // A missing probe must stay distinguishable from an empty layout:
            // undefined means "unknown", never zero.
            reviewTabs: (sessionId) => {
              if (typeof ctx.sidebarRight?.tabsIn !== 'function') {
                throw new Error('宿主没有提供标签清单（sidebarRight.tabsIn）')
              }
              return ctx.sidebarRight.tabsIn(sessionId)
            },
            mountedTabs: (sessionId) => {
              const seat = seats.get(sessionId)
              return {
                placer: seat === undefined ? undefined : firstPlacer(seat),
                surfaces: new Set(seat === undefined ? [] : seat.surfaces.keys()),
                unbound: seat?.unbound ?? 0,
              }
            },
            reveal: () => {
              ctx.get('layout')?.openRightbar?.(true, false)
            },
            openTab: (kind, options) => {
              if (typeof ctx.sidebarRight?.openTab !== 'function') {
                throw new Error('右侧栏控制器不可用')
              }
              ctx.sidebarRight.openTab(kind, options)
            },
          },
          endpoint: (name) => new URL(`api/${name}`, window.location.href).href,
          fetch: (url, init) => fetch(url, init),
        })

        /** Re-render on any store change; `read` decides what this component cares about. */
        function usePanelValue(read) {
          const [, force] = React.useState(0)
          React.useEffect(() => {
            const listener = () => force((n) => n + 1)
            return panel.subscribe(listener)
          }, [])
          return read()
        }

        /** 帧的 src 跟着 revision 走，Agent 每次交接都会真的重新取一次页面。 */
        const useRevision = (sessionId, surface) => usePanelValue(() => panel.revision(sessionId, surface))

        /** 标签名跟着面走：几个面同时开着时，「审阅 / 审阅 / 审阅」等于没有标签。 */
        const useSurfaceTitle = (sessionId, surface) => usePanelValue(() => panel.title(sessionId, surface))

        /** 只有这一个面的戳会让这一帧 re-key，别的面的变化不碰它。 */
        const useChanged = (sessionId, surface) => usePanelValue(() => panel.changedSeq(sessionId, surface))

        /** 人手开的一个空标签（没有 params）用它接上本对话最新的一份面。 */
        const useLatestSurface = (sessionId) => usePanelValue(() => panel.latest(sessionId))

        /**
         * Poll bookkeeping is I/O, not ownership: one timer per conversation,
         * alive across tab unmounts, and the fetch is handed straight to the
         * panel. The `seen` revisions and every placement decision live in the
         * panel, so a closed tab stays closed.
         */
        const pollStates = new Map()

        function pollState(sessionId) {
          let state = pollStates.get(sessionId)
          if (state === undefined) {
            state = { timer: null, busy: false, pollMs: CURRENT_POLL_MS }
            pollStates.set(sessionId, state)
          }
          return state
        }

        /**
         * Schedule the next poll. `setTimeout` rather than `setInterval`: a slow
         * Host answer must not stack requests, and the cadence can follow the
         * Host's own `pollMs` without rebuilding a timer in the middle of a tick.
         */
        function schedulePoll(sessionId) {
          const state = pollState(sessionId)
          if (state.timer !== null) return
          state.timer = window.setTimeout(() => {
            state.timer = null
            tick(sessionId)
          }, state.pollMs)
        }

        function tick(sessionId) {
          const state = pollState(sessionId)
          if (state.busy) return
          state.busy = true
          // A hidden window has nobody to show a tab to, and the panel keeps the
          // "already shown" revisions in memory across the pause. Polling a
          // background conversation is pure noise; the next visible tick resumes.
          if (document.hidden) {
            state.busy = false
            schedulePoll(sessionId)
            return
          }
          const url = new URL('api/review.current', window.location.href)
          url.searchParams.set('sessionId', sessionId)
          fetch(url, { cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then((value) => {
              const receipt = panel.observe(sessionId, value)
              const reportedPollMs = Number(receipt?.pollMs)
              if (Number.isFinite(reportedPollMs) && reportedPollMs >= 500) state.pollMs = reportedPollMs
            })
            .catch((error) => {
              // The Host may be restarting; the next tick retries. The human still
              // gets the reason on the shell's one line until a tick answers again.
              panel.observe(sessionId, { error: String(error?.message ?? error) })
            })
            .finally(() => {
              state.busy = false
              schedulePoll(sessionId)
            })
        }

        function ensurePolling(sessionId) {
          const state = pollState(sessionId)
          if (state.timer !== null) return
          tick(sessionId)
        }

        function ReviewFrame(props) {
          // Each tab carries its OWN surface in its navigation params. There is no
          // shared "surface on screen" any more: that shared value was what made a
          // second `review_open` take the first review away from the human.
          const facts = tabFacts(props)
          const sessionId = conversationOf(facts)
          const latest = useLatestSurface(sessionId)
          // Own params win; a hand-opened tab pins the newest surface once.
          const surface = panel.surfaceForTab({ sessionId, tabId: facts.tabId, named: facts.surface })
          // A tab belongs to the conversation whose layout holds it, and the guard
          // reads the SAME derivation the frame does.
          const misplaced = isMisfiled(facts)
          const surfaceRevision = useRevision(sessionId, surface)
          const changedSeq = useChanged(sessionId, surface)
          const line = statusLine({ note, problems, sessionId })
          const postRef = React.useRef(null)
          const frameRef = React.useRef(null)
          const [note, setNote] = React.useState('')
          // The panel records WHY a placement or poll failed; re-render when that
          // list changes, so the reason is on screen and not only in a test.
          const problems = usePanelValue(() => panel.problems())

          React.useEffect(() => {
            const frame = frameRef.current
            if (frame === null || surface === '') return () => {}

            const endpoint = (name) => new URL(`api/${name}`, window.location.href).href
            // Same-origin since 0.2.5 (`allow-same-origin` in the frame sandbox),
            // so the concrete origin is a usable target. '*' is only for the
            // theoretical case where the page itself is not on an http(s) origin.
            const targetOrigin = window.location.origin === 'null' ? '*' : window.location.origin
            let childNonce = ''
            let live = true

            const post = (payload) => {
              const child = frame.contentWindow
              if (child === null || childNonce === '') return
              child.postMessage(Object.assign({ __review: true, nonce: childNonce }, payload), targetOrigin)
            }
            const settle = (id, ok, value, error) => {
              if (!ok) post({ type: 'result', id, ok: false, error: String(error) })
              else post({ type: 'result', id, ok: true, value })
            }

            const handleCall = async (data) => {
              const method = String(data.method ?? '')
              try {
                // The panel owns the table lookup and the dispatch; the shell only
                // forwards the message and returns the answer to the page.
                const result = await panel.relay({
                  surface,
                  sessionId,
                  method,
                  payload: data.payload ?? {},
                })
                if (result.note) setNote(result.note)
                settle(data.id, true, result.value)
              } catch (error) {
                const reason = String(error?.message ?? error)
                setNote(`${method} 失败：${reason}`)
                settle(data.id, false, undefined, reason)
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
                    // The Host reports its own name and version with every meta
                    // answer; the page is told what the Host actually is.
                    const reported = value?.host
                    if (typeof reported?.version === 'string' && reported.version !== '') {
                      hostInfo = { name: String(reported.name ?? ID), version: reported.version }
                    }
                    const info = value?.ok === true ? value.surface : null
                    post({
                      type: 'init',
                      assetBase: new URL('.', window.location.href).href,
                      surface: info === null ? null : { id: info.id, title: info.title },
                      capabilities: Array.isArray(info?.capabilities) ? info.capabilities : [],
                      host: hostInfo,
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
                    setNote(`读 surface 元信息失败：${String(error?.message ?? error)}`)
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

          // This tab is mounted in THIS conversation: report the fact so the panel
          // can place more tabs here (through the tab's own actions), and so a
          // hand-opened empty tab parks the next surface instead of duplicating it.
          React.useEffect(() => {
            if (sessionId === '' || misplaced) return
            // Keep the framework's own call shape: `tab.actions.openTab` is a
            // member call, and the panel only knows the function.
            const actions = facts.tabActions
            const openTab = typeof actions?.openTab === 'function'
              ? (kind, options) => actions.openTab(kind, options)
              : undefined
            return mountSeat(sessionId, { surface, openTab })
          }, [sessionId, surface, misplaced, facts.tabActions])

          // One poller per conversation, shared by every tab of it. It is
          // deliberately not torn down on unmount: the "already shown" revisions
          // must survive a tab closing.
          React.useEffect(() => {
            if (sessionId === '') return
            ensurePolling(sessionId)
          }, [sessionId])

          // One poke per step. No payload: the Host only knows metadata moved, and
          // the page is the only side that can tell what that means.
          React.useEffect(() => {
            if (changedSeq === 0) return
            const post = postRef.current
            if (post !== null) post({ type: 'review/changed' })
          }, [changedSeq])

          if (misplaced) {
            return C(
              'div',
              { style: Object.assign({}, FONT, MUTED, { padding: 14 }) },
              '这个审阅标签属于另一个对话，不在这里显示；切回那个对话即可查看。',
            )
          }

          if (surface === '') {
            return C(
              'div',
              { style: Object.assign({}, FONT, MUTED, { padding: 14 }) },
              '这个标签还没有接上审阅页；一有审阅交接，它就会出现在这里。',

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
            line === ''
              ? null
              : C(
                'div',
                {
                  // The status line says things the human must not miss (sent /
                  // unverified / failed) and, above all, the reason a tab or the
                  // polling could not reach the Host. A screen reader hears it too.
                  role: 'status',
                  'aria-live': 'polite',
                  style: Object.assign({}, MUTED, { flex: 'none', padding: '4px 8px' }),
                },
                line,
              ),
          )
        }

        /**
         * The tab chip says WHICH review it is. With one tab per surface, three
         * chips all reading 「审阅」 is the same as having no chip at all.
         */
        function ReviewTitle(props) {
          const facts = tabFacts(props)
          const sessionId = conversationOf(facts)
          const latest = useLatestSurface(sessionId)
          const title = useSurfaceTitle(
            sessionId,
            panel.surfaceForTab({ sessionId, tabId: facts.tabId, named: facts.surface }),
          )
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
                description: () => '把审阅页放进右侧栏，逐项看内容并下决定',
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
