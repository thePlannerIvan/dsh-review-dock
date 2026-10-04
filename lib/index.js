/**
 * Host half of dsh-review-dock.
 *
 * This plugin owns four things and nothing else:
 *
 *   1. which surface is being reviewed   `review_open` + /api/review.current
 *   2. showing that surface's own page   /api/review.page (bridge injected)
 *   3. moving the bytes that page asks for   /api/review.bridge, /api/review.asset
 *   4. recording a decision and waking the model   /api/review.write, /api/review.wake
 *
 * It knows nothing about what is being reviewed. All of that vocabulary lives in
 * the surface's own `review-surface.json`, which this file reads for exactly four
 * things: `dir` to serve from, `entry` to serve, `feedback` to append to, and
 * `wake` to say to the model. There is no unit, no page, no version, and no
 * review UI on this side of the seam.
 *
 * Every route sits under Connection's `/api` fence, so the browser-trust check and
 * the Session cookie run before a handler does. The surface frame is an OPAQUE
 * origin and cannot use these routes itself — measured on Chromium, its
 * subresource requests arrive as `Sec-Fetch-Site: cross-site` with no cookie and
 * are refused 403 before authentication. The parent page (same origin, cookie
 * present) is the only caller; it relays bytes into the frame over postMessage
 * and the frame builds its own blob URLs.
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package identity, reported to the loader. */
const name = 'dsh-review-dock'

/** Hard dependency: without the tool registry there is no way in. */
const inject = ['tools']

// ── the surface bridge ──────────────────────────────────────────────────────
//
//   GET  /api/review.current                      → the surface the tool last opened
//   GET  /api/review.surface?surface=<abs json>   → its meta (id/title/capabilities/wake mode)
//   GET  /api/review.page?surface=<abs json>      → its entry HTML, with the bridge injected
//   GET  /api/review.bridge                       → the public module's review-bridge.js
//   GET  /api/review.asset?surface=<abs json>&rel= → one file inside the surface `dir`
//   POST /api/review.write                        → append a payload to the surface feedback file
//   POST /api/review.wake                         → admit one prompt into the submitting Session
const ROUTE_CURRENT = '/api/review.current'
const ROUTE_SURFACE = '/api/review.surface'
const ROUTE_PAGE = '/api/review.page'
const ROUTE_BRIDGE = '/api/review.bridge'
const ROUTE_ASSET = '/api/review.asset'
const ROUTE_WRITE = '/api/review.write'
const ROUTE_WAKE = '/api/review.wake'
const ROUTE_UPLOAD = '/api/review.upload'

/**
 * The one marker a surface entry must contain. A page served without the bridge
 * is a dead review page, so the page route refuses rather than serve one.
 */
const BRIDGE_PLACEHOLDER = '{{REVIEW_BRIDGE}}'

/**
 * What this Host actually calls on the bridge. A surface page is dead without
 * every one of these, and the failure mode is silence: an older bridge copy
 * simply never fires the callback. A stale published copy has already won once,
 * so a bridge is checked before it is inlined and refused if it is incomplete.
 * The check is textual — it asks whether the file even mentions the surface of
 * the API, not whether the implementation is correct.
 */
const BRIDGE_API = ['connect', 'VERSION', 'asset', 'read', 'readText', 'write', 'wake', 'upload', 'on']

/**
 * Names this bridge source does not appear to provide.
 * @param source - the bridge file's text.
 * @returns the missing names, in BRIDGE_API order.
 */
function missingBridgeApi(source) {
  return BRIDGE_API.filter((name) => !new RegExp(`\\b${name}\\b`).test(source))
}

/** The public module that owns the bridge, and where we look for it. */
const REVIEW_CORE_PACKAGE = 'planners-review-core'
const BRIDGE_RELATIVE = ['assets', 'review-bridge.js']

/**
 * The write that a later wake belongs to, keyed by (session, surface).
 *
 * The wake identity must be unique per SUBMISSION, not per (unit, text): a page's
 * whole-batch submit always sends the same sentence, so a text-derived id made
 * every resubmit look like a duplicate of the first one. The Host dedups prompts
 * by requestId and reports success WITHOUT delivering on a hit, so that silently
 * swallowed the notification (measured: the second batch submit produced no event
 * at all and still answered `accepted: true`). The feedback payload is different on
 * every submit — the page stamps `provenance.submitted_at` and fresh item ids — so
 * folding its hash in makes the id unique per submission while staying stable for a
 * retry of the SAME submission, which is what makes the retry idempotent.
 */
const lastSubmission = new Map()

/**
 * The part of a feedback payload that says WHICH submission this is.
 *
 * Hashing the payload verbatim contradicted the rule above: a page re-stamps the
 * bookkeeping fields on every `collect()` — `provenance.submitted_at`, the
 * `provenance.wake` receipt, and a fresh `uid()` per item — so a retry, a
 * reconnect, or a re-post of the very same submission produced a NEW hash, was
 * not recognised as the same submission, and woke the model a second time. That
 * is a delivered-twice bug the dedup was supposed to make impossible.
 *
 * These three fields are transport bookkeeping, not content: the verdict, the
 * words, the annotations, the assets and the per-page versions all stay in the
 * hash, so a genuinely different submission still gets a different identity.
 */
