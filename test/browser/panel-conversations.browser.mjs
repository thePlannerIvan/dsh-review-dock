/**
 * 真浏览器验收：A 对话开面、切到 B 看不见、切回 A 还在。
 *
 * 不是接缝，是验收。这一份搭的是最小侧栏：
 *
 *   - 真正的宿主：`apply()` 挂在假 ctx 上，路由接到真的 HTTP server 上；
 *   - 真正的状态机与转交：父页面加载 `lib/client.js` 本体，用它的
 *     `createPanel()`（observe / place / relay）与真宿主回话；
 *   - 假的宿主适配器：两个对话、一个「屏幕上」、每个对话自己的布局与挂载标签 ——
 *     这正是测试要摆布的那部分；
 *   - 真 Chromium：在 A 的页面里写字，切到 B（B 的栏里什么都没有），再切回 A，
 *     字还在、还是同一个文档、也没有多出第二个标签。
 *
 * 单独跑：
 *   NODE_PATH=$(npm root -g) node test/browser/panel-conversations.browser.mjs
 * 或由 test/panel-browser-acceptance.test.mjs 在 `node --test` 里调 `run()`。
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply } from '../../lib/index.js'
import { loadPlaywright } from './draft-reload.browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** The plugin's own sidebar module, served to the harness verbatim. */
const CLIENT = resolve(here, '../../lib/client.js')

const SESSION_A = 'session-A'
const SESSION_B = 'session-B'

const PAGE = `<!doctype html>
<html>
<body>
  <textarea id="note" placeholder="在这里写"></textarea>
  <div id="status">booting</div>
  <div id="born"></div>
  {{REVIEW_BRIDGE}}
  <script>
    (async () => {
      const status = document.getElementById('status')
      try {
        const review = await ReviewBridge.connect()
        window.__review = review
        // Proof that this document survived the conversation switch.
        window.__bornAt = String(Math.random())
        document.getElementById('born').textContent = window.__bornAt
        const surface = await review.readText('surface.json')
        status.textContent = typeof surface === 'string' && surface.length > 0 ? 'ready' : 'empty'
        window.__pageReady = true
      } catch (error) {
        status.textContent = 'failed: ' + error.message
      }
    })()
  </script>
</body>
</html>`

