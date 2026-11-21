/**
 * 真浏览器验收：写 → 刷新 → 字还在。
 *
 * 这不是接缝，是验收。它搭的是一份最小的「侧栏」：
 *
 *   - 真正的宿主：`apply()` 挂在假 ctx 上，`connection.fetch.register` 收到的
 *     路由接到一个真的 HTTP server 上；
 *   - 真正的页面：`/api/review.page` 把那页 HTML 连桥一起内联出来，装进 iframe；
 *   - 真正的转交：父页面加载 lib/client.js 本体，用它的 `carry`，表从
 *     `/api/review.actions` 读 —— 和 DSH 侧栏走的是同一份代码、同一张表；
 *   - 真 Chromium：在输入框里打字、等草稿落盘、刷新、断言字回来了。
 *
 * 单独跑：
 *   NODE_PATH=$(npm root -g) node test/browser/draft-reload.browser.mjs
 * 或由 test/browser-acceptance.test.mjs 在 `node --test` 里调 `run()`。
 * 没有 Playwright 时由调用方跳过，并给出原因，不伪造。
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply } from '../../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** The plugin's own sidebar module, served to the harness verbatim. */
const CLIENT = resolve(here, '../../lib/client.js')

/**
 * Playwright is installed globally, not in this repo. It is resolvable directly
 * when the caller sets NODE_PATH=$(npm root -g); otherwise ask npm where the
 * global root is and require from there, so `npm test` runs this acceptance too.
 */
export function loadPlaywright() {
  try {
    return { playwright: require('playwright') }
  } catch {
    try {
      const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
      if (root === '') throw new Error('npm root -g returned nothing')
      const globalRequire = createRequire(join(root, 'noop.cjs'))
      return { playwright: globalRequire('playwright') }
    } catch (error) {
      return { error: `找不到 playwright：${error?.message ?? String(error)}（用 NODE_PATH=$(npm root -g) 跑）` }
    }
  }
}

const PAGE = `<!doctype html>
<html>
<body>
  <textarea id="editor" placeholder="在这里写"></textarea>
  <div id="status">booting</div>
  {{REVIEW_BRIDGE}}
  <script>
    (async () => {
      const status = document.getElementById('status')
      const editor = document.getElementById('editor')
      try {
        const review = await ReviewBridge.connect()
        window.__review = review
        const saved = await review.draftRead()
        if (saved && saved.draft && typeof saved.draft.text === 'string') {
          editor.value = saved.draft.text
          status.textContent = 'restored'
        } else {
          status.textContent = 'empty'
        }
        let timer = null
        editor.addEventListener('input', () => {
          clearTimeout(timer)
          timer = setTimeout(async () => {
            try {
              await review.draft({ text: editor.value })
              status.textContent = 'saved'
            } catch (error) {
              status.textContent = 'save-failed: ' + error.message
            }
          }, 80)
        })
        window.__pageReady = true
      } catch (error) {
        status.textContent = 'connect-failed: ' + error.message
      }
    })()
  </script>
</body>
</html>`

