## 0.3.3 — 2026-11-13

**同一份产物被两个面打开时，`review_open` 出声。**

宿主不做锁（它不写产物，锁也管不住模型直接改文件），但"两个面各自提交、后者覆盖前者"
是这个缝里最容易静默发生的事故。现在同一份 entry 已经由另一个面打开时，`warnings` 里会
指名那一份并说清后果 —— 不拦，人愿意并排看两份是自由。登记按 entry 的 realpath 记，
30 分钟过期；同一个面刷新不算冲突。

测试 62 条（新增 `test/entry-ownership.test.mjs` 一条：第一个面不告警、刷新不告警、
第二个面告警并指名、换回来再告警）。

## 0.3.2 — 2026-11-13

**给普通 HTML 产物加一层批注；顺带把"必须有注入点"这条硬门槛拆了。**

- **`annotate: true`**：宿主动把 `planners-review-core/assets/annotate/annotate.js` 内联进入口页（页面可留裸 `{{REVIEW_ANNOTATE}}`，不留就补在 `</body>` 前）。人在产物上直接改正文、点选元素、框选区域、选中一句话；产出 `artifact-annotations/1`，走同一个 `feedback` / `draft` / `wake`。产物不需要任何改动 —— 连注入点都可以没有。
- **缺 `{{REVIEW_BRIDGE}}` 不再 409**：桥同样补在 `</body>` 前。原来的理由是"不给一个永远连不上宿主的页面"，而自动补齐之后那个前提不成立了。校验器相应把错误降成 `bridge_placeholder_absent` 警告（老版本宿主仍会拒绝）。
- **草稿能读回**：新增 `GET /api/review/draft` 与桥的 `draftRead()`（`BRIDGE_API` 同步加名）。刷新、切标签、产物被重新生成之后，未提交的批注能回到页面；页面按 `base.version` 判断是不是同一版，不同就问人，不静默丢。
- **注入助手统一**：三种注入点写法（裸标记 / `<script src>` / `<script>`）与"没有注入点"走同一个 `injectScript`；桥永远在批注层之前，批注层排在前面会一直等不到桥。
- **测试**：`bridge-injection` 从"缺注入点必须 409"改成"补齐且只有一个完整 script"，新增 `annotate:true` 两条（有无 `{{REVIEW_ANNOTATE}}`）；全量 61 条。

## 0.3.1 — 2026-11-08

**DSH 0.2.2 升级后，唤醒核验静默失效；顺带把"模型不知道有这个面"补上。** 这一版没有改
`review-surface` 契约、没有改桥、没有改落盘字节 —— 与 `planners-review-core` 的接缝原样保留。

- **宿主：唤醒核验迁到 0.2.2 的 API。** 0.2.2 删掉了 `sessionController.inspect()`（0.2.1
  及以前是日志读口），旧代码无条件调它，异常被两个空 `catch` 吞掉 —— 日志核验整段变成死代码：
  - `before` 恒为 -1，"只认比本次调用更新的证据"这条规则失效；
  - 消息被回合取走、或**同一次提交重发**时，全部报 `502 undelivered`，原本应报 `in-turn` / `409 duplicate`。
  现在三个形状都探：`state({sessionId})` + `events({address,maxMessages})`（0.2.2+）、`inspect`
  （≤0.2.1）、两者都无时返回 **`accepted-unverified`**（HTTP 200 + `warning`，面板原话显示，
  既不假绿也不假红）。`before` 优先取活的 `agent.session.seq - 1`，不再为一次唤醒读整条日志。
- **宿主：启动时探测 API 漂移。** 逐项检查 `connection.fetch.register` / `tools.register` /
  `sessionController.prompt` / `inspect|state` / `agents.get`，缺什么 `warn` 一次；不再让
  "方法改名"表现为一次莫名其妙的人类提交失败。