/** The parent page: a tiny sidebar that speaks to the real panel through a fake Host. */
function harness() {
  return `<!doctype html>
<html>
<body>
  <div id="column-A" data-session="${SESSION_A}"><h1>conversation A</h1><div class="tabs"></div></div>
  <div id="column-B" data-session="${SESSION_B}"><h1>conversation B</h1><div class="tabs"></div></div>
  <script>
    window.__ModuleLoader__ = {
      load(registration) {
        window.__client = registration.factory(() => ({ createElement() {} }))
      },
    }
  </script>
  <script src="/client.js"></script>
  <script>
    (() => {
      const client = window.__client
      const sessions = [${JSON.stringify(SESSION_A)}, ${JSON.stringify(SESSION_B)}]
      const layouts = new Map(sessions.map((sessionId) => [sessionId, []]))
      const seats = new Map()
      const frames = []
      const receipts = {}
      let onScreen = ${JSON.stringify(SESSION_A)}
      let nextTab = 1

      function columnOf(sessionId) {
        return document.getElementById(sessionId === ${JSON.stringify(SESSION_A)} ? 'column-A' : 'column-B')
      }

      function seatOf(sessionId) {
        let seat = seats.get(sessionId)
        if (seat === undefined) {
          seat = {
            surfaces: new Set(),
            placer: (kind, options) => {
              layouts.get(sessionId).push({ kind, id: 'tab-' + (nextTab++), params: options.params })
              render()
            },
          }
          seats.set(sessionId, seat)
        }
        return seat
      }

      const host = {
        onScreen: () => onScreen,
        reviewTabs: (sessionId) => layouts.get(sessionId).map((tab) => ({ kind: tab.kind })),
        mountedTabs: (sessionId) => {
          const seat = seats.get(sessionId)
          return {
            placer: seat?.placer,
            surfaces: new Set(seat === undefined ? [] : seat.surfaces),
            unbound: 0,
          }
        },
        reveal: () => {},
        openTab: (kind, options) => {
          if (!layouts.has(onScreen)) throw new Error('no conversation on screen')
          layouts.get(onScreen).push({ kind, id: 'tab-' + (nextTab++), params: options.params })
          render()
        },
      }

      // A copy of the plugin that predates /api/review.actions answers this one
      // route with a failure; the page must hear WHY.
      const noActions = new URLSearchParams(window.location.search).has('no-actions')
      const panel = client.createPanel({
        host,
        endpoint: (name) => new URL('api/' + name, window.location.href).href,
        fetch: (url, init) => (noActions && String(url).includes('/api/review.actions')
          ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
          : fetch(url, init)),
      })
      panel.subscribe(render)

      function surfaceOf(tab) {
        return panel.surfaceForTab({ sessionId: tab.sessionId, tabId: tab.id, named: tab.params?.surface ?? '' })
      }

      function render() {
        for (const sessionId of sessions) {
          const column = columnOf(sessionId)
          column.style.display = sessionId === onScreen ? '' : 'none'
          const holder = column.querySelector('.tabs')
          const wanted = layouts.get(sessionId).filter((tab) => (tab.params?.surface ?? '') !== '')
          for (const entry of [...frames]) {
            if (entry.sessionId !== sessionId) continue
            if (wanted.some((tab) => tab.id === entry.tabId)) continue
            entry.frame.remove()
            frames.splice(frames.indexOf(entry), 1)
            seatOf(sessionId).surfaces.delete(entry.surface)
          }
          for (const tab of wanted) {
            const surface = surfaceOf({ ...tab, sessionId })
            const revision = panel.revision(sessionId, surface)
            const existing = frames.find((entry) => entry.tabId === tab.id)
            if (existing !== undefined) {
              if (existing.revision !== revision) {
                existing.revision = revision
                existing.frame.src = '/api/review.page?surface=' + encodeURIComponent(surface) + '&r=' + revision
              }
              continue
            }
            const frame = document.createElement('iframe')
            frame.className = 'review-frame'
            frame.dataset.tabId = tab.id
            frame.dataset.surface = surface
            frame.src = '/api/review.page?surface=' + encodeURIComponent(surface) + '&r=' + revision
            frame.style.width = '520px'
            frame.style.height = '260px'
            holder.append(frame)
            const entry = { frame, tabId: tab.id, sessionId, surface, revision, nonce: '' }
            frames.push(entry)
            seatOf(sessionId).surfaces.add(surface)
          }
        }
        window.__state = () => ({
          onScreen,
          layouts: [...layouts.entries()].map(([sessionId, tabs]) => ({ sessionId, tabs: tabs.map((tab) => ({ id: tab.id, surface: tab.params?.surface ?? '' })) })),
          frames: frames.map((entry) => ({ tabId: entry.tabId, sessionId: entry.sessionId, surface: entry.surface, revision: entry.revision })),
          receipts,
        })
        window.__harnessReady = true
      }

      window.addEventListener('message', async (event) => {
        const entry = frames.find((candidate) => candidate.frame.contentWindow === event.source)
        if (entry === undefined) return
        const data = event.data
        if (data === null || typeof data !== 'object' || data.__review !== true) return
        const post = (payload) => entry.frame.contentWindow.postMessage(
          Object.assign({ __review: true, nonce: entry.nonce }, payload),
          '*',
        )
        if (data.type === 'hello') {
          entry.nonce = String(data.nonce ?? '')
          if (entry.nonce === '') return
          try {
            const response = await fetch('/api/review.surface?surface=' + encodeURIComponent(entry.surface), { cache: 'no-store' })
            const meta = await response.json()
            post({
              type: 'init',
              assetBase: new URL('.', window.location.href).href,
              surface: meta?.surface ? { id: meta.surface.id, title: meta.surface.title } : null,
              capabilities: Array.isArray(meta?.surface?.capabilities) ? meta.surface.capabilities : [],
              host: meta?.host ?? null,
            })
          } catch (error) {
            post({ type: 'init', assetBase: new URL('.', window.location.href).href, surface: null, capabilities: [], host: null })
          }
          return
        }
        if (entry.nonce === '' || data.nonce !== entry.nonce) return
        if (data.type !== 'call') return
        try {
          const result = await panel.relay({
            sessionId: entry.sessionId,
            surface: entry.surface,
            method: data.method,
            payload: data.payload ?? {},
          })
          post({ type: 'result', id: data.id, ok: true, value: result.value })
        } catch (error) {
          post({ type: 'result', id: data.id, ok: false, error: String(error?.message ?? error) })
        }
      })

      async function poll(sessionId) {
        try {
          const response = await fetch('/api/review.current?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
          if (!response.ok) return
          receipts[sessionId] = panel.observe(sessionId, await response.json())
        } catch {
          /* the harness server may be restarting */
        }
      }
      setInterval(() => { for (const sessionId of sessions) poll(sessionId) }, 250)

      // What a human does in the real sidebar.
      window.__switchTo = (sessionId) => {
        onScreen = sessionId
        render()
      }
      render()
    })()
  </script>
</body>
</html>`
}

