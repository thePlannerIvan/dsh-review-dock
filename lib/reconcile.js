/**
 * 启动对账：盘上两份 `dsh-review-dock` 同时挂载时，让第二份在启动日志里出声。
 *
 * 为什么需要它：两份副本注册同一批 `/api/review.*` 入口，先挂上的那份拿到
 * 应答权，第二份悄悄少一半以上的能力 —— 从侧栏看，这和"升级失败"一模一样，
 * 2026-10-21 有人为此花了一晚上。
 *
 * 运行时实际允许我们做的两件事（`@deepseek-ai/dsh-client-connection` 实测）：
 *
 *   1. `connection.createSharedFetchHandler('/api')` 在**被调用的那一刻**按
 *      pathname 查已注册的精确入口，并派发给它；`createPeer({ principal:
 *      { kind: 'owner' } })` 给插件一个进程内自问自答的身份。两者都是
 *      `connection` 服务的公开 API（HostConnectionHandle），所以"挂载前先问
 *      一句 /api/review.current 归谁、几版"是诚实可行的，不需要定时器，
 *      也不需要去读进程文件。
 *   2. 路径已被占用时，`connection.fetch.register` **同步抛出**
 *      `connection: exact Fetch route "<path>" is already registered`
 *      （旧版运行时可能改成覆盖或忽略 —— 那就只剩 (1) 的证据）。
 *
 * 身份这一格并不总是填得上：本机真实的第二份是 planners-form vendored 的
 * 0.3.0，它注册了同样十个入口，但 `/api/review.current` 的应答里还没有
 * `host`（那个字段从 0.3.1 起才有）。所以"有人应答但没有报出身份"本身就是
 * 证据 —— 说明对方很可能早于 0.3.1 —— 要照实写进那一行，不能因此沉默。
 *
 * 因此这里不做任何"抢"或"修补"：问一次身份、逐条注册、把丢掉的那部分说清。
 * 若运行时连 (1) 都不提供，就只用 (2) 的证据：被占用的条数照实说，
 * 应答者是谁则明说问不到。
 */

/** 自问自答时用的 sessionId；`/api/review.current` 只要求非空。 */
const PROBE_SESSION_ID = 'dsh-review-dock:startup-reconcile'

/** 对账行的固定前缀，日志与测试都认它。 */
const RECONCILE_PREFIX = 'dsh-review-dock: 启动对账：'

/**
 * 问一次"现在 `/api/review.current` 归谁应答、报的哪一版"。
 *
 * 派发在调用 `createSharedFetchHandler(...).fetch(...)` 的同步阶段完成，所以
 * 必须在**本副本注册入口之前**调用；返回的 promise 什么时候结算不影响答案。
 *
 * @param {object} connection `ctx.connection` 服务（HostConnectionHandle）
 * @returns {Promise<
 *   | { kind: 'answered', name: string, version: string }
 *   | { kind: 'silent' }
 *   | { kind: 'unavailable', reason: string }
 * >} `silent` 是"问了，404，没有人在那儿"；`unavailable` 是"这个运行时没有
 *   进程内问身份的办法"。
 */
function probeResponder(connection) {
  if (typeof connection?.createSharedFetchHandler !== 'function') {
    return Promise.resolve({ kind: 'unavailable', reason: 'connection.createSharedFetchHandler' })
  }
  if (typeof connection?.createPeer !== 'function') {
    return Promise.resolve({ kind: 'unavailable', reason: 'connection.createPeer' })
  }
  let handler
  let peer
  try {
    handler = connection.createSharedFetchHandler('/api')
    // A fresh in-process Peer is the documented way to dispatch as the Host's
    // owner; reusing the browser Peer would tie this probe to a browser session.
    peer = connection.createPeer({ principal: { kind: 'owner' } })
  } catch (error) {
    return Promise.resolve({ kind: 'unavailable', reason: error?.message ?? String(error) })
  }
  return probeThrough(handler, peer, '/api/review.current').finally(async () => {
    try {
      await peer.dispose?.()
    } catch {
      /* the probe already has its answer; a peer that will not dispose must not
         turn a startup diagnostic into a mount failure */
    }
  })
}

async function probeThrough(handler, peer, routePath) {
  try {
    const url = new URL(`http://dsh.local${routePath}`)
    url.searchParams.set('sessionId', PROBE_SESSION_ID)
    // The return happens synchronously inside the shared handler: it resolves
    // the exact route NOW, before this copy registers anything of its own.
    const response = await handler.fetch(new Request(url), peer)
    if (response.status === 404) return { kind: 'silent' }
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const host = body?.host
    return {
      kind: 'answered',
      name: typeof host?.name === 'string' ? host.name : '',
      version: typeof host?.version === 'string' ? host.version : '',
    }
  } catch (error) {
    return { kind: 'unavailable', reason: error?.message ?? String(error) }
  }
}