- **模型发现缝：** 注册一段 system prompt（`tool:review_open`，order 2950，`interpolate: false`）：需要人审阅/判断/
  修改/选择/批准时，做 `review-surface.json` + 带裸 `{{REVIEW_BRIDGE}}` 的页面，按
  `planners-review-core` 校验后调 `review_open`；"打开不等于同意，等提交那条消息"。提示只指名
  Skill、不复制契约，契约仍只有一份。`interpolate: false` 是必须的：提示文本默认插值，
  `{{REVIEW_BRIDGE}}` 会被当成变量引用，轻则标记消失、重则每一轮提示组装失败。
- **上传上限改成读入时计数。** 路由改 `requestBody: 'streaming'`：先看 `Content-Length`，再边流边
  数，越过 16 MiB 立即取消 —— 之前是连接层缓冲到 300 MiB 之后再比，上限形同虚设。
- **feedback / draft 改成原子写**（同目录临时文件 + rename）。字节与无插件宿主逐字节一致，
  只是不再可能留下半截 JSON。
- **桥的选择不再缓存整个生命周期。** `/api/review.page` 每请求按 mtime 重新解析；否则改了
  library 源里的桥，页面内联的仍是发布副本直到重启，而 `review_open` 的预检（每次重解析）
  会看到新桥并报"准备好了" —— 两边说的不是同一份文件。
- **asset 改成流式送出**，不再把整个文件读进宿主内存。
- **客户端：** 轮询改为 `setTimeout` 链（不叠请求）、跟随宿主 `pollMs`、窗口隐藏时跳过；
  `init.host.version` 改由宿主从 `package.json` 读（不再写死 `0.3.0`）；同源帧的
  `postMessage` 用具体 origin 而不是 `'*'`；`accepted-unverified` 显示为"已提交；无法核对送达"；
  状态行加 `aria-live`；guide / 空态文案去掉内部术语。
- **契约版本不匹配进 warnings**：`contract_version` 不是 `review-surface/2.0.0` 时
  `review_open` 明说（不拒绝 —— 手改过的面该能打开，但绝不该安静）。
- **审阅标签绑回它自己的对话（修 BUG）。** 症状：在对话 A 里开的 PPT 审阅，弹到了当前正在看的
  对话 B 的侧栏。根因：放置走的是全局 `ctx.sidebarRight.openTab`，它**只作用于屏幕上那个对话**；
  而 A 的轮询器是常驻的，于是 A 的新面被写进了 B 的布局，还顺手展开了 B 的右栏。现在：
  - 放置优先用该标签自己的 `tab.actions.openTab`（DSH 的 per-tab 路径，落在标签所在对话）；
  - 只有「这个面自己的对话在屏幕上」时才允许用全局控制器，也**只有这时才展开右栏**；
  - 既没有本对话的放置器、对话又不在屏幕上时，面**停在待放置队列**，等切回该对话（或该对话的
    标签重新挂载）再放 —— 宁可不弹，也不弹错对话；
  - 已经放过的面不再开第二个标签（同一份面只有 revision 变化，由 store 重键帧）；人关掉标签后
    用布局里的审阅标签数变少来发现，允许下一次 `review_open` 重新放回来；如果标签还在但帧没挂载
    （侧栏收起/对话未绘制），`review_open` 只展开右栏、不再开第二个标签；
  - 旧版本已经错放进错误对话、或被持久化布局带过来的标签：帧发现 params 里的对话与标签所在对话
    不一致时**拒绝渲染**，只显示「这份审阅属于另一个对话」。
- **测试 33 → 58 条**：wake 五态 × 两代 API、无读口、`prompt` 缺失；上传上限四条；桥的三种
  注入形态 + 缺注入点 + contract warning；模型发现段的注册/卸载/无服务；对话绑定五条（放置走
  标签自己的 actions、展开闸门、待放置与关闭对账、已放置但帧未挂载时只展开不重开、错放标签拒渲染）。