/** Send one plugin route through a real Node HTTP response. */
async function serveRoute(route, request, response) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.concat(chunks)
  const pluginResponse = await route.fetch(new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  }))
  response.statusCode = pluginResponse.status
  for (const [key, value] of pluginResponse.headers) {
    if (key === 'connection' || key === 'transfer-encoding') continue
    response.setHeader(key, value)
  }
  response.end(Buffer.from(await pluginResponse.arrayBuffer()))
}

/** Resolve once `check()` returns true, or throw with `label` after `timeoutMs`. */
async function eventually(label, check, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`等不到${label}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

/**
 * Run the acceptance. Returns evidence the caller can assert on.
 * @param {{ headless?: boolean }} options
 */
export async function run({ headless = true } = {}) {
  const { playwright, error: playwrightError } = loadPlaywright()
  if (playwright === undefined) throw new Error(playwrightError)

  const root = await mkdtemp(join(tmpdir(), 'review-panel-browser-'))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  const surface = join(reviewDir, 'surface.json')
  const feedbackFile = join(reviewDir, 'feedback.json')
  await writeFile(join(reviewDir, 'index.html'), PAGE)
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'acceptance/panel-conversations',
    title: 'Panel conversations acceptance',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities: [],
  }))

  const routes = []
  const tools = []
  const toolsService = { register(definition) { tools.push(definition); return () => {} } }
  const get = (name) => (name === 'tools' ? toolsService : undefined)
  const ctx = {
    inject(_names, fn) {
      fn({
        connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
        effect: (run) => (run() ?? (() => {})),
        logger: {},
        get,
        tools: toolsService,
      })
    },
    effect: (run) => (run() ?? (() => {})),
    get,
    logger: {},
    tools: toolsService,
  }
  apply(ctx, process.env.DSH_REVIEW_CORE_DIR ? { reviewCoreDir: process.env.DSH_REVIEW_CORE_DIR } : {})

  // The Agent opens the surface in conversation A.
  const opened = await tools[0].execute({ surface }, { agent: { session: { id: SESSION_A } } })
  if (opened?.ok !== true) throw new Error(`review_open 失败：${JSON.stringify(opened)}`)

  const clientSource = await readFile(CLIENT, 'utf8')
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`)
    request.url = url.href
    try {
      if (url.pathname === '/') {
        response.statusCode = 200
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(harness())
        return
      }
      if (url.pathname === '/client.js') {
        response.statusCode = 200
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.end(clientSource)
        return
      }
      const route = routes.find((entry) => entry.path === url.pathname && entry.methods.includes(request.method))
      if (route === undefined) {
        response.statusCode = 404
        response.end(`no route ${request.method} ${url.pathname}`)
        return
      }
      await serveRoute(route, request, response)
    } catch (error) {
      response.statusCode = 500
      response.end(String(error?.message ?? error))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`

  const browser = await playwright.chromium.launch({ headless })
  const consoleErrors = []
  try {
    const page = await browser.newPage()
    page.on('console', (message) => {
      if (process.env.REVIEW_BROWSER_DEBUG === '1') console.log('[console]', message.type(), message.text())
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => {
      if (process.env.REVIEW_BROWSER_DEBUG === '1') console.log('[pageerror]', String(error?.message ?? error))
      consoleErrors.push(String(error?.message ?? error))
    })
    await page.goto(origin + '/', { waitUntil: 'load' })
    await eventually('侧栏立起来', async () => await page.evaluate(() => window.__harnessReady === true))

    const noteA = page.frameLocator('#column-A iframe').locator('#note')
    await noteA.waitFor({ state: 'visible', timeout: 15000 })
    const statusA = page.frameLocator('#column-A iframe').locator('#status')
    await eventually('A 的页面拿到桥并读到自己的文件', async () => (await statusA.textContent()) === 'ready')
    const bornBefore = await page.frameLocator('#column-A iframe').locator('#born').textContent()

    const text = 'A 对话里写的批注'
    await noteA.fill(text)
    await eventually('A 里有一个审阅标签', async () => {
      const state = await page.evaluate(() => window.__state())
      return state.frames.filter((frame) => frame.sessionId === SESSION_A).length === 1
    })

    // Let several poll ticks run: a settled sidebar must not grow a second tab.
    await page.waitForTimeout(900)
    const beforeSwitch = await page.evaluate(() => window.__state())
    // Switch to B: B's column is empty, A's column is not on screen.
    await page.evaluate((sessionId) => window.__switchTo(sessionId), SESSION_B)
    await eventually('B 的栏出现', async () => await page.evaluate(() => window.__state().onScreen === 'session-B'))
    await page.waitForTimeout(900)
    const afterSwitch = await page.evaluate(() => window.__state())
    const aColumnVisibleInB = await page.locator('#column-A').isVisible()
    const bFrameCountInB = await page.locator('#column-B iframe').count()

    // Switch back to A: the same document, the same words, no extra tab.
    await page.evaluate((sessionId) => window.__switchTo(sessionId), SESSION_A)
    await eventually('A 的栏回来', async () => await page.evaluate(() => window.__state().onScreen === 'session-A'))
    await page.waitForTimeout(900)
    const afterReturn = await page.evaluate(() => window.__state())
    const noteAfter = await noteA.inputValue()
    const bornAfter = await page.frameLocator('#column-A iframe').locator('#born').textContent()
    const aFrameCountAfter = await page.locator('#column-A iframe').count()
    const receipts = await page.evaluate(() => window.__state().receipts)
    const feedbackExists = await readFile(feedbackFile, 'utf8').then(() => true).catch(() => false)

    // Extra acceptance: with no action table, the PAGE must see the cause.
    const tableConsoleErrors = []
    const tablePage = await browser.newPage()
    tablePage.on('console', (message) => {
      if (message.type() === 'error') tableConsoleErrors.push(message.text())
    })
    tablePage.on('pageerror', (error) => tableConsoleErrors.push(String(error?.message ?? error)))
    await tablePage.goto(origin + '/?no-actions=1', { waitUntil: 'load' })
    const tableStatus = tablePage.frameLocator('#column-A iframe').locator('#status')
    const tableFailure = await eventually('页面看到动作表失败的原因', async () => {
      const text = await tableStatus.textContent()
      return typeof text === 'string' && text.startsWith('failed:') ? text : null
    })
    await tablePage.close()

    return {
      beforeSwitch,
      afterSwitch,
      afterReturn,
      aColumnVisibleInB,
      bFrameCountInB,
      aFrameCountAfter,
      noteBefore: text,
      noteAfter,
      bornBefore,
      bornAfter,
      receipts,
      tableFailure,
      tableConsoleErrors,
      consoleErrors,
      feedbackExists,
      opened: { ok: opened.ok, tab: opened.tab },
    }
  } finally {
    await browser.close().catch(() => {})
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  }
}

// Standalone: `node test/browser/panel-conversations.browser.mjs`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
      if (evidence.noteAfter === evidence.noteBefore) process.exitCode = 0
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
