/**
 * 启动对账：盘上并存两份插件时，第二份必须在启动日志里说清「谁在应答、他几版、我几版」。
 *
 * 接缝只有一个：用假的宿主环境驱动 `apply(ctx)`，从日志与注册表上看行为。
 * 假环境的语义照抄真实运行时（`@deepseek-ai/dsh-client-connection` 0.2.2-rc.3）：
 *
 *   - `connection.fetch.register` 在路径已被注册时**同步抛出**
 *     `connection: exact Fetch route "<path>" is already registered`；
 *   - `connection.createSharedFetchHandler('/api')` 在**调用那一刻**按 pathname
 *     查已注册的精确入口，只有 owner peer 才被放行；
 *   - `connection.createPeer({ principal: { kind: 'owner' } })` 是插件在进程内
 *     自问自答的唯一正当入口。
 *
 * 因此「第二份」不需要定时器或读进程文件：挂载时先问一次身份，再逐条注册，
 * 谁被占用、占用者报的是哪一版，运行时自己就给了答案。
 *
 * 本机真实的第二份是 planners-form vendored 的 0.3.0：十个入口都占着，但
 * `/api/review.current` 的应答里没有 `host`（那个字段从 0.3.1 才加），所以
 * 它报不出名字与版本。「报不出身份」本身就是要说出来的证据，不能因此沉默。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** 本插件对外的入口名。这些名字是契约，不是实现细节。 */
const ROUTE_PATHS = [
  '/api/review.current',
  '/api/review.surface',
  '/api/review.page',
  '/api/review.bridge',
  '/api/review.actions',
  '/api/review.asset',
  '/api/review.write',
  '/api/review.draft',
  '/api/review.command',
  '/api/review.upload',
  '/api/review.wake',
]

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const OWN_VERSION = manifest.version
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 一个进程里的 `connection` 服务，行为与真实实现一致。
 * 两个副本共享同一个 runtime，就是「盘上装了两份」在进程里的样子。
 */
function fakeRuntime() {
  const routes = new Map()
  const peers = []
  const connection = {
    fetch: {
      register(route) {
        if (routes.has(route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        }
        routes.set(route.path, {
          path: route.path,
          methods: new Set(route.methods),
          requestBody: route.requestBody,
          fetch: route.fetch,
        })
        return () => routes.delete(route.path)
      },
    },
    createPeer({ principal }) {
      const peer = { principal, interactions: 'answer', dispose: async () => {} }
      peers.push(peer)
      return peer
    },
    createSharedFetchHandler() {
      return {
        requestBodyMode: () => 'buffered',
        fetch(request, peer) {
          const pathname = new URL(request.url).pathname
          const route = routes.get(pathname)
          if (route !== undefined && route.methods.has(request.method)) {
            if (peer.principal.kind !== 'owner') {
              return Promise.resolve(new Response('forbidden', { status: 403 }))
            }
            return route.fetch(request)
          }
          return Promise.resolve(new Response('not found', { status: 404 }))
        },
      }
    },
  }
  return { routes, peers, connection }
}

/**
 * 让一批入口看上去已被另一份副本先注册。
 * `identity` 决定 `/api/review.current` 怎么答：'host' 报名字与版本，'none' 是
 * 0.3.0 的形状（200 但没有 host），'404' 占着路却问不到这个入口。
 */
function occupy(runtime, { paths = ROUTE_PATHS, name = 'dsh-review-dock', version = '0.2.5', identity = 'host' } = {}) {
  for (const path of paths) {
    runtime.routes.set(path, {
      path,
      methods: new Set(['GET', 'POST']),
      requestBody: 'buffered',
      fetch: async (request) => {
        if (identity === '404') return new Response('not found', { status: 404 })
        if (new URL(request.url).pathname !== '/api/review.current') {
          return new Response('occupied', { status: 200 })
        }
        // 'none' is what the vendored 0.3.0 copy answers: 200 JSON, no host block
        // (that field arrived in 0.3.1). It is the real second copy on this machine.
        if (identity === 'none') return Response.json({ ok: true, sessionId: 's', surfaces: [] })
        return Response.json({ host: { name, version } })
      },
    })
  }
}

/**
 * 挂载一份副本。`connection` 只给假 runtime 的 `fetch.register` 时，
 * 模拟一个不提供进程内身份探针的旧运行时（`createSharedFetchHandler` 不存在）。
 */
function mountCopy(runtime, { probe = true } = {}) {
  const info = []
  const warn = []
  const logger = { info: (line) => info.push(String(line)), warn: (line) => warn.push(String(line)) }
  const tools = []
  const services = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    agents: { get: () => undefined },
  }
  const get = (service) => services[service]
  const effect = (run) => (run() ?? (() => {}))
  const connection = probe ? runtime.connection : { fetch: runtime.connection.fetch }
  const inject = (names, fn) => {
    if (names.includes('connection')) {
      fn({ connection, effect, logger, get })
      return
    }
    if (names.includes('systemPrompt')) {
      fn({ systemPrompt: { section: () => () => {} }, effect, logger, get })
      return
    }
    if (names.includes('sessionController')) {
      fn({ sessionController: { prompt: async () => {}, state: () => ({}) }, effect, logger, get })
    }
    // 其余可选注入（如 agents）缺席时 cordis 不会调用回调，这里同样不调。
  }
  apply({ inject, effect, logger, get }, {})
  return { info, warn, tools }
}