function submissionIdentity(payload) {
  if (payload === null || typeof payload !== 'object') return payload ?? null
  const copy = { ...payload }
  if (copy.provenance !== null && typeof copy.provenance === 'object') {
    const provenance = { ...copy.provenance }
    delete provenance.submitted_at
    delete provenance.wake
    copy.provenance = provenance
  }
  if (Array.isArray(copy.items)) {
    copy.items = copy.items.map((item) => {
      if (item === null || typeof item !== 'object') return item
      const { id: _id, ...rest } = item
      return rest
    })
  }
  return copy
}

/** Identity of one submission: its content, with the volatile stamps removed. */
function submissionOf(sessionId, surfaceFile, payload) {
  return createHash('sha256')
    .update(`${sessionId}\u0000${surfaceFile}\u0000${JSON.stringify(submissionIdentity(payload))}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * What this Host can actually DO, as opposed to what a surface declares.
 *
 * `capabilities` on the wire means "what really works on this surface right now",
 * so it is the intersection of the two. `asset-upload` is deliberately absent:
 * the bridge call is passed through but not implemented (it answers with an
 * explicit rejection so a page can degrade), and advertising it would put an
 * upload control on the page that is guaranteed to fail. It joins this list the
 * day the upload side is real.
 *
 * The no-plugin host (`serve-review.mjs`) reports its own supported list instead
 * of intersecting; same fields, and that difference is why this is written down.
 */
const HOST_CAPABILITIES = ['asset-upload']

/**
 * The capabilities a page may rely on: declared by the surface AND supported here.
 * @param declared - the surface's `capabilities` array, unvalidated.
 * @returns the intersection, in the order the surface declared them.
 */
function usableCapabilities(declared) {
  const list = Array.isArray(declared) ? declared.filter((value) => typeof value === 'string') : []
  return list.filter((value) => HOST_CAPABILITIES.includes(value))
}

/** Content types the asset route will serve. Anything else ships as octet-stream. */
const ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
}

/** How often the panel asks whether the Agent has opened a different surface. */
const CURRENT_POLL_MS = 2000

function apiJson(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function apiText(status, text, type) {
  return new Response(text, {
    status,
    headers: { 'content-type': type ?? 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function isFile(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * Read and shape-check one `review-surface.json`. The Host deliberately knows
 * only these fields: it serves `dir` and `entry`, writes `feedback` verbatim,
 * and says `wake` to the model. Everything
 * about what is being reviewed belongs to the Skill.
 * @param surfacePath - absolute path of the surface file.
 * @returns the resolved surface, or throws a message the route returns as 400.
 */
async function loadSurface(surfacePath) {
  if (typeof surfacePath !== 'string' || surfacePath === '' || !isAbsolute(surfacePath)) {
    throw new Error('surface 必须是 review-surface.json 的绝对路径')
  }
  if (!(await isFile(surfacePath))) throw new Error(`surface 文件不存在：${surfacePath}`)
  let data
  try {
    data = JSON.parse(await readFile(surfacePath, 'utf8'))
  } catch (error) {
    throw new Error(`surface 不是合法 JSON：${error?.message ?? String(error)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('surface 必须是一个 JSON 对象')
  }
  const base = dirname(surfacePath)
  const dir = resolve(base, String(data.dir ?? '.'))
  const entry = String(data.entry ?? '')
  if (entry === '' || isAbsolute(entry)) throw new Error('surface.entry 必须是 dir 内的相对路径')
  const feedback = typeof data.feedback === 'string' && data.feedback !== '' ? resolve(base, data.feedback) : ''
  const projectRoot =
    typeof data.project_root === 'string' && data.project_root !== '' ? resolve(base, data.project_root) : ''
  // `watch` is a list of paths RELATIVE TO THIS FILE whose metadata decides when
  // to poke the page. The Host reads mtime and size and nothing else — it still
  // does not know what changed, only that something did.
  const watch = Array.isArray(data.watch)
    ? data.watch.filter((value) => typeof value === 'string' && value !== '')
    : []
  return { file: surfacePath, base, data, dir, entry, feedback, projectRoot, watch }
}

/**
 * Prove `rel` would land inside `root` even though the target may not exist yet
 * — a render the page is waiting for is exactly the file that is not there on
 * the first poll. Lexical containment plus, when the path does resolve, a
 * realpath check so a symlinked ancestor cannot escape.
 * @returns the absolute candidate path, or null.
 */
async function containInside(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) return null
  const realRoot = await realpath(root).catch(() => null)
  if (realRoot === null) return null
  const candidate = resolve(realRoot, rel)
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) return null
  const real = await realpath(candidate).catch(() => null)
  if (real !== null && real !== realRoot && !real.startsWith(realRoot + sep)) return null
  return candidate
}

/**
 * Resolve `rel` under `root` and prove the real target is still inside `root`
 * after symlinks. Escape and absence are reported separately so the routes can
 * answer 403 and 404 without leaking which one happened.
 * @returns `{ ok: true, real }` or `{ ok: false, reason: 'escape' | 'missing' }`.
 */
async function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) {
    return { ok: false, reason: 'escape' }
  }
  const realRoot = await realpath(root).catch(() => null)
  if (realRoot === null) return { ok: false, reason: 'missing' }
  const candidate = resolve(realRoot, rel)
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) return { ok: false, reason: 'escape' }
  const real = await realpath(candidate).catch(() => null)
  if (real === null) return { ok: false, reason: 'missing' }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, reason: 'escape' }
  if (!(await isFile(real))) return { ok: false, reason: 'missing' }
  return { ok: true, real }
}