- **已验（重启后，真实会话 self-test）**：system prompt 段进了下一轮请求；`review_open`/`/api/review.surface`
  的 host 是 0.3.1；页面经 `/api/review.page` 加载、桥连上；`write` 落盘字节与 draft 通道；第一次
  `wake` → `200 queued`（inbox 核验）；**同一次提交重发 → `409 duplicate`，`verified.where:
  "session log: user/message"`、`seq: 1827 < before: 1845`**（真实 `state`/`events` 日志读口）。
- **未验**：后台对话的双对话绑定演练、上传 413 的 live、错放标签提示与 `accepted-unverified` 的
  live 显示 —— 本文不把源码契约当成这些已经成立。

## 0.3.0 — 2026-10-21

**一份审阅面 = 一个标签页。** 0.2.x 的侧栏每个对话只有一个「当前面」：`review_open` 是
**替换**语义，第二次开审阅会把第一次从人眼前拿走 —— 正在改的那半页连同写了一半的意见一起
消失。这是接缝层面的问题，不是显示问题，所以改在宿主与契约两边。

- 宿主：`currentBySession` 的单值变成 **按对话的面清单**（`lib/surfaces.js`）。同一份面再
  `review_open` = 刷新那一个（`revision` 走一格，帧跟着重载），别的面不受影响。
- 宿主：`/api/review.current` 回 `surfaces: [{surface, revision, changedSeq, watching, title, id}]`；
  **旧的单值字段仍然保留**（取最新那一份），0.2.x 的面板对着新宿主照旧能跑。
- 宿主：`review_open` 遇到拿不到对话身份时**不再拒绝**（原来直接 `ok:false`，人不明所以地
  「打不开」）。这种面进入 10 秒的待认领队列，由当前显示的那次对话的侧栏认领，过期即丢 ——
  既不挡人，也不会漏进别的对话。
- 客户端：标签类型声明 `multiple: true`，每个标签从**自己的** navigation params 取面；轮询从
  "每帧一个"改成 **每个对话一个**（否则 N 个标签会把每个面开 N 次）；变化戳按面分发，一处变
  不再惊动整排标签；标签名改成面自己的 `title`，不再是一排「审阅」。
- 客户端：人开的空标签（guide 的「审阅」）**只认领一次**最新那份面并停在那里；轮询看到有空标签
  时不另开标签，否则同一份面会显示两遍。
- 已知取舍：轮询器不随帧卸载而销毁，"已经显示过的 revision"要留着，否则人一关标签它下一次
  轮询就会把面开回来。

## 0.2.5 — 2026-10-17

- 审阅 iframe 从 `sandbox="allow-scripts"` 改为 `sandbox="allow-scripts allow-same-origin"`。
  原因：HyperFrames 官方播放器会在内部创建带 `allow-same-origin` 的嵌套 iframe；
  外层不透明源会让内层继承 sandbox 限制，播放器永远不 `ready`，工程态预览黑屏。
- 安全边界相应变化：审阅页现在是同源可信代码，可访问 DSH 应用 DOM / storage / API。
  只应加载可信 Skill 的审阅页。

本文件记录对外可见的变更。破坏性变更单独成节。

## 0.2.4 — 符号链接路径不再被误判成越界；0.2.1-rc.1 回归

**症状**（2026-10-17，DSH 0.2.1-rc.1 升级后）：surface 放在任何带符号链接的路径下（macOS `/tmp` → `/private/tmp`、链接式的项目目录、外挂盘）时，`review.draft` 与 `review.write` 回 **403「越出 project_root」**，而 Core 的 surface 校验器对同一份文件判 **valid**。页面于是"能审、保存不了"。

**根因**：写入前把 `project_root` realpath 了，却拿它跟**未 realpath 的目标路径**做前缀比较。两侧不在同一个坐标系里，链接路径永远比不中；这跟权限、能力声明都无关。