/**
 * Semver-ish comparison, enough for "which copy is older".
 *
 * Returns how `left` relates to `right`: `older`, `same`, `newer`, or `unknown`
 * when either side is not a version we can read. A prerelease (`0.4.0-rc.1`) is
 * older than the release with the same numbers; anything else falls back to a
 * chronological string compare inside the prerelease tag.
 *
 * @param {string} left
 * @param {string} right
 * @returns {'older'|'same'|'newer'|'unknown'}
 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 'unknown'
  const length = Math.max(a.numbers.length, b.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const one = a.numbers[index] ?? 0
    const other = b.numbers[index] ?? 0
    if (one !== other) return one < other ? 'older' : 'newer'
  }
  if (a.prerelease === b.prerelease) return 'same'
  if (a.prerelease === '') return 'newer'
  if (b.prerelease === '') return 'older'
  return a.prerelease < b.prerelease ? 'older' : 'newer'
}

/** One log line means one line: bound and flatten untrusted responder text. */
function plainText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function parseVersion(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (match === null) return null
  return { numbers: match[1].split('.').map(Number), prerelease: match[2] ?? '' }
}

/**
 * Is a competing copy evidenced? Either someone answered the identity probe, or
 * at least one of our own routes could not be registered.
 *
 * @param {Awaited<ReturnType<typeof probeResponder>>} responder
 * @param {Array<{ path: string }>} skipped
 */
function isConflict(responder, skipped) {
  return responder.kind === 'answered' || skipped.length > 0
}

/**
 * The one startup line. It names the responder and its version, says how this
 * copy compares, and says which of its own routes it just lost — the three facts
 * a human needs to stop guessing "failed upgrade".
 *
 * `skipped` is the evidence of another copy (the path was already registered);
 * `failed` is every other registration failure (a full route table, a broken
 * runtime). Both lose a route, but only one of them is about a second copy, so
 * they are reported apart — a mixed-up line sends the human hunting a duplicate
 * that is not there.
 *
 * @param {{
 *   ownName: string,
 *   ownVersion: string,
 *   responder: Awaited<ReturnType<typeof probeResponder>>,
 *   skipped: Array<{ path: string }>,
 *   failed?: Array<{ path: string, reason: string }>,
 *   routeCount: number,
 * }} input
 * @returns {string}
 */
function startupLine({ ownName, ownVersion, responder, skipped, failed = [], routeCount }) {
  const own = `本副本 ${ownName} ${ownVersion}`
  const parts = []

  if (responder.kind === 'answered') {
    // The name and version come from ANOTHER plugin's response, so they are
    // untrusted text: collapse whitespace (a newline would break "one line") and
    // bound the length before they reach the log.
    const name = plainText(responder.name)
    const version = plainText(responder.version)
    if (name === '' && version === '') {
      // The shape a copy older than 0.3.1 answers with: `host` was added to this
      // entry in 0.3.1, so its absence is the only version evidence there is.
      parts.push('/api/review.current 有人应答，但没有报出身份（这个入口从 0.3.1 起才带 host，对方很可能早于 0.3.1）')
      parts.push(`${own} 比它新`)
    } else {
      const who = name === '' ? '一个没有报出名字的插件' : name
      const reported = version === '' ? '（没有报出版本）' : version
      parts.push(`/api/review.current 的应答者是 ${who} ${reported}`)
      const relation = compareVersions(version, ownVersion)
      parts.push(
        relation === 'older' ? `${own} 比它新`
        : relation === 'newer' ? `${own} 比它旧`
        : relation === 'same' ? `${own} 与它同版`
        : `${own} 无法与它比版本`,
      )
    }
  } else if (responder.kind === 'silent') {
    parts.push('/api/review.current 没有人报出身份（对方可能早于这个入口）')
    parts.push(own)
  } else {
    parts.push(`这个运行时没有进程内问身份的办法（${responder.reason}）`)
    parts.push(own)
  }

  if (skipped.length > 0) {
    const names = skipped.map((entry) => entry.path.replace('/api/', '')).join('、')
    parts.push(`重复的 ${skipped.length}/${routeCount} 条入口已从本副本跳过（${names}）`)
    parts.push('侧栏会少功能，请只留一份副本')
  } else if (failed.length === 0) {
    parts.push('运行时没有拒绝重复注册，无法确认最终由谁应答')
    parts.push('请只留一份副本')
  }
  if (failed.length > 0) {
    // The reason comes from the runtime, so it is untrusted text too: one line
    // stays one line, bounded, even when the runtime's message is not.
    const names = failed
      .map((entry) => `${entry.path.replace('/api/', '')}：${plainText(entry.reason)}`)
      .join('、')
    parts.push(`${failed.length}/${routeCount} 条入口注册失败（${names}）`)
    parts.push('侧栏会少功能，原因见这一条')
  }

  return `${RECONCILE_PREFIX}${parts.join('；')}。`
}

export { isConflict, probeResponder, startupLine }