/**
 * The public module that owns `review-bridge.js`. It is a Skill on disk, not a
 * dependency of this plugin, so the location is discovered rather than imported.
 * `DSH_REVIEW_CORE_DIR` (or the row's `reviewCoreDir` config) wins; otherwise the
 * conventional Skill mounts are tried, then a dev checkout next to this plugin.
 * @returns absolute candidate directories, most specific first.
 */
function reviewCoreCandidates(configured) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '') out.push(resolve(value))
  }
  push(configured)
  push(process.env.DSH_REVIEW_CORE_DIR)
  push(join(homedir(), '.dsh', 'skills', REVIEW_CORE_PACKAGE))
  push(join(homedir(), '.claude', 'skills', REVIEW_CORE_PACKAGE))
  push(join(homedir(), '.agents', 'skills', REVIEW_CORE_PACKAGE))
  push(join(homedir(), '.gemini', 'config', 'skills', REVIEW_CORE_PACKAGE))
  // A dev checkout: walk up from this file looking for the library layout.
  let here = fileURLToPath(new URL('.', import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    push(join(here, '02-skills-library', '00-system', REVIEW_CORE_PACKAGE))
    const parent = dirname(here)
    if (parent === here) break
    here = parent
  }
  return [...new Set(out)]
}

/**
 * Resolve `assets/review-bridge.js` in the public module.
 *
 * Every installed copy is a PUBLISHED copy and the library checkout is the
 * source of truth, so they disagree the moment anyone edits the bridge (measured:
 * `~/.claude/skills` was five bytes and eight minutes behind the checkout, and a
 * first-match-wins search silently served the older one to the page). The bridge
 * is a document that gets edited in place, so the freshest existing copy wins and
 * a disagreement is worth saying out loud.
 * @returns `{ file, candidates }` with `file === null` when nothing was found.
 */