**修复**：新增 `realpathTarget()` —— 先 realpath 最近的存在祖先，再把尚未创建的尾巴拼回去（写入方本来就负责 `mkdir -p`）。`draft` 与 `write` 两条路由都改成 **real 对 real**。真正的越界（目标是链接到根外的文件）仍然 403。

**回归**：`npm test` 新增 `test/path-containment.test.mjs`，两例 —— ①经符号链接祖先的 surface 能正常写 draft/feedback；②目标经链接指向 `project_root` 外时必须 403。fixture 漂移另修：`commandFixture({ backend: 'candidate' })` 现在会连同 `workbench_store.py` 的兄弟 Python 模块（`canvas_frame.py` 等）一起复制，命令链路两条红测回绿。

**0.2.1-rc.1 回归**（隔离 `DSH_HOME` 实测）：组合树出现 `# == dsh-review-dock`；`review_open` 在工具表；`sidebar.right.pane.tab` 占用者含 `dsh-review-dock`；`review.current/surface/page/bridge/asset/draft/write/wake` 的 200/400/403/404 行为与 0.2.0-rc.2 一致；`review.bridge` 返回的字节与 Core 桥 sha256 相等。宿主 API 逐项核对未变（`connection.fetch.register`、`tools.register`、`sessionController.inspect/prompt`、`agents.get(id).inbox`、`agent/inbox/spliced`、`sidebarRightTabs.register({ keepMounted })`、`sidebar.right.pane.tab` 与 `.title`）。另：`client.js` 上报的 host version 由陈旧的 `0.2.0` 改为包版本 `0.2.4`。

## 0.2.3 — 多一条 `/api/review.draft`：草稿与决定分开两个文件

**起因（来自 planners-ppt-hell 的真人反馈）**：作者问「我的意见、框选、直改应该自动落盘在文件里，为什么还需要提交？」——因为以前只有 `write` 这一条落盘路径，而它同时是「提交 ＋ 唤醒模型」。于是没提交的东西只活在页面内存里，刷新即丢；人以为「提交」是保存按钮。

**改了什么**：新增 `POST /api/review.draft`，和 `write` 同一个纪律（payload 就是文件、与无插件宿主逐字节一致、落盘前做 `project_root` 包含性校验），但是**另一个文件**：`feedback` 是**决定**（Skill 按轮次收件），`draft` 是**未提交的草稿**（Skill 不许当它是收件）。surface 用 `draft` 字段声明落点，用 `draft` 能力告诉页面可以走这条路（`HOST_CAPABILITIES` 加 `draft`）。

**为什么必须分开**：合成一个文件就等于把「我改了东西」和「告诉模型可以动手」绑成一个动作 —— 模型会在半句话上开始动手。

**拒绝的情形**：surface 没声明 `draft`（409）、`draft` 越出 `project_root`（403）、`draft` 与 `feedback` 是同一个文件（409）。

**验证**：`planners-review-core` 的 `node evals/run.mjs` 里加了两条（桥的两条通道都实现 `draft` 且按 capabilities 声明走；无插件宿主 `POST /__review/draft` 原样落盘且不与 feedback 同文件）。两个宿主对同一条路由的行为由那一份回归同时盯着。

。破坏性变更单独成节。

## 0.2.2 — 重发同一次提交不再唤醒两次

**症状**：人点一次「本页要求修改」，模型有时会认为自己收到了两条同样的消息。

**根因**：唤醒身份按契约是"本次 feedback payload 的哈希"，靠页面每次 `collect()` 盖上新的 `provenance.submitted_at` 与新的 `items[].id` 来区分不同提交。可这三个字段**在同一次提交被重发时也会变** —— 页面重试、断线重连、重新投递，拿到的是一个**新身份**，于是去重不生效，`prompt` 被真的投了第二次。README 里写的"同一次提交重发时 payload 不变 → 身份不变 → 天然幂等"，在页面这一侧从来不成立。

