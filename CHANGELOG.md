# CHANGELOG

本文件记录对外可见的变更。破坏性变更单独成节。

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
| **注册表目录** | `~/.dsh/ppt-review-dock/`（`projects.json` / `last-submit.json`） | **不再存在** —— 插件不再记项目；「最近的面」按浏览器记在 `localStorage['dsh-review-dock:surface']` |
| **localStorage 键** | `ppt-review-dock:root` | **`dsh-review-dock:surface`**（存 surface 文件路径，不是项目根） |
| **bundle patch 行 id** | `ppt-review-dock` | **`review-dock`**（profile 的 `dsh.profile.bundles` 里仍是包名 `dsh-review-dock`，不用改） |
| **自带审阅 UI** | 缩略图轨 / 16:9 舞台 / 框选 / 两枚决定按钮 | **删除** —— UI 下沉到产出方自己的页面 |

**磁盘上旧的 `~/.dsh/ppt-review-dock/` 保持原样，不会被读也不会被删。** 想清掉自己 `rm -rf`。旧的 `localStorage['ppt-review-dock:root']` 不会被迁移，也不会被读。

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