async function resolveBridgeFile(configured) {
  const candidates = []
  for (const dir of reviewCoreCandidates(configured)) {
    const candidate = join(dir, ...BRIDGE_RELATIVE)
    const info = await stat(candidate).catch(() => null)
    if (info !== null && info.isFile()) candidates.push({ file: candidate, mtimeMs: info.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return { file: candidates.length === 0 ? null : candidates[0].file, candidates }
}

/**
 * GET /api/review.bridge — the public module's bridge, served to the surface
 * page through the injected placeholder. Read per request (no cache) because
 * the module is edited in place while the plugin stays mounted.
 */
async function handleReviewBridge(request, bridgeFile) {
  if (bridgeFile === null) {
    return apiJson(500, {
      error: `找不到 ${REVIEW_CORE_PACKAGE}/${BRIDGE_RELATIVE.join('/')}；设置 DSH_REVIEW_CORE_DIR 或该行的 reviewCoreDir`,
    })
  }
  const bytes = await readFile(bridgeFile)
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * GET /api/review.surface — the meta the parent page needs before the frame
 * connects: what to call the tab, and which capabilities to hand the page in
 * `init`. Nothing here interprets the review's content.
 */
async function handleReviewSurface(request) {
  const url = new URL(request.url)
  let surface
  try {
    surface = await loadSurface(url.searchParams.get('surface') || '')
  } catch (error) {
    return apiJson(400, { ok: false, error: error?.message ?? String(error) })
  }
  const data = surface.data
  const wake = data.wake !== null && typeof data.wake === 'object' ? data.wake : {}
  return apiJson(200, {
    ok: true,
    surface: {
      id: typeof data.id === 'string' ? data.id : '',
      title: typeof data.title === 'string' ? data.title : '',
      description: typeof data.description === 'string' ? data.description : '',
      contractVersion: typeof data.contract_version === 'string' ? data.contract_version : '',
      entry: surface.entry,
      capabilities: usableCapabilities(data.capabilities),
      wakeMode: wake.mode === 'steer' ? 'steer' : 'queue',
      hasFeedback: surface.feedback !== '',
    },
  })
}

/**
 * GET /api/review.page — the surface's entry HTML with its `{{REVIEW_BRIDGE}}`
 * placeholder replaced by this Host's bridge route. The bridge is served from
 * the route rather than copied into the surface because in plugin mode the page
 * address IS a route: a relative reference in the page would 404.
 */
async function handleReviewPage(request, bridgeFile) {
  const url = new URL(request.url)
  let surface
  try {
    surface = await loadSurface(url.searchParams.get('surface') || '')
  } catch (error) {
    return apiJson(400, { error: error?.message ?? String(error) })
  }
  const resolved = await resolveInside(surface.dir, surface.entry)
  if (!resolved.ok) {
    return apiJson(resolved.reason === 'escape' ? 403 : 404, {
      error: `entry 不在 dir 内或不存在：${surface.entry}`,
    })
  }
  const bytes = await readFile(resolved.real)
  let html
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return apiJson(415, { error: `entry 不是 UTF-8 文本，无法注入桥：${surface.entry}` })
  }
  if (!html.includes(BRIDGE_PLACEHOLDER)) {
    // Refusing beats serving a page that can never reach its Host.
    return apiJson(409, {
      error: `entry 缺少 ${BRIDGE_PLACEHOLDER} 注入点：${surface.entry}`,
    })
  }
  if (bridgeFile === null) {
    return apiJson(500, {
      error: `找不到 ${REVIEW_CORE_PACKAGE}/${BRIDGE_RELATIVE.join('/')}；设置 DSH_REVIEW_CORE_DIR 或该行的 reviewCoreDir`,
    })
  }
  // MEASURED, do not "simplify" this back to a URL: the surface frame is an
  // opaque origin, and Chromium sends its subresource requests to `/api/*` as
  // `Sec-Fetch-Site: cross-site` with no cookie. The trust fence answers 403
  // before authentication, so `<script src="/api/review.bridge">` never loads —
  // exactly like the asset images. The bridge therefore travels INLINE, the same
  // way assets travel as postMessage bytes. The `/api/review.bridge` route stays
  // as the bridge's named address (the no-plugin host and diagnostics use it);
  // it is simply not what the frame fetches.
  const raw = await readFile(bridgeFile, 'utf8')
  const missing = missingBridgeApi(raw)
  if (missing.length > 0) {
    // Refuse loudly. Inlining a bridge that cannot answer `read` gives the human
    // a page that looks fine and never updates — the worst outcome available.
    return apiJson(500, {
      error: `这份 review-bridge.js 缺少本宿主依赖的方法：${missing.join(', ')}`,
      bridge: bridgeFile,
      missing,
    })
  }
  const source = raw.replaceAll('</script', '<\\/script')
  const inline = `<script>\n${source}\n</script>`
  // Three page shapes reach this route, and every one of them must end up with a
  // COMPLETE `<script>` around the bridge:
  //
  //   bare marker, alone on its line   the contract's canonical shape
  //   <script src="{{REVIEW_BRIDGE}}"></script>   older pages, and our own fixture
  //   <script>{{REVIEW_BRIDGE}}</script>          older pages
  //
  // The two element shapes are replaced whole — swapping only the marker inside
  // them would nest one script in another. The bare marker is replaced BY a full
  // `<script>`: emitting bare source into the body is not a script at all, so the
  // bridge never runs and the page dies silently, which is the worst outcome here.
  const srcElement = /<script\b[^>]*\bsrc\s*=\s*["']\{\{REVIEW_BRIDGE\}\}["'][^>]*>\s*<\/script>/i
  const inlineElement = /<script\b[^>]*>\s*\{\{REVIEW_BRIDGE\}\}\s*<\/script>/i
  let injected
  if (srcElement.test(html)) injected = html.replace(srcElement, inline)
  else if (inlineElement.test(html)) injected = html.replace(inlineElement, inline)
  else injected = html.replaceAll(BRIDGE_PLACEHOLDER, inline)
  return new Response(injected, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** GET /api/review.asset — one file inside the surface `dir`, realpath-checked. */
async function handleReviewAsset(request) {
  const url = new URL(request.url)
  let surface
  try {
    surface = await loadSurface(url.searchParams.get('surface') || '')
  } catch (error) {
    return apiJson(400, { error: error?.message ?? String(error) })
  }
  const rel = url.searchParams.get('rel') || ''
  const resolved = await resolveInside(surface.dir, rel)
  if (!resolved.ok) {
    return apiText(
      resolved.reason === 'escape' ? 403 : 404,
      resolved.reason === 'escape' ? 'asset 越出 surface dir，拒绝服务' : 'asset 不存在',
    )
  }
  const bytes = await readFile(resolved.real)
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': ASSET_MIME[extname(resolved.real).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  })
}

/**
 * POST /api/review.write — write the payload into the surface's own feedback
 * file, VERBATIM. The surface defines that file's shape, so the Host adds
 * nothing to it: no timestamp, no envelope, no interpretation. The file must
 * parse back deep-equal to what the page sent, and byte-equal to what the
 * no-plugin host would have written.
 */
async function handleReviewWrite(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return apiJson(400, { error: '请求体不是合法 JSON' })
  }
  let surface
  try {
    surface = await loadSurface(String(body?.surface ?? ''))
  } catch (error) {
    return apiJson(400, { error: error?.message ?? String(error) })
  }
  if (surface.feedback === '') {
    return apiJson(409, { error: 'surface 没有声明 feedback，这个面不落反馈文件' })
  }
  const guardRoot = surface.projectRoot === '' ? surface.base : surface.projectRoot
  const realGuard = await realpath(guardRoot).catch(() => null)
  if (realGuard === null) {
    return apiJson(400, { error: `project_root 不存在：${guardRoot}` })
  }
  if (surface.feedback !== realGuard && !surface.feedback.startsWith(realGuard + sep)) {
    return apiJson(403, { error: 'feedback 越出 project_root，拒绝写入' })
  }
  // The payload IS the file. The surface defines its shape, so the Host must not
  // wrap it, stamp it, or interpret it — a single added `{receivedAt, payload}`
  // envelope is enough to make the producing Skill unable to read back its own
  // review, and that is exactly what happened the first time a human used this.
  // The no-plugin host writes `JSON.stringify(payload, null, 2)` and so do we;
  // the two hosts must produce byte-identical files from the same payload.
  if (!Object.hasOwn(body, 'payload')) {
    return apiJson(400, { error: '请求体缺少 payload' })
  }
  await mkdir(dirname(surface.feedback), { recursive: true })
  await writeFile(surface.feedback, `${JSON.stringify(body.payload, null, 2)}\n`, 'utf8')
  const sessionId = String(body?.sessionId ?? '')
  if (sessionId !== '') {
    lastSubmission.set(`${sessionId}\u0000${surface.file}`, submissionOf(sessionId, surface.file, body.payload))
  }
  return apiJson(200, { ok: true, path: surface.feedback })
}

/**
 * POST /api/review.wake — admit one prompt into the submitting Session, using
 * the surface's own `wake.mode` and `wake.text` (`{unit}` substituted). The
 * Host owns no wording: a surface with no wake text is refused rather than
 * invented. Without a Session the call fails loudly; a review page must never
 * be told "sent" when nothing was sent.
 * @param ctx - plugin context carrying `sessionController`.
 * @param request - `{ surface, unit, sessionId }`.
 */
/** The newest event seq the session has right now, or -1 when it cannot be read. */
async function headSeq(ctx, sessionId) {
  try {
    const inspected = await ctx.get('sessionController').inspect(sessionId, new AbortController().signal)
    const events = Array.isArray(inspected?.events) ? inspected.events : []
    for (let at = events.length - 1; at >= 0; at -= 1) {
      const seq = events[at]?.seq
      if (typeof seq === 'number') return seq
    }
  } catch {
    /* an unreadable log only means the bound is unknown, which the caller handles */
  }
  return -1
}

/**
 * Did THIS call deliver? Answers with the strongest state it can prove, or null.
 *
 * The rule that matters: only evidence NEWER than `before` counts. A log-wide search
 * for the requestId cannot tell "this call queued it" from "an earlier identical call
 * did", and that ambiguity is what let a swallowed notification report success.
 *
 * @param ctx - plugin context, for the live agent and the session log.
 * @param sessionId - the session that was prompted.
 * @param requestId - identity this call prompted with.
 * @param before - newest event seq observed before the prompt.
 * @returns `{state, where, seq?, …}` or null when nothing new appeared.
 */
async function verifyWake(ctx, sessionId, requestId, before, expectText) {
  const textOf = (parts) =>
    Array.isArray(parts) ? parts.map((part) => String(part?.text ?? '')).join('') : ''
  const sameRequest = (message) =>
    message?.source?.kind === 'user' && message?.source?.rpcId === requestId
  const pendingOf = () => {
    try {
      const agent = ctx.get('agents')?.get(sessionId)
      const inbox = agent?.inbox
      return [...(inbox?.nextTurn ?? []), ...(inbox?.nextStep ?? [])]
    } catch {
      return []
    }
  }
  const logOf = async () => {
    try {
      const inspected = await ctx.get('sessionController').inspect(sessionId, new AbortController().signal)
      return Array.isArray(inspected?.events) ? inspected.events : []
    } catch {
      return []
    }
  }
  // A turn claims the message before it appends `user/message`, so for a few
  // milliseconds the requestId is in neither place. Re-check rather than cry wolf.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200))
    const waiting = pendingOf().find(sameRequest)
    if (waiting !== undefined) {
      const queuedText = textOf(waiting.content)
      return {
        state: 'queued', where: 'agents.get(sessionId).inbox', requestId,
        text: queuedText.slice(0, 240), equalsWakeText: queuedText.trim() === expectText,
      }
    }
    const events = await logOf()
    for (let at = events.length - 1; at >= 0; at -= 1) {
      const event = events[at]
      if (typeof event?.seq === 'number' && event.seq <= before) break
      if (event?.type === 'user/message' && sameRequest(event?.data)) {
        const said = textOf(event?.data?.content)
        return {
          state: 'in-turn', where: 'session log: user/message', seq: event.seq,
          requestId, text: said.slice(0, 240), equalsWakeText: said.trim() === expectText,
        }
      }
      if (event?.type !== 'agent/inbox/spliced') continue
      const inserted = event?.data?.inserted
      const hit = Array.isArray(inserted) ? inserted.find(sameRequest) : undefined
      if (hit === undefined) continue
      const spliced = textOf(hit.content)
      return {
        state: 'queued', where: 'session log: agent/inbox/spliced', seq: event.seq,
        target: event?.data?.target ?? null, requestId, text: spliced.slice(0, 240),
        equalsWakeText: spliced.trim() === expectText,
      }
    }
  }
  // Nothing new. If the id exists ANYWHERE older, the Host deduplicated this call.
  const stale = pendingOf().find(sameRequest)
  if (stale !== undefined) return { state: 'duplicate', where: 'agents.get(sessionId).inbox', requestId }
  const events = await logOf()
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]
    if (event?.type === 'user/message' && sameRequest(event?.data)) {
      return { state: 'duplicate', where: 'session log: user/message', seq: event.seq, requestId, before }
    }
    if (event?.type !== 'agent/inbox/spliced') continue
    const inserted = event?.data?.inserted
    const hit = Array.isArray(inserted) ? inserted.find(sameRequest) : undefined
    if (hit !== undefined) {
      return { state: 'duplicate', where: 'session log: agent/inbox/spliced', seq: event.seq, requestId, before }
    }
  }
  return null
}

async function handleReviewWake(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return apiJson(400, { ok: false, error: '请求体不是合法 JSON' })
  }
  let surface
  try {
    surface = await loadSurface(String(body?.surface ?? ''))
  } catch (error) {
    return apiJson(400, { ok: false, error: error?.message ?? String(error) })
  }
  const sessionId = String(body?.sessionId ?? '')
  if (sessionId === '') {
    return apiJson(400, { ok: false, error: '面板没有 sessionId（不在会话里），无法唤醒模型' })
  }
  const controller = ctx.get('sessionController')
  if (controller === undefined) {
    return apiJson(409, { ok: false, error: 'sessionController 不可用，无法唤醒模型' })
  }
  const wake = surface.data.wake
  if (wake === null || typeof wake !== 'object' || typeof wake.text !== 'string') {
    return apiJson(409, { ok: false, error: 'surface 没有声明 wake.text' })
  }
  const unit = String(body?.unit ?? '')
  // The page may submit a whole batch, and then the surface's per-unit template
  // is the wrong sentence ("整套 已定；只重出这一页" — self-contradictory). The
  // contract is: a page-provided `text` replaces the template outright; the
  // template is only the fallback, with `{unit}` substituted. This mirrors
  // `serve-review.mjs`, since a page must get the same sentence either way.
  const template = typeof body?.text === 'string' && body.text !== '' ? body.text : wake.text
  const text = template.replace('{unit}', unit).trim()
  if (text === '') {
    return apiJson(409, { ok: false, error: '唤醒文案为空，拒绝发一句空话' })
  }
  const mode = wake.mode === 'steer' ? 'steer' : 'queue'
  // The identity of THIS submission. A wake that followed a write borrows that
  // submission's identity, so a resubmit is a new identity and a retry is the same
  // one. A wake with no write behind it gets a fresh identity per call: there is no
  // submission to be idempotent about, and never silently deduplicating matters more.
  const submission = lastSubmission.get(`${sessionId}\u0000${surface.file}`)
  const seed = [
    sessionId, surface.file, unit, text,
    submission ?? `no-write:${randomUUID()}`,
  ].join('\u0000')
  const requestId = `review-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
  // Anything at or below this seq existed BEFORE this call, so it can never be
  // evidence that this call delivered. (Without the bound, a deduplicated prompt
  // finds the PREVIOUS message with the same id and reports success — a false green
  // that hid exactly the failure this code is here to catch.)
  const before = await headSeq(ctx, sessionId)
  try {
    await controller.prompt(
      { requestId, sessionId, mode, content: [{ type: 'text', text }] },
      new AbortController().signal,
    )
  } catch (error) {
    return apiJson(502, { ok: false, state: 'undelivered', requestId, error: `唤醒失败：${error?.message ?? String(error)}` })
  }
  // "accepted" is the Host's word. The evidence is the message itself, found by the
  // requestId we generated — but only if it is NEWER than this call. The states are
  // deliberately distinct: `in-turn` (a turn actually took it), `queued` (it is in
  // the durable queue, no turn yet), `duplicate` (an earlier call already delivered
  // exactly this submission, so this one added nothing) and `undelivered`.
  const verdict = await verifyWake(ctx, sessionId, requestId, before, text)
  if (verdict === null) {
    return apiJson(502, {
      ok: false,
      state: 'undelivered',
      requestId,
      error: '宿主接受了这次 prompt，但日志里没有任何新消息：它把这次调用当成同一个 requestId 的重复而丢掉了',
      verified: { where: 'nowhere', requestId, before },
    })
  }
  if (verdict.state === 'duplicate') {
    return apiJson(409, {
      ok: false,
      state: 'duplicate',
      requestId,
      error: '这一次提交之前已经送达过（同一次提交重发）；本次调用没有新增通知',
      verified: verdict,
    })
  }

  return apiJson(200, {
    ok: true,
    state: verdict.state,
    requestId,
    sessionId,
    mode,
    text,
    textFrom: typeof body?.text === 'string' && body.text !== '' ? 'page' : 'surface.wake.text',
    verified: verdict,
  })
}

/**
 * Bytes one upload may carry. The no-plugin host has no cap of its own — its only
 * bound is the connection layer's 300 MiB — and that is a gap, not a model: these
 * bytes also travel through the panel as a postMessage payload, so the parent page
 * and the frame each hold a copy. 16 MiB is several times a 1920×1080 PNG, and it
 * still bounds what one page can push in a single call.
 */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

/**
 * Resolve a path that does NOT exist yet, for writing, with the same containment
 * `asset` enforces for reading — plus the two things a write needs on top:
 *
 *   - the deepest EXISTING ancestor must itself be inside `dir` once resolved, so
 *     a symlinked directory inside `dir` cannot place a new file outside it;
 *   - an existing target must not be a symlink at all (writing through one would
 *     write somewhere the containment check never authorized).
 *
 * @returns the absolute target path, or null when writing there is refused.
 */
async function containNewFile(root, rel) {
  const candidate = await containInside(root, rel)
  if (candidate === null) return null
  const existing = await lstat(candidate).catch(() => null)
  if (existing !== null && existing.isSymbolicLink()) return null
  const realRoot = await realpath(root).catch(() => null)
  if (realRoot === null) return null
  let ancestor = dirname(candidate)
  while (ancestor !== dirname(ancestor) && (await stat(ancestor).catch(() => null)) === null) {
    ancestor = dirname(ancestor)
  }
  const realAncestor = await realpath(ancestor).catch(() => null)
  if (realAncestor === null) return null
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) return null
  return candidate
}

/**
 * POST /api/review.upload?surface=<abs json>&rel=<path inside dir>
 *
 * The bridge hands over `{ rel, name, bytes }`; the bytes are the raw body here.
 * The target is resolved against the surface's `dir` — the same basis the page
 * writes into the feedback document and the same basis the receiving layer reads
 * it back with (`import-review-assets.mjs` does `resolve(dirname(feedbackPath), path)`),
 * so what is uploaded is exactly what can be collected. Mirrors the no-plugin
 * host's upload, and reports every refusal instead of failing quietly.
 */
async function handleReviewUpload(request) {
  const url = new URL(request.url)
  let surface
  try {
    surface = await loadSurface(url.searchParams.get('surface') || '')
  } catch (error) {
    return apiJson(400, { ok: false, error: error?.message ?? String(error) })
  }
  // A capability is a promise in both directions: a surface that never declared
  // this one must not be able to upload through a direct call either. The bridge
  // already refuses inside the frame; this is what makes the refusal authoritative.
  if (!usableCapabilities(surface.data.capabilities).includes('asset-upload')) {
    return apiJson(403, { ok: false, error: '这个 surface 没有声明 asset-upload 能力，拒绝上传' })
  }
  const rel = url.searchParams.get('rel') || ''
  if (rel === '') return apiJson(400, { ok: false, error: '缺少 rel' })
  const target = await containNewFile(surface.dir, rel)
  if (target === null) {
    return apiJson(403, { ok: false, error: '上传目标落在 dir 之外（或经过符号链接），拒绝写入' })
  }
  let bytes
  try {
    bytes = Buffer.from(await request.arrayBuffer())
  } catch (error) {
    return apiJson(400, { ok: false, error: `读取上传内容失败：${error?.message ?? String(error)}` })
  }
  if (bytes.length === 0) return apiJson(400, { ok: false, error: '上传内容为空' })
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return apiJson(413, {
      ok: false,
      error: `上传超过上限：${bytes.length} 字节 > ${MAX_UPLOAD_BYTES} 字节（16 MiB）`,
      limit: MAX_UPLOAD_BYTES,
      bytes: bytes.length,
    })
  }
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  } catch (error) {
    return apiJson(500, { ok: false, error: `写入失败：${error?.message ?? String(error)}` })
  }
  // Same shape the no-plugin host returns, plus the size (the pages read `sha256`).
  return apiJson(200, {
    ok: true,
    path: target,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  })
}

/**
 * GET /api/review.current — the surface `review_open` last asked to show.
 *
 * This exists because there is no Host→browser push channel yet: the review
 * panel polls it and claims its tab. B8.4c replaces this with the SSE
 * `review/changed` frame; until then it is the whole "Agent brings the human to
 * the panel" path, and it costs one request for a small in-memory object.
 */
/**
 * One token over the WATCHED files' metadata. Absence is a value too: the first
 * time a render appears the token changes, which is exactly the poke the page
 * needs. Contents are never read.
 * @returns a short digest, or '' when this surface watches nothing.
 */
async function watchToken(current) {
  if (current.watch.length === 0) return ''
  const parts = []
  for (const entry of current.watch) {
    try {
      const info = await stat(entry.absolute)
      parts.push(`${entry.rel}\u0000${String(info.mtimeMs)}\u0000${String(info.size)}`)
    } catch {
      parts.push(`${entry.rel}\u0000absent`)
    }
  }
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16)
}

async function handleReviewCurrent(current) {
  const token = await watchToken(current)
  if (current.surface !== '') {
    if (current.token === null) current.token = token
    else if (token !== current.token) {
      // Metadata moved: step the counter exactly once per distinct state. The
      // panel turns a step into one `review/changed` poke and nothing else —
      // no payload, no reload, no touching what the human has typed.
      current.token = token
      current.changedSeq += 1
    }
  }
  return apiJson(200, {
    ok: true,
    surface: current.surface,
    revision: current.revision,
    changedSeq: current.changedSeq,
    watching: current.watch.length,
    pollMs: CURRENT_POLL_MS,
  })
}

function apply(ctx, config) {
  /**
   * The surface the tool last asked to show, a counter the panel watches for
   * "a different surface", and a second counter it watches for "the bytes this
   * one depends on moved". Both travel on `/api/review.current`; neither needs a
   * new route, and neither exists without the authenticated fence around it.
   */
  const current = { surface: '', revision: 0, changedSeq: 0, token: null, watch: [] }

  ctx.inject(['connection'], (bridgeCtx) => {
    const register = bridgeCtx.connection.fetch.register
    // Resolved once per activation and awaited by the routes, so a request that
    // arrives first still gets the bridge rather than a 500.
    let bridgeLookup = null
    const bridgeFileOf = async () => {
      bridgeLookup ??= resolveBridgeFile(config?.reviewCoreDir)
      const choice = await bridgeLookup
      if (choice.candidates.length > 1 && !bridgeWarned) {
        bridgeWarned = true
        bridgeCtx.logger?.warn?.(
          `dsh-review-dock: ${String(choice.candidates.length)} 份 review-bridge.js 并存，用最新的一份：${String(choice.file)}`,
        )
      }
      return choice.file
    }
    let bridgeWarned = false
    bridgeCtx.effect(
      () => {
        const disposers = [
          register({
            path: ROUTE_CURRENT,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: () => handleReviewCurrent(current),
          }),
          register({
            path: ROUTE_SURFACE,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: handleReviewSurface,
          }),
          register({
            path: ROUTE_PAGE,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async (request) => handleReviewPage(request, await bridgeFileOf()),
          }),
          register({
            path: ROUTE_BRIDGE,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async (request) => handleReviewBridge(request, await bridgeFileOf()),
          }),
          register({ path: ROUTE_ASSET, methods: ['GET'], requestBody: 'buffered', fetch: handleReviewAsset }),
          register({ path: ROUTE_WRITE, methods: ['POST'], requestBody: 'buffered', fetch: handleReviewWrite }),
          register({
            path: ROUTE_UPLOAD,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: handleReviewUpload,
          }),
          register({
            path: ROUTE_WAKE,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => handleReviewWake(bridgeCtx, request),
          }),
        ]
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-review-dock: /api/review.* bridge routes',
    )
    bridgeCtx.logger?.info?.(
      'dsh-review-dock: /api/review.current|surface|page|bridge|asset|write|upload|wake registered',
    )
  })

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      ctx.logger?.warn?.('dsh-review-dock: tools unavailable; the panel has no way in')
      return () => {}
    }
    return tools.register({
      name: 'review_open',
      description:
        '把一份审阅面（review-surface.json）挂到人类右侧栏的审阅标签页上，并替人类打开。'
        + '入参是 surface 文件的绝对路径；那份 surface 自己声明要显示哪棵树、入口 HTML、反馈写进哪个文件，'
        + '以及唤醒你时该说哪一句话。'
        + '调用后人类的 DSH 右侧栏会出现审阅页，人类在页面上下决定；'
        + '每一次提交都会作为一条新消息唤醒你，正文来自 surface 的 wake.text。'
        + '所以：产出方写出 surface 之后，调用本工具把审阅交给人类，然后等消息。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['surface'],
        properties: {
          surface: {
            type: 'string',
            description: 'review-surface.json 的绝对路径。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            surface: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            entry: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
            watching: { type: 'array', items: { type: 'string' } },
            warnings: { type: 'array', items: { type: 'string' } },
            bridge_ready: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => {
        const surfacePath = String(args?.surface || '').trim()
        const refuse = (message) => ({
          ok: false,
          message,
          surface: surfacePath,
          id: '',
          title: '',
          entry: '',
          capabilities: [],
          watching: [],
          warnings: [],
          bridge_ready: false,
        })
        if (surfacePath === '') return refuse('surface 不能为空')
        let surface
        try {
          surface = await loadSurface(surfacePath)
        } catch (error) {
          return refuse(error?.message ?? String(error))
        }
        // Preflight the two ways this can still be a dead tab, so the Agent hears
        // about it now instead of the human staring at a blank panel later.
        const resolved = await resolveInside(surface.dir, surface.entry)
        if (!resolved.ok) {
          return refuse(`entry 不在 dir 内或不存在：${surface.entry}`)
        }
        const { file: bridge } = await resolveBridgeFile(config?.reviewCoreDir)
        if (bridge === null) {
          return refuse(
            `找不到 ${REVIEW_CORE_PACKAGE}/${BRIDGE_RELATIVE.join('/')}；`
            + '设置 DSH_REVIEW_CORE_DIR 或本行的 reviewCoreDir',
          )
        }
        const missingApi = missingBridgeApi(await readFile(bridge, 'utf8'))
        if (missingApi.length > 0) {
          return refuse(`${bridge} 缺少本宿主依赖的方法：${missingApi.join(', ')}`)
        }
        // `watch` is relative to the SURFACE FILE — the schema, the validator, the
        // no-plugin host and `loadSurface` all say so. Resolving it against `dir`
        // instead put a subdirectory surface's `../timeline/timeline.json` in the
        // wrong place and produced a panel that opened "successfully" with a dead
        // change poke: a surface at `<project>/review/` watched `<project>/../…`.
        // Silent skipping is what made that invisible, so anything skipped is said
        // out loud — a hand-edited surface still opens, but never mutely.
        const watch = []
        const warnings = []
        for (const rel of surface.watch) {
          const target = resolve(surface.base, rel)
          const relToDir = relative(surface.dir, target)
          if (relToDir === '' || relToDir.startsWith('..') || isAbsolute(relToDir)) {
            warnings.push(
              `watch 项落在 surface.dir 之外，未监视（校验器会报 watch_outside_dir）：${rel}`
              + ` → ${target}`,
            )
            continue
          }
          const absolute = await containInside(surface.dir, relToDir)
          if (absolute === null) {
            warnings.push(`watch 项无法解析成 dir 内的真实路径，未监视：${rel}`)
            continue
          }
          watch.push({ rel, absolute })
        }
        current.surface = surface.file
        current.revision += 1
        current.changedSeq = 0
        current.token = null
        current.watch = watch
        const data = surface.data
        return {
          ok: true,
          message: '审阅页已在右侧栏打开。人类在页面上下决定；每一次提交你都会被唤醒。',
          surface: surface.file,
          id: typeof data.id === 'string' ? data.id : '',
          title: typeof data.title === 'string' ? data.title : '',
          entry: surface.entry,
          capabilities: usableCapabilities(data.capabilities),
          watching: watch.map((entry) => entry.rel),
          warnings,
          bridge_ready: true,
        }
      },
    })
  }, 'dsh-review-dock: review_open tool')

  ctx.logger?.info?.('dsh-review-dock: ready (surfaces under /api/review.*)')
}

export { apply, inject, name }