**修复**：哈希前先过一层 `submissionIdentity()`，剥掉三样投递记录 —— `provenance.submitted_at`、`provenance.wake`、每条 `items[].id`。结论、文字、框选、图片、每页版本号全部留在哈希里，所以真改过的提交照样是新身份；同一次提交重发则拿到同一身份，被去重成一次。

**边界（这一版没有改的）**：`agent/inbox/spliced` 与随后的 `user/message` **不是两条消息**，是同一条消息（同一个 `requestId`）在 DSH 里的两段式交接：先进持久队列（`target=next-turn`），回合开始时被提升到 `next-step`，再被回合取走成为 `user/message`。会话日志里按 `requestId` 去重后，每次提交只有一条 `user/message`；这一版不动 `wake.mode`（`queue` 仍是空闲会话唯一的投递路径）。

**回归**：`npm test`（`test/submission-identity.test.mjs`，5 例）。它把 `lib/index.js` 里的真函数切出来跑，不是另抄一份：同一次提交重发（只改 `submitted_at`／`wake`／`items[].id`）身份不变；唤醒后那次写回不得推进身份（否则两次重叠点击会交叉成两个身份）；改了 `feedback` 文字身份必变；换会话身份必变；剥离只动投递记录、不丢内容、也不改调用方传进来的对象。

## 0.2.1 — 让 0.2 线的 DSH 能认出这个插件

**症状**：DSH 桌面应用升到 `0.2.0-rc.2` 之后，右侧栏的「审阅」标签和 `review_open` 工具一起消失；profile 里的声明看着完好。

**根因**：`peerDependencies` 只写了 `"@deepseek-ai/dsh": "^0.1.7-rc.1"`。`^0.1.x` 的上界是 `0.2.0`（不含），而 `0.2.0-rc.2` 落在 `<0.2.0` 之内 **却仍被 semver 判为不满足**（上界比较器没有 prerelease，prerelease 不参与）。宿主的 `loadProfile` 因此把这条 bundle 跳过；由应用托管的 `desktop` profile 跳过时**不打印任何东西**，于是它是静默消失的。

**修复**：`peerDependencies` 改为 `"@deepseek-ai/dsh": "^0.1.7-rc.1 || ^0.2.0-rc.1"`。0.1 线与 0.2 线都在闸门内；`0.3.0` 仍然被拒并照旧给出 `dsh plugin allow-version` 处置命令。

**回归**：见 README 的「已验证 → `0.2.0-rc.2` 上的回归」。宿主 API 逐个核对未变（`connection.fetch.register`、`tools.register`、`sessionController.inspect/prompt`、`agent/inbox/spliced`、`sidebarRightTabs.register`），因此这一版**只动版本闸门，不动任何一行业务代码**。

## 0.2.0 — 泛化：插件不再懂任何一种审阅

这一版把插件从"一个带自己审阅 UI 的 ppt 面板"改成"任何审阅面的宿主"。**没有兼容层**，按 Q4 的裁定：老的不要了。

### 破坏面（升级前必读）

| 面 | 从 | 到 |
|---|---|---|
| **工具名** | `ppt_review_open` | **`review_open`** |
| **工具入参** | `project_root`（项目根目录） | **`surface`**（`review-surface.json` 的绝对路径） |
| **契约** | `review-surface/1.0.0`（含 `units` / `version` / `decisions` / `required_decisions` / `assets`） | **`review-surface/2.0.0`**（只剩 `dir` / `entry` / `feedback` / `wake` / `capabilities`） |
| **HTTP 面** | 裸挂 `webServer.register({ kind: 'prefix', path: '/ppt-review' })`，**无鉴权** | 全部移到 `connection` 的 **`/api/review.*`** 栅栏下（无 cookie 一律 401） |
| **标签页 kind** | `ppt-review` | **`review`** |
| **注册表目录** | `~/.dsh/ppt-review-dock/`（`projects.json` / `last-submit.json`） | **不再存在** —— 插件不再记项目；当前面按 **DSH 会话** 保存在进程内会话表 |
| **会话隔离** | 进程级单例 / 浏览器 `localStorage` | **按 DSH 会话隔离**：`review_open` 必须拿到 `sessionId`，`/api/review.current` 也必须带同一身份 |
| **bundle patch 行 id** | `ppt-review-dock` | **`review-dock`**（profile 的 `dsh.profile.bundles` 里仍是包名 `dsh-review-dock`，不用改） |
| **自带审阅 UI** | 缩略图轨 / 16:9 舞台 / 框选 / 两枚决定按钮 | **删除** —— UI 下沉到产出方自己的页面 |