/** The parent page: a tiny sidebar that speaks the Host's table through the real relay. */
function harness(surface) {
  return `<!doctype html>
<html>
<body>
  <h1>harness</h1>
  <div id="relay">waiting</div>
  <iframe id="frame" src="/api/review.page?surface=${encodeURIComponent(surface)}" style="width:640px;height:360px"></iframe>
  <script>
    window.__ModuleLoader__ = {
      load(registration) {
        // Only carry() is used here; React is never rendered by this harness.
        window.__client = registration.factory(() => ({ createElement() {} }))
      },
    }
  </script>
  <script src="/client.js"></script>
  <script>
    (async () => {
      const frame = document.getElementById('frame')
      const relayNote = document.getElementById('relay')
      const surface = ${JSON.stringify(surface)}
      // Start the fetches, but attach the listener SYNCHRONOUSLY: the frame may
      // say hello before the table arrives, and a lost hello means the page waits
      // for an init that never comes.
      const tablePromise = fetch('/api/review.actions').then((response) => response.json())
      const metaPromise = fetch('/api/review.surface?surface=' + encodeURIComponent(surface)).then((response) => response.json())
      window.__relayErrors = []
      let nonce = ''
      const post = (payload) => frame.contentWindow.postMessage(Object.assign({ __review: true, nonce }, payload), '*')
      window.addEventListener('message', async (event) => {
        if (event.source !== frame.contentWindow) return
        const data = event.data
        if (!data || data.__review !== true) return
        const table = await tablePromise
        const meta = await metaPromise
        const capabilities = Array.isArray(meta?.surface?.capabilities) ? meta.surface.capabilities : []
        if (data.type === 'hello') {
          nonce = String(data.nonce || '')
          post({
            type: 'init',
            assetBase: new URL('.', window.location.href).href,
            surface: meta?.surface ? { id: meta.surface.id, title: meta.surface.title } : null,
            capabilities,
            host: meta?.host ?? null,
          })
          return
        }
        if (data.type !== 'call' || data.nonce !== nonce) return
        const action = (table.actions || []).find((entry) => entry.name === data.method)
        try {
          if (!action) throw new Error('表里没有这个动作：' + data.method)
          const result = await window.__client.carry(action, {
            surface,
            sessionId: 'harness-session',
            payload: data.payload || {},
            endpoint: (name) => new URL('api/' + name, window.location.href).href,
            fetch: (url, init) => fetch(url, init),
          })
          relayNote.textContent = data.method + ' ok'
          post({ type: 'result', id: data.id, ok: true, value: result.value })
        } catch (error) {
          window.__relayErrors.push(data.method + ': ' + String((error && error.message) || error))
          relayNote.textContent = data.method + ' failed'
          post({ type: 'result', id: data.id, ok: false, error: String((error && error.message) || error) })
        }
      })
      window.__harnessReady = true
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
    // The Web carrier may add its own transfer encoding; keep the plugin's own.
    if (key === 'connection' || key === 'transfer-encoding') continue
    response.setHeader(key, value)
  }
  response.end(Buffer.from(await pluginResponse.arrayBuffer()))
}

/** Resolve once `check()` returns true, or throw with `label` after `timeoutMs`. */
async function eventually(label, check, timeoutMs = 10000) {
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

  const root = await mkdtemp(join(tmpdir(), 'review-browser-'))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  const surface = join(reviewDir, 'surface.json')
  const draftFile = join(reviewDir, 'draft.json')
  const feedbackFile = join(reviewDir, 'feedback.json')
  await writeFile(join(reviewDir, 'index.html'), PAGE)
  await writeFile(surface, JSON.stringify({
    contract_version: 'review-surface/2.0.0',
    id: 'acceptance/draft-reload',
    title: 'Draft reload acceptance',
    project_root: '..',
    dir: '.',
    entry: 'index.html',
    feedback: 'feedback.json',
    draft: 'draft.json',
    wake: { mode: 'queue', text: '{unit}' },
    capabilities: ['draft'],
  }))

  const routes = []
  const ctx = {
    inject(_names, fn) {
      fn({
        connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
        effect: (run) => (run() ?? (() => {})),
        logger: {},
        get: () => undefined,
      })
    },
    effect: (run) => (run() ?? (() => {})),
    get: () => undefined,
    logger: {},
  }
  apply(ctx, process.env.DSH_REVIEW_CORE_DIR ? { reviewCoreDir: process.env.DSH_REVIEW_CORE_DIR } : {})

  const clientSource = await readFile(CLIENT, 'utf8')
  const pageHarness = harness(surface)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`)
    request.url = url.href
    try {
      if (url.pathname === '/') {
        response.statusCode = 200
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(pageHarness)
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

    const editor = page.frameLocator('#frame').locator('#editor')
    const status = page.frameLocator('#frame').locator('#status')
    await editor.waitFor({ state: 'visible', timeout: 15000 })
    if (process.env.REVIEW_BROWSER_DEBUG === '1') {
      console.log('[harness]', await page.evaluate(() => ({ ready: window.__harnessReady, client: typeof window.__client, errors: window.__relayErrors })))
    }
    await eventually('页面拿到桥', async () => {
      const text = await status.textContent()
      if (process.env.REVIEW_BROWSER_DEBUG === '1') console.log('[status]', text)
      return text === 'empty'
    })

    const text = '刷新之后这句话还在'
    await editor.fill(text)
    await eventually('草稿落盘', async () => {
      const saved = JSON.parse(await readFile(draftFile, 'utf8').catch(() => 'null'))
      return saved?.text === text
    })
    await eventually('页面显示已保存', async () => (await status.textContent()) === 'saved')

    await page.reload({ waitUntil: 'load' })
    const reloaded = page.frameLocator('#frame').locator('#editor')
    await reloaded.waitFor({ state: 'visible', timeout: 15000 })
    const restored = await eventually('刷新后取回草稿', async () => {
      const value = await reloaded.inputValue()
      return value === text ? value : null
    })
    const restoredStatus = await page.frameLocator('#frame').locator('#status').textContent()
    const relayErrors = await page.evaluate(() => window.__relayErrors ?? [])
    const feedbackExists = await readFile(feedbackFile, 'utf8').then(() => true).catch(() => false)

    return {
      restored,
      restoredStatus,
      relayErrors,
      consoleErrors,
      feedbackExists,
      draft: JSON.parse(await readFile(draftFile, 'utf8')),
    }
  } finally {
    await browser.close().catch(() => {})
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  }
}

// Standalone: `node test/browser/draft-reload.browser.mjs`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
      if (evidence.restored !== undefined) process.exitCode = 0
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
