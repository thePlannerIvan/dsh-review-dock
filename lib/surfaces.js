/**
 * Session-scoped registry of the surfaces this Host has been asked to show.
 *
 * Why this is its own file: it is the one piece of state that has to be right
 * before anything else can be, it has no I/O, and `lib/index.js` is a Cordis
 * bundle that registers itself on the Host's module loader. Keeping the rules
 * here means a plain `node --test` can drive them directly instead of
 * extracting source text.
 *
 * The rules (2026-10-21, user decision):
 *
 *   1. ONE SURFACE = ONE TAB. `review_open` on a surface this conversation does
 *      not have yet APPENDS; it never replaces what the human is looking at.
 *   2. SAME SURFACE OPENED AGAIN = REFRESH THAT ONE. The entry's `revision`
 *      steps, which is the only thing the frame re-keys on, so an Agent that
 *      regenerated the same `entry` HTML gets a real reload.
 *   3. A SURFACE BELONGS TO THE CONVERSATION THAT OPENED IT. Two conversations
 *      never see each other's list. Whatever the human has open in one is
 *      untouched by the other.
 *   4. NO SESSION IDENTITY DOES NOT MEAN "REFUSE". `review_open` used to refuse
 *      outright when it could not resolve the conversation, which is a wall in
 *      front of the human rather than a protection. Such a surface now waits in
 *      a short-lived pending list and is claimed by the conversation whose
 *      panel polls next — the panel is only mounted for the conversation on
 *      screen, and the entry expires, so it cannot leak into someone else's tab.
 */
export const PENDING_TTL_MS = 10_000

/**
 * @param options.now - clock, injectable so expiry can be tested without waiting.
 * @param options.pendingTtlMs - how long an identity-less open waits to be claimed.
 */
export function createSurfaceRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const pendingTtlMs = Number(options.pendingTtlMs ?? PENDING_TTL_MS)
  /** @type {Map<string, Map<string, object>>} sessionId → (surface file → entry) */
  const bySession = new Map()
  /** @type {object[]} entries opened without a resolved conversation */
  let pending = []
  let order = 0

  function bucket(sessionId) {
    let held = bySession.get(sessionId)
    if (held === undefined) {
      held = new Map()
      bySession.set(sessionId, held)
    }
    return held
  }

  function makeEntry({ surface, title, id, watch }) {
    order += 1
    return {
      surface,
      title: typeof title === 'string' ? title : '',
      id: typeof id === 'string' ? id : '',
      watch: Array.isArray(watch) ? watch : [],
      // `revision` is what the frame re-keys on. It starts at 1 so that a fresh
      // entry is always "newer" than the panel's initial 0.
      revision: 1,
      // `changedSeq` steps once per distinct metadata state of `watch`; the page
      // turns a step into one `review/changed` poke and re-reads what it needs.
      changedSeq: 0,
      token: null,
      order,
      openedAt: now(),
    }
  }

  /**
   * Record an open for one conversation.
   * Same surface again = the same entry with a stepped revision (refresh), never
   * a second entry and never a replacement of the others.
   * @returns the entry the panel should now be showing.
   */
  function open({ sessionId, surface, title = '', id = '', watch = [] }) {
    if (typeof surface !== 'string' || surface === '') throw new Error('surface 不能为空')
    if (typeof sessionId !== 'string' || sessionId === '') return openPending({ surface, title, id, watch })
    const held = bucket(sessionId)
    const previous = held.get(surface)
    if (previous === undefined) {
      const entry = makeEntry({ surface, title, id, watch })
      held.set(surface, entry)
      return entry
    }
    order += 1
    previous.title = typeof title === 'string' && title !== '' ? title : previous.title
    previous.id = typeof id === 'string' && id !== '' ? id : previous.id
    previous.watch = Array.isArray(watch) ? watch : previous.watch
    previous.revision += 1
    previous.order = order
    previous.openedAt = now()
    return previous
  }

  /** An identity-less open: no bucket, so no conversation can see it yet. */
  function openPending({ surface, title = '', id = '', watch = [] }) {
    pending = pending.filter((entry) => entry.surface !== surface)
    const entry = makeEntry({ surface, title, id, watch })
    entry.pending = true
    pending.push(entry)
    return entry
  }

  /**
   * Hand still-warm identity-less opens to the conversation that is polling now,
   * and drop the ones nobody claimed in time.
   * @returns the entries claimed by this conversation.
   */
  function claimPending(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const cutoff = now() - pendingTtlMs
    const fresh = pending.filter((entry) => entry.openedAt > cutoff)
    // Everything here is consumed: the fresh ones move into the claiming
    // conversation, the expired ones are dropped. Leaving either behind would
    // let a stale open surface land in a later conversation.
    pending = []
    const claimed = []
    const held = bucket(sessionId)
    for (const entry of fresh) {
      if (held.has(entry.surface)) {
        // The conversation already shows this surface: keep its revision moving
        // rather than mounting a second copy of the same page.
        const existing = held.get(entry.surface)
        existing.revision += 1
        existing.watch = entry.watch
        existing.openedAt = entry.openedAt
        existing.order = entry.order
        continue
      }
      delete entry.pending
      held.set(entry.surface, entry)
      claimed.push(entry)
    }
    return claimed
  }

  /** Every surface this conversation has been asked to show, oldest first. */
  function list(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const held = bySession.get(sessionId)
    if (held === undefined) return []
    return [...held.values()].sort((left, right) => left.order - right.order)
  }

  /** The most recently opened surface for one conversation, if any. */
  function newest(sessionId) {
    const entries = list(sessionId)
    return entries.length === 0 ? undefined : entries[entries.length - 1]
  }

  /** Forget a conversation's list (used by tests and by a hard reset). */
  function clear(sessionId) {
    if (sessionId === undefined) {
      bySession.clear()
      pending = []
      return
    }
    bySession.delete(sessionId)
  }

  return { open, openPending, claimPending, list, newest, clear, pendingCount: () => pending.length }
}
