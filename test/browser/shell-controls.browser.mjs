/**
 * 真浏览器验收：外壳渲染出来的控件里不存在「保存」类按钮，而一次放置失败会
 * 在帧底下留一行原因。
 *
 * 为什么不是一条读源码文字的检查：规格原话是「这次不为它写文档，而是写一条会
 * 失败的检查 —— 能在界面上机械判定的东西，不该靠人记得」。保存按钮被加回来过
 * 三次；读 `lib/client.js` 里有没有 "保存" 两个字，恰好是「函数体删掉、签名
 * 留着」也能通过的那种检查。
 *
 * 这一份搭的东西：
 *   - 真正的宿主：`apply()` 挂在假 ctx 上，路由接到真 HTTP server 上；
 *   - 真正的外壳：父页面加载 `lib/client.js` 本体，取出它注册进侧栏的那个
 *     `ReviewFrame`，用一份最小 React 渲染器真的渲染成 DOM；
 *   - 最小的假侧栏适配器：一个对话、它的布局、它的标签；
 *   - 真 Chromium：先确认外壳没有控件、也没有状态废话；再让放置失败，确认那
 *     一行点名原因。
 *
 * 最小渲染器的限度（写在这里，免得以后有人把它当 React 用）：`createElement` /
 * `useState` / `useRef` / `useEffect` 够用；每次重绘是整棵子树重建而不是 diff，
 * 所以一个活着的 iframe 不能跨重绘存活。这份验收只看控件与状态行，所以够。
 *
 * 单独跑：
 *   NODE_PATH=$(npm root -g) node test/browser/shell-controls.browser.mjs
 * 或由 test/shell-controls.test.mjs 在 `node --test` 里调 `run()`。
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

const SESSION = 'session-shell'

const PAGE = `<!doctype html>
<html>
<body>
  <textarea id="note" placeholder="在这里写"></textarea>
  <div id="status">booting</div>
  {{REVIEW_BRIDGE}}
  <script>
    (async () => {
      try {
        const review = await ReviewBridge.connect()
        window.__review = review
        document.getElementById('status').textContent = 'ready'
      } catch (error) {
        document.getElementById('status').textContent = 'failed: ' + error.message
      }
    })()
  </script>
</body>
</html>`

/**
 * The micro renderer, in the page. It builds real DOM from what the shell's own
 * `ReviewFrame` returns; nothing about the controls is re-implemented here.
 */
const MICRO_REACT = `
    (function () {
      var hooks = []
      var cursor = 0
      var pending = []
      var cleanups = []
      var scheduled = false
      var shell = { component: null, props: null, container: null, render: null }

      function toDom(node) {
        if (node === null || node === undefined || node === false || node === true) return null
        if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node))
        if (Array.isArray(node)) {
          var fragment = document.createDocumentFragment()
          for (var i = 0; i < node.length; i += 1) {
            var child = toDom(node[i])
            if (child !== null) fragment.append(child)
          }
          return fragment
        }
        var el = document.createElement(node.type)
        var props = node.props || {}
        Object.keys(props).forEach(function (key) {
          var value = props[key]
          if (key === 'children' || value === undefined || value === null || value === false) return
          if (key === 'style' && typeof value === 'object') {
            Object.keys(value).forEach(function (name) { el.style[name] = value[name] })
            return
          }
          if (key === 'ref' && typeof value === 'object') { value.current = el; return }
          if (key.slice(0, 2) === 'on' && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value)
            return
          }
          el.setAttribute(key, value === true ? '' : String(value))
        })
        for (var c = 0; c < node.children.length; c += 1) {
          var dom = toDom(node.children[c])
          if (dom !== null) el.append(dom)
        }
        return el
      }

      var React = {
        createElement: function (type, props) {
          var children = Array.prototype.slice.call(arguments, 2)
          return { type: type, props: props || {}, children: children }
        },
        useState: function (initial) {
          var index = cursor++
          if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
          var slot = hooks[index]
          return [slot.value, function (next) {
            slot.value = typeof next === 'function' ? next(slot.value) : next
            schedule()
          }]
        },
        useRef: function (initial) {
          var index = cursor++
          if (!(index in hooks)) hooks[index] = { current: initial }
          return hooks[index]
        },
        useEffect: function (fn) {
          // Effects are re-run after every render: this renderer rebuilds the
          // subtree, so anything they captured has to be re-acquired.
          pending.push(fn)
        }
      }

      function render() {
        if (shell.component === null) return
        scheduled = false
        cursor = 0
        pending.length = 0
        for (var i = 0; i < cleanups.length; i += 1) {
          try { cleanups[i]() } catch (error) { /* an unmount that throws is still unmounted */ }
        }
        cleanups.length = 0
        var tree = shell.component(shell.props)
        var dom = toDom(tree)
        shell.container.replaceChildren()
        if (dom !== null) shell.container.append(dom)
        var effects = pending.slice()
        pending.length = 0
        for (var e = 0; e < effects.length; e += 1) {
          var cleanup = effects[e]()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
      }

      function schedule() {
        if (scheduled) return
        scheduled = true
        window.queueMicrotask(render)
      }

      window.__React = React
      window.__mountShell = function (component, props, container) {
        shell = { component: component, props: props, container: container, render: render }
        window.__renderShell = render
        render()
      }
    })()
`

