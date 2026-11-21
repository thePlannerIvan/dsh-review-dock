/**
 * 假 Cordis 上下文：插件只经由这套公开形状挂载。
 *
 * `apply()` 会 `ctx.inject(['connection'], …)`、`ctx.effect(…)`、`ctx.get('tools')`。
 * 这里把三件事都摆出来：注册进来的入口被记下、注册的模型工具被记下、别的服务
 * 一律不存在 —— 缺服务是「能力降级」，不是崩溃，测试要能看见同一条路。
 */
export function fakeCordis({ tools = false } = {}) {
  const routes = []
  const registered = []
  const toolsService = { register(definition) { registered.push(definition); return () => {} } }
  const get = (name) => (tools && name === 'tools' ? toolsService : undefined)
  const bridgeCtx = {
    connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
    effect: (run) => (run() ?? (() => {})),
    logger: {},
    get,
    ...(tools ? { tools: toolsService } : {}),
  }
  const ctx = {
    inject(_names, fn) { fn(bridgeCtx) },
    effect: (run) => (run() ?? (() => {})),
    get,
    logger: {},
    ...(tools ? { tools: toolsService } : {}),
  }
  return { ctx, routes, tools: registered }
}
