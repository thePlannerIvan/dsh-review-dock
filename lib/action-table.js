/**
 * 页面能请宿主做什么 —— 唯一一张表。
 *
 * 每行一个动作：动作名（也是桥的方法名）、是否「必须」、落到哪条入口、用什么
 * HTTP 方法、请求体怎么带、回执怎么读。三样东西从这张表派生，不再各写一份：
 *
 *   1. 宿主入口的注册        `actionRoutes()`  → lib/index.js 的 `apply`
 *   2. 桥的完整性检查        `BRIDGE_API`      → lib/index.js 的 `missingBridgeApi`
 *   3. 侧栏的转交分派        `servedActions()` → GET /api/review.actions → lib/client.js 的 relay
 *
 * 「必须」是单独一列，不混在动作里：缺一个必须动作，页面拒绝加载并说清缺哪个；
 * 缺一个可选动作只是那个能力不亮，页面照常打开（见 `capability`）。
 *
 * 这张表刻意不 import 任何东西：宿主（Node）和侧栏（浏览器）都要读同一份。
 */

/** 侧栏 relay 认识的转交方式。表里出现别的方式 = 侧栏送不出去。 */
export const RELAY_KINDS = ['bytes', 'json', 'raw']

/**
 * 桥提供、但不单独落到某条入口上的成员。
 *
 * `readText` 是桥在 `read` 之上做的便利方法，两种宿主都在桥内部实现它；`on` 和
 * `connect`/`VERSION` 是桥的启动面。它们和动作一样属于「桥必须提供」。
 */
export const BRIDGE_MEMBERS = [
  { name: 'connect', required: true },
  { name: 'VERSION', required: true },
  { name: 'readText', required: true },
  { name: 'on', required: true },
]

/**
 * 一个动作一行。
 *
 * - `name`       桥的方法名，也是侧栏分派时认的名字。
 * - `required`   桥必须有它；`false` 时缺席只丢 `capability`，页面照常加载。
 * - `capability` 这个动作撑起哪个功能开关；`null` 表示它与开关无关（页面的基本动作）。
 * - `route` / `methods` / `requestBody`  宿主入口的注册信息。
 * - `handler`    宿主里实现这条入口的处理器名（index.js 提供同名实现）。
 * - `relay`      侧栏怎么把这一行送到入口：`kind` 是 bytes / json / raw，
 *                `query` / `body` 列出要带上的字段，`reply` 说明回执怎么翻译。
 */
export const ACTIONS = [
  {
    name: 'asset',
    required: true,
    capability: null,
    route: '/api/review.asset',
    methods: ['GET'],
    requestBody: 'buffered',
    handler: 'asset',
    relay: { kind: 'bytes', method: 'GET', query: ['surface', 'rel', 'v'], optional: true },
  },
  {
    name: 'read',
    required: true,
    capability: null,
    route: '/api/review.asset',
    methods: ['GET'],
    requestBody: 'buffered',
    handler: 'asset',
    relay: { kind: 'bytes', method: 'GET', query: ['surface', 'rel'], optional: true },
  },
  {
    name: 'write',
    required: true,
    capability: null,
    route: '/api/review.write',
    methods: ['POST'],
    requestBody: 'buffered',
    handler: 'write',
    relay: { kind: 'json', method: 'POST', body: ['surface', 'sessionId', 'payload'], reply: 'value' },
  },
  {
    name: 'draft',
    required: false,
    capability: 'draft',
    route: '/api/review.draft',
    methods: ['POST'],
    requestBody: 'buffered',
    handler: 'draft',
    relay: { kind: 'json', method: 'POST', body: ['surface', 'payload'], reply: 'value' },
  },
  {
    name: 'draftRead',
    required: false,
    // 读回不撑起 `draft`：能不能存与能不能读回是两件事。一份 0.3.x 的桥能写
    // 草稿但没有 `draftRead`，人写的东西也必须存得下来 —— 用同一个开关捆死
    // 会让这种桥上的草稿写入直接 403，而且页面上看不到原因。
    capability: null,
    route: '/api/review.draft',
    methods: ['GET'],
    requestBody: 'buffered',
    handler: 'draft',
    relay: { kind: 'json', method: 'GET', query: ['surface'], reply: 'value' },
  },
  {
    name: 'command',
    required: false,
    capability: 'command',
    route: '/api/review.command',
    methods: ['POST'],
    requestBody: 'buffered',
    handler: 'command',
    relay: { kind: 'json', method: 'POST', body: ['surface', 'payload'], reply: 'value' },
  },
  {
    name: 'wake',
    required: true,
    capability: null,
    route: '/api/review.wake',
    methods: ['POST'],
    requestBody: 'buffered',
    handler: 'wake',
    relay: { kind: 'json', method: 'POST', body: ['surface', 'unit', 'text', 'sessionId'], reply: 'wake' },
  },
  {
    name: 'upload',
    required: false,
    capability: 'asset-upload',
    route: '/api/review.upload',
    methods: ['POST'],
    requestBody: 'streaming',
    handler: 'upload',
    relay: { kind: 'raw', method: 'POST', query: ['surface', 'rel'], reply: 'upload' },
  },
]

/** Every name a bridge must provide, in table order (actions first, then the boot face). */
export const BRIDGE_API = [...ACTIONS.map((action) => action.name), ...BRIDGE_MEMBERS.map((member) => member.name)]

/** The names the page cannot live without; a bridge missing one is refused. */
export function requiredBridgeApi() {
  return [
    ...ACTIONS.filter((action) => action.required).map((action) => action.name),
    ...BRIDGE_MEMBERS.filter((member) => member.required).map((member) => member.name),
  ]
}

/** The names whose absence only costs a capability. */
export function optionalBridgeApi() {
  return [
    ...ACTIONS.filter((action) => !action.required).map((action) => action.name),
    ...BRIDGE_MEMBERS.filter((member) => !member.required).map((member) => member.name),
  ]
}

/** The actions that together make one capability work on the bridge. */
export function actionsForCapability(capability) {
  return ACTIONS.filter((action) => action.capability === capability).map((action) => action.name)
}

/**
 * Host entries derived from the table: one registration per distinct route, with
 * the union of the methods its actions use. Two actions sharing a route (asset /
 * read, draft / draftRead) must agree on the handler and the body mode.
 */
export function actionRoutes() {
  const byPath = new Map()
  for (const action of ACTIONS) {
    const existing = byPath.get(action.route)
    if (existing === undefined) {
      byPath.set(action.route, {
        path: action.route,
        methods: [...action.methods],
        requestBody: action.requestBody,
        handler: action.handler,
      })
      continue
    }
    if (existing.handler !== action.handler) {
      throw new Error(`动作 ${action.name} 与同一个入口上的其他动作用了不同处理器：${existing.handler}`)
    }
    if (existing.requestBody !== action.requestBody) {
      throw new Error(`动作 ${action.name} 与同一个入口上的其他动作用了不同请求体模式`)
    }
    for (const method of action.methods) {
      if (!existing.methods.includes(method)) existing.methods.push(method)
    }
  }
  return [...byPath.values()]
}

/** The table as the sidebar reads it: what to send where, and how to read the reply. */
export function servedActions() {
  return ACTIONS.map((action) => ({
    name: action.name,
    required: action.required,
    capability: action.capability,
    route: action.route,
    methods: [...action.methods],
    requestBody: action.requestBody,
    relay: action.relay,
  }))
}