**磁盘上旧的 `~/.dsh/ppt-review-dock/` 保持原样，不会被读也不会被删。** 想清掉自己 `rm -rf`。旧的浏览器 surface 缓存不迁移，也不再作为会话绑定依据。

### 新增

- **`review-surface.json` 2.0.0 宿主**：`GET /api/review.surface` 送出面元信息（`id` / `title` / `capabilities` / `wakeMode`），父页面在回答桥的 `init` 之前必须知道这些。
- **`{{REVIEW_BRIDGE}}` 注入点**：`GET /api/review.page` serve 入口 HTML 时把桥注入进去。认两种写法 —— `<script src="{{REVIEW_BRIDGE}}"></script>`（整元素替换）与 `<script>{{REVIEW_BRIDGE}}</script>`（裸标记替换）；缺注入点直接拒绝，不送一个永远连不上宿主的页面。
- **资产与桥都走"宿主递字节"**：`GET /api/review.asset` 取回字节，父页面 `arrayBuffer()` 后 postMessage 给帧（结构化克隆，**不走 base64**），帧自己 `URL.createObjectURL`。桥则内联注入。原因是实测：不透明帧自己发起的任何子资源请求都带 `Sec-Fetch-Site: cross-site` + 无 cookie，被 `/api` 栅栏在认证前打成 **403** —— `<img>` 与 `<script src>` 同根。`/api/review.bridge` 保留为桥字节的具名出处。
- **`POST /api/review.wake` 真递 prompt**：按 surface 的 `wake.mode`（`queue` / `steer`）调 `sessionController.prompt`，`wake.text` 里的 `{unit}` 用提交上来的 unit 替换；requestId 由内容决定，同一次提交不会唤醒两次。
- **唤醒核验**：`wake` 回读确认那句话真的进了 Agent 收件箱，返回 `verified`（`agents.get(sessionId).inbox` / `agent/inbox/spliced` / `user/message` 三处之一）。核验不到如实说 `found: false`，没有 `sessionId` 直接 `ok: false` —— 不假装成功。
- **`capabilities` 透传**：surface 声明了什么，桥的 `init` 就原样带给页面。`upload` 本轮只透传能力、不实现，调用会明确失败，页面据此退化。
- **`keepMounted: true`**：切走标签页后帧保持存活，人写了一半的审阅不会因为"看了一眼终端"而消失。
- **`GET /api/review.current`**：面板据此发现"Agent 打开了另一个面"（`revision`）并认领标签页。
- **`read` / `readText` 桥方法**：与 `asset` **共用同一条取数路径**（同一个路由、同一份 realpath 校验、同样的同源 cookie），差别只在帧拿字节之后做什么 —— `asset` 造 blob URL，`read` 交原始字节、`readText` 解码。以前客户端只实现了 `asset`/`write`/`wake`/`upload`，于是页面的 `read('…')` 落到"未知的桥方法"，被页面 catch 掉 → **页面一点都不动** —— 正是"插件页面没有变化"的直接原因。
- **桥的完整性闸门**：内联桥之前先核对它是否具备本宿主会用到的每一个方法（`connect`/`VERSION`/`asset`/`read`/`readText`/`write`/`wake`/`upload`/`on`），缺任何一个就明确拒绝并指名"哪一份、缺什么"，`review_open` 里也先跑一遍。绝不内联一份缺方法的桥。
- **`watch` + `changedSeq`（变化戳）**：surface 可选声明一组**相对自身的**路径；宿主每 2 秒在 `/api/review.current` 上顺手 `stat` 它们，**只看 `mtime`/`size`、从不读内容**，元数据一变就步进 `changedSeq`。客户端**每次步进只往帧里推一条 `{ type: 'review/changed' }`**（无 payload），帧不重载、人写的东西不动。刻意不用 SSE：`dsh-client-hmr` 的 SSE 是裸路由，与本版的"零无鉴权路由"冲突。