/** 等一条异步日志落地；对账发生在挂载之后的微任务里，不读内部状态。 */
async function settle(predicate, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('the second copy names who answers its routes, which version, and what it lost', async () => {
  const runtime = fakeRuntime()
  // 盘上先有一份更旧的副本（比如 0.2.5），所有入口它都占着，而且会报版本。
  occupy(runtime, { name: 'dsh-review-dock', version: '0.2.5' })

  const copy = mountCopy(runtime)

  await settle(() => copy.warn.length > 0, '第二份副本的启动对账行')
  assert.equal(copy.warn.length, 1, `对账只写一行，实际：${JSON.stringify(copy.warn)}`)
  const line = copy.warn[0]

  assert.match(line, /启动对账/)
  assert.match(line, /dsh-review-dock/, '必须说出应答者是谁')
  assert.match(line, /0\.2\.5/, '必须说出应答者报的版本')
  assert.match(line, new RegExp(escapeRegExp(OWN_VERSION)), '必须说出本副本的版本')
  assert.match(line, /比它新/, `应答者 0.2.5 比本副本 ${OWN_VERSION} 旧，必须说清`)
  assert.match(line, /11\/11/, '必须说清有几条入口被对方拿走')
  assert.match(line, /review\.current/, '被跳过的入口要指名')

  const stillOld = await runtime.routes.get('/api/review.current').fetch(new Request('http://dsh.local/api/review.current?sessionId=s'))
  assert.deepEqual(await stillOld.json(), { host: { name: 'dsh-review-dock', version: '0.2.5' } }, '旧副本仍在应答它的入口')
  assert.equal(copy.info.some((line) => line.includes('registered')), false, '冲突时不能顺手写一句“已注册”的假账')
})

test('a lone copy mounts quietly, with only the existing registered line', async () => {
  const runtime = fakeRuntime()

  const copy = mountCopy(runtime)

  await settle(() => copy.info.some((line) => line.includes('registered')), '挂载完成的那行“已注册”')
  assert.equal(copy.warn.length, 0, '只有一份副本时不该对账告警')
  assert.equal(copy.info.filter((line) => line.includes('registered')).length, 1, `“已注册”只写一行：${JSON.stringify(copy.info)}`)
  assert.equal(copy.info.some((line) => line.includes('启动对账')), false, '没人应答就不该有对账行')
  assert.equal(runtime.routes.size, ROUTE_PATHS.length, '十一个入口都要挂上')
  assert.equal(copy.tools.length, 1, 'review_open 仍在')
})

test('two copies at the same version: the second reports the peer and loses every route', async () => {
  const runtime = fakeRuntime()
  const first = mountCopy(runtime)
  await settle(() => first.info.some((line) => line.includes('registered')), '第一份副本的挂载日志')

  const second = mountCopy(runtime)
  await settle(() => second.warn.length > 0, '第二份副本的启动对账行')

  assert.equal(second.warn.length, 1, `只写一行：${JSON.stringify(second.warn)}`)
  const line = second.warn[0]
  assert.match(line, /应答者是 dsh-review-dock/, '必须说出应答者是谁')
  assert.match(line, new RegExp(escapeRegExp(OWN_VERSION)), '必须说出应答者报的版本')
  assert.match(line, /同版/, '两份版本相同时要说“同版”')
  assert.match(line, /11\/11/, '必须说清十一条入口全被占着')
  assert.equal(first.warn.length, 0, '先挂上的那份不该被告状')
})

test('one occupied route costs only that route, and the line names it', async () => {
  const runtime = fakeRuntime()
  occupy(runtime, { paths: ['/api/review.current'], version: '0.2.5' })

  const copy = mountCopy(runtime)
  await settle(() => copy.warn.length > 0, '第二份副本的启动对账行')

  assert.equal(copy.warn.length, 1)
  assert.match(copy.warn[0], /1\/11/, '只丢了一条')
  assert.match(copy.warn[0], /review\.current/, '丢的是哪条要指名')
  assert.equal(runtime.routes.size, ROUTE_PATHS.length, '其余十条 + 旧的 current 都应在')

  // 本副本自己的入口真的能应答：没有 surface 参数时是 400（走到了处理函数），
  // 不是 404（没注册）。
  const surface = runtime.routes.get('/api/review.surface')
  assert.notEqual(surface, undefined, 'surface 入口必须由本副本挂上')
  const response = await surface.fetch(new Request('http://dsh.local/api/review.surface'))
  assert.equal(response.status, 400)

  // 被占的那条仍归旧副本。
  const current = await runtime.routes
    .get('/api/review.current')
    .fetch(new Request('http://dsh.local/api/review.current?sessionId=s'))
  assert.deepEqual(await current.json(), { host: { name: 'dsh-review-dock', version: '0.2.5' } })
})

test('an occupant that cannot identify itself is still reported, not hidden', async () => {
  const runtime = fakeRuntime()
  // 路都占着，但问身份回 404（更早的副本、或这个入口被别的插件拿走）。
  occupy(runtime, { identity: '404' })

  const copy = mountCopy(runtime)
  await settle(() => copy.warn.length > 0, '第二份副本的启动对账行')

  assert.equal(copy.warn.length, 1)
  assert.match(copy.warn[0], /没有人报出身份/, '问不到身份要照实说')
  assert.match(copy.warn[0], new RegExp(escapeRegExp(OWN_VERSION)))
  assert.match(copy.warn[0], /11\/11/)
})

test('a runtime with no in-process identity probe still reports the collision', async () => {
  const runtime = fakeRuntime()
  occupy(runtime)

  const copy = mountCopy(runtime, { probe: false })
  await settle(() => copy.warn.length > 0, '第二份副本的启动对账行')

  assert.equal(copy.warn.length, 1)
  assert.match(copy.warn[0], /没有进程内问身份的办法/)
  assert.match(copy.warn[0], /11\/11/)

  // 同样的旧运行时，只有一份副本时仍然安静。
  const quiet = mountCopy(fakeRuntime(), { probe: false })
  await settle(() => quiet.info.some((line) => line.includes('registered')), '旧运行时上的挂载日志')
  assert.equal(quiet.warn.length, 0)
})

test('a newer occupant makes this copy the old one, and the line says so', async () => {
  const runtime = fakeRuntime()
  occupy(runtime, { version: '9.9.9' })

  const copy = mountCopy(runtime)
  await settle(() => copy.warn.length > 0, '启动对账行')

  assert.equal(copy.warn.length, 1)
  assert.match(copy.warn[0], /9\.9\.9/)
  assert.match(copy.warn[0], /比它旧/, '方向不能反：本副本才是旧的那份')
  assert.equal(copy.warn[0].includes('\n'), false, '对账只写一行')
})

test('the responder is untrusted text and cannot turn one startup line into several', async () => {
  const runtime = fakeRuntime()
  occupy(runtime, { name: 'dsh-review-dock\n伪造的一行', version: '0.2.5\n0.9.9' })

  const copy = mountCopy(runtime)
  await settle(() => copy.warn.length > 0, '启动对账行')

  assert.equal(copy.warn.length, 1)
  const line = copy.warn[0]
  assert.equal(line.includes('\n'), false, '对账必须仍然只有一行')
  assert.match(line, /dsh-review-dock 伪造的一行/, '换行折叠成空格，不是丢掉')
  assert.match(line, /无法与它比版本/, '读不出版本时就说读不出，不要瞎比')
  assert.ok(line.length < 500, `一行不能长到刷屏：${line.length}`)
})

test('a responder older than 0.3.1 answers without a host block; the line still calls it older', async () => {
  // 实机第二份是 planners-form vendored 的 0.3.0：十个入口都占着，
  // /api/review.current 回 200 但没有 host（host 从 0.3.1 才加）。
  const runtime = fakeRuntime()
  occupy(runtime, { identity: 'none', version: '' })

  const copy = mountCopy(runtime)
  await settle(() => copy.warn.length > 0, '启动对账行')

  assert.equal(copy.warn.length, 1)
  const line = copy.warn[0]
  assert.match(line, /没有报出身份/, '问不到身份要照实说')
  assert.match(line, /0\.3\.1/, '为什么算它旧：这个入口从 0.3.1 起才带 host')
  assert.match(line, new RegExp(escapeRegExp(OWN_VERSION)), '必须说出本副本的版本')
  assert.match(line, /比它新/)
  assert.match(line, /11\/11/)
})

test('a registration failure that has nothing to do with a second copy is not called a duplicate', async () => {
  const runtime = fakeRuntime()
  // 只有「已被注册」那一类才是第二份副本的证据。别的失败（这里：路由表满了）
  // 与副本无关，照实说 —— 不然人照着「重复的 N 条入口」去找第二份，永远找不到。
  const register = runtime.connection.fetch.register
  runtime.connection.fetch.register = (route) => {
    if (route.path === '/api/review.surface') throw new Error('connection: route table is full')
    return register(route)
  }

  const copy = mountCopy(runtime)
  await settle(() => copy.warn.length > 0, '注册失败的启动日志')

  assert.equal(copy.warn.length, 1, `只写一行：${JSON.stringify(copy.warn)}`)
  const line = copy.warn[0]
  assert.match(line, /review\.surface/, '哪一条没挂上要指名')
  assert.match(line, /route table is full/, '原因要照实说，不能吞掉')
  assert.equal(/重复/.test(line), false, '与副本无关的失败不许说成「重复入口」')
  assert.equal(copy.info.some((entry) => entry.includes('registered')), false, '少了一条入口就不能写「已注册」')
  assert.equal(runtime.routes.size, ROUTE_PATHS.length - 1, '其余入口照常挂上')
})