/** The parent page: a minimal right sidebar that renders the real shell. */
function harness(surface) {
  return `<!doctype html>
<html>
<body>
  <div id="column" data-session="${SESSION}"><h1>conversation</h1><div id="shell"></div></div>
  <script>${MICRO_REACT}</script>
  <script>
    window.__ModuleLoader__ = {
      load(registration) {
        window.__client = registration.factory((name) => (name === 'react' ? window.__React : {}))
      },
    }
  </script>
  <script src="/client.js"></script>
  <script>
    (() => {
      const client = window.__client
      const layouts = new Map([[${JSON.stringify(SESSION)}, []]])
      const seats = new Map()
      const registered = {}
      let failing = ${'false'}
      const surface = ${JSON.stringify(surface)}

      function seatOf(sessionId) {
        let seat = seats.get(sessionId)
        if (seat === undefined) {
          seat = {
            surfaces: new Set(),
            placer: (kind, options) => {
              if (failing) throw new Error('右栏没有可用的控制器')
              layouts.get(sessionId).push({ kind, id: 'tab-' + layouts.get(sessionId).length, params: options.params })
            },
          }
          seats.set(sessionId, seat)
        }
        return seat
      }

      const ctx = {
        inject(_names, fn) { fn(ctx) },
        effect(run) { const dispose = run(); return dispose || (() => {}) },
        get(name) { return name === 'layout' ? { openRightbar() {} } : undefined },
        logger: {},
        slots: {
          inject(_name, fn) { return fn() },
          register(definition, component) {
            registered[definition?.name ?? 'unknown'] = component
            return () => {}
          },
        },
        sidebarRightTabs: {
          register(definition) { registered.tabType = definition; return () => {} },
        },
        sidebarRight: {
          mounted: { getSnapshot: () => ${JSON.stringify(SESSION)} },
          tabsIn: (sessionId) => (layouts.get(sessionId) ?? []).map((tab) => ({ kind: tab.kind })),
          openTab: (kind, options) => {
            if (failing) throw new Error('右栏没有可用的控制器')
            layouts.get(${JSON.stringify(SESSION)}).push({ kind, params: options.params })
          },
        },
      }

      client.apply(ctx)

      // What the framework hands a mounted tab: its own navigation params and
      // the tab's own actions; its openTab is where a placement failure shows up.
      const props = {
        sessionId: ${JSON.stringify(SESSION)},
        useTabInfo: () => ({
          tab: {
            id: 'tab-0',
            navigation: { params: { surface, sessionId: ${JSON.stringify(SESSION)} } },
            actions: {
              openTab: (kind, options) => {
                if (failing) throw new Error('右栏没有可用的控制器')
                layouts.get(${JSON.stringify(SESSION)}).push({ kind, params: options.params })
              },
            },
          },
        }),
      }

      window.__setFailing = (next) => { failing = next === true }
      window.__shellMounted = false
      const component = registered['sidebar.right.pane.tab']
      if (typeof component !== 'function') {
        document.getElementById('shell').textContent = 'shell not registered'
      } else {
        window.__mountShell(component, props, document.getElementById('shell'))
        window.__shellMounted = true
      }
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

  const root = await mkdtemp(join(tmpdir(), 'review-shell-browser-'))
  const reviewDir = join(root, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(reviewDir, 'index.html'), PAGE)
  const surfaceOf = async (name, title) => {
    const file = join(reviewDir, `${name}.json`)
    await writeFile(file, JSON.stringify({
      contract_version: 'review-surface/2.0.0',
      id: `acceptance/${name}`,
      title,
      project_root: '..',
      dir: '.',
      entry: 'index.html',
      feedback: `${name}-feedback.json`,
      wake: { mode: 'queue', text: '{unit}' },
      capabilities: [],
    }))
    return file
  }
  const surface = await surfaceOf('surface', '外壳控件验收')
  const second = await surfaceOf('second', '第二份面')

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

  // The Agent opens the surface this tab already shows; nothing to place, so the
  // shell must stay silent.
  const opened = await tools[0].execute({ surface }, { agent: { session: { id: SESSION } } })
  if (opened?.ok !== true) throw new Error(`review_open 失败：${JSON.stringify(opened)}`)

  const clientSource = await readFile(CLIENT, 'utf8')
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`)
    request.url = url.href
    try {
      if (url.pathname === '/') {
        response.statusCode = 200
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(harness(surface))
        return
      }
      if (url.pathname === '/client.js') {
        response.statusCode = 200
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.end(clientSource)
        return
      }
      // A second handover: the tab already shows one surface, so placing this
      // one goes through `tab.actions.openTab`, which the harness makes fail.
      if (url.pathname === '/__hand-over') {
        const receipt = await tools[0].execute({ surface: second }, { agent: { session: { id: SESSION } } })
        response.statusCode = 200
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify(receipt ?? null))
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
    await eventually('外壳渲染出来', async () => await page.evaluate(() => window.__shellMounted === true))
    // Wait for the first poll: the surface is already on screen, so this tick has
    // nothing to report.
    await eventually('外壳里挂着审阅帧', async () => (await page.locator('#shell iframe').count()) === 1)
    await eventually('帧里的页面连上桥', async () => (await page.frameLocator('#shell iframe').locator('#status').textContent()) === 'ready')

    /** Everything the shell itself rendered that a human could press or type in. */
    const controlsNow = () => page.evaluate(() => {
      const shell = document.getElementById('shell')
      const nodes = [...shell.querySelectorAll('button, input, select, textarea, form, a, [role="button"], [type="submit"]')]
      return nodes.map((node) => `${node.tagName.toLowerCase()}[${node.getAttribute('type') ?? ''}] ${(node.textContent ?? '').trim()} ${node.getAttribute('aria-label') ?? ''}`.trim())
    })

    const quietControls = await controlsNow()
    const quietLines = await page.evaluate(() => [...document.querySelectorAll('#shell [role="status"]')].map((node) => node.textContent))

    // One placement that the Host refuses: the shell must say WHY on one line.
    await page.evaluate(() => window.__setFailing(true))
    await page.evaluate(() => fetch('/__hand-over').then((response) => response.json()))
    const failureLine = await eventually('外壳把放置失败的原因写出来', async () => {
      const lines = await page.evaluate(() => [...document.querySelectorAll('#shell [role="status"]')].map((node) => node.textContent))
      const line = lines.find((text) => /放置失败/.test(text ?? '')) ?? ''
      return line.includes('右栏没有可用的控制器') ? line : null
    })
    const loudControls = await controlsNow()

    return {
      shellMounted: true,
      quietControls,
      quietLines,
      failureLine,
      loudControls,
      consoleErrors,
    }
  } finally {
    await browser.close().catch(() => {})
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  }
}

// Standalone: `node test/browser/shell-controls.browser.mjs`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
      if (Array.isArray(evidence.quietControls)) process.exitCode = 0
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