### `asset-upload` 真的能用了

- **`POST /api/review.upload?surface=&rel=`**：桥交上来的字节（`{ rel, name, bytes }`，桥先做 `file.arrayBuffer()`）作为**原始请求体**中继到宿主并落盘，**不转 base64**。返回形状与无插件宿主一致（`{ok, path, sha256}`，另加 `bytes`）。
- **能力双向钉住**：`HOST_CAPABILITIES` 加上 `asset-upload`（只在真的能做完之后加）；surface 不声明时，除了页面拿不到能力，**直接调这条路由也会 403** —— 能力是承诺，不是装饰。
- **上限 16 MiB**：无插件宿主没有上限（只有连接层 300 MiB 兜底），这是**缺口不是范本**；字节要经过 postMessage 中继、在父页面与帧里各驻留一份，所以一次调用有界。超限回 413 并写明字节数。
- **写路径的包含性校验比 `asset` 多两条**：拒绝写到现有的符号链接上；拒绝"最近的已存在祖先经 realpath 后落在 dir 之外"（否则 dir 内一个指向外部的软链目录就能把文件写到外面）。

### `watch` 的解析基准修对了，跳过也不再静默

- **`watch` 按 surface 文件解析**（schema / 校验器 / 无插件宿主 / 本文件自己的注释都是这么定的），而不是按 `dir`。以前按 `dir` 解析，子目录里的面写 `"../timeline/timeline.json"` 就会指到 `dir` **之外**、被静默跳过 —— 面"打开成功"但**戳是哑的**。实测：修之前宿主 `stat` 的是 `<项目>/../timeline/timeline.json`（不存在，token 恒定）；修之后改真正那份文件，`changedSeq` 恰好步进一次。
- **跳过的 watch 项会出声**：`review_open` 的返回里新增 `warnings`（越出 `dir` 的项会指名 rel、解析后的绝对路径，并指出校验器对同一种情况报 `watch_outside_dir`）。面照开，但不再让人对着哑面干活。

### 注入点与 `capabilities` 两处契约对齐（公共件定死了规范，宿主跟上）

- **注入：三种页面写法都出一个可用的页面。** 规范是**裸标记独占一行**（公共件 SKILL.md、architecture.md、校验器三处都这么定，校验器还有 `bridge_placeholder_not_bare`/`bridge_placeholder_multiple` 两道闸门），而以前裸标记只被换成**源码**、直接插进正文 —— 那不是 script，桥不执行，**页面安静地死掉**。现在标记（或包着它的那个元素）整体换成一段完整的 `<script>`；`<script src="{{REVIEW_BRIDGE}}"></script>` 与 `<script>{{REVIEW_BRIDGE}}</script>` 两种旧写法同样支持。
- **`capabilities` = 宿主支持 ∩ surface 声明。** 以前发的是 surface 声明的清单，而无插件宿主回的是它自己支持的清单 —— 同一个字段两种含义，页面没法判断该不该摆上传控件。现在这一列是**这个面现在真正能用的**；`asset-upload` 尚未实现，因此**任何声明都不会被广告**（否则页面会摆出一个必然失败的控件）。

### 通知不再被静默吞掉（量出来的：幂等 id + 假绿核验）

- **唤醒身份改为"这一次提交"**：以前是 `sha256(sessionId, surface, unit, text)`，而页面的整套提交永远送同一句话 → 同一会话里第二次以后的整套提交被宿主的 requestId 去重**静默丢弃**（宿主命中去重时 `return {accepted:true}` 且不投递）。现在折进本次 feedback payload 的哈希（页面每次提交都带新的 `submitted_at`/`items[].id`）：**新提交 = 新身份，同一次提交重发 = 同一身份**（重试因此幂等）。`POST /api/review.write` 现在必须带 `sessionId`。
- **核验改为按 seq 界**：只承认 **`seq > 本次 prompt 之前的最大 seq`** 的证据。老实现从日志末尾扫整条日志找同 id，会把**上一次**投递当成这次的证据 —— **恰好在出事那一次报成功**。现在四种状态如实返回：`in-turn` / `queued`（200）、`duplicate`（409，带旧 seq 与 before）、`undelivered`（502）。
- 没有前置 write 的唤醒拿一个每次调用都不同的身份：没有提交可幂等，就绝不静默去重。
- **面板层把 `duplicate` 透传成"准确的成功"**：宿主层仍然是 409（那确实不是一次新投递），但中继不把它变成「保存失败」—— 显示「已写入；本次没有新增通知（同一次提交之前已送达）」。把成功说成失败是**假阴性**，和假阳性一样骗人。

### 两处"宿主越权"的修正（第一次真人审阅当场抓到）

- **`write` 原样落盘**：以前写的是 `{receivedAt, payload}` 信封，产出方读不懂自己页面交出去的反馈，整条回路在插件路径上断掉。现在写的就是 payload 本身（`JSON.stringify(payload, null, 2)` + 换行），与 `serve-review.mjs` **逐字节一致**。
- **`wake` 优先用页面给的整句话**：页面 `wake({ unit, text })` 里的 `text` 覆盖 surface 的模板；没给才回落模板并替换 `{unit}`。以前一律套模板，于是"整套提交"被说成自相矛盾的"整套 已定；只重出这一页"。
- 顺带：宿主在多个已安装的 `review-bridge.js` 副本中改为**挑最新的那一份**（发布副本曾经悄悄赢过刚改过的源）。

### 移除

- `/ppt-review/*` 全部六条路由（含**有写副作用**的 `GET /projects`，它会向 `~/.dsh/ppt-review-dock/projects.json` 落盘）。**本插件现在不注册任何无鉴权路由。**
- `page_manifest.json` 读取、`inbox.jsonl` / `inbox.cursor` 写入、`1920×1080` 画布常量、`mode: '读'`、项目扫描、`live` 单例、工具描述与提示词里点名某个 Skill、"重画 SVG / 只重出这一页 PNG" 这类产出方专有指令、以及整套自带 React 审阅 UI。
- `lib/client.js` 的样式注入与旧 tab kind。

### 文档

- README 逐条核对到与新代码一致：契约版本、HTTP 面、状态存放位置、"路由不走认证层"（**现在这句是反的 —— 全部走认证**）、以及所有与已删 UI 绑定的"已知边界"。
- NOTICE 里的 `first consumer` 保留 —— 那是来源署名，不是代码耦合。

### 变化戳的线协议

本插件只送规范拼法 `{ type: 'review/changed' }`（无 payload，契约 `review-surface/2.0.0`）。已在真实浏览器的真实侧栏里验证它**经桥的 `review.on('changed')` 抵达页面**，且控制台零输出（旧拼法 `changed` 与不认识的 `review/*` 类型都会让桥出声，两者都没有出现）。

### 已验证 / 未验证

- **已验证**：DSH 0.1.7-rc.2 + Chromium 147（headless，Playwright），在隔离 `DSH_HOME` 上驱动真实侧栏标签页：桥连上、真实图片在帧内显示、`write` 落盘、`wake` 产生真 prompt、伪造帧被 `event.source` 判掉、`keepMounted` 保活。
- **未验证**：`upload` 的写侧；DSH 0.1.7-rc.1 的逐项回归；多会话并行下的面板归属。
