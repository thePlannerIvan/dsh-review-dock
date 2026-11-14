# DSH Review Dock · 开发者架构与接口说明

本文档承接原 `README.md` 中的全部内部架构决策、HTTP 路由面、安全边界、唤醒核验机制与历次真机验证矩阵。普通安装与功能概览请看 [README.md](README.md)；按版本演进记录请看 [CHANGELOG.md](CHANGELOG.md)。

**测试入口**：`npm test`（执行 `node --test test/*.test.mjs`）。

---

## 1. 核心架构与接缝边界

`dsh-review-dock` 是 DSH 与 [`planners-review-core`](https://github.com/thePlannerIvan/planners-review-core)（`review-surface/2.0.0`）之间的通用宿主插件，只负责四件事，**不解析任何下游业务语义**：

| 职责 | 实现模块 / 机制 | 说明 |
| --- | --- | --- |
| 选哪个面 | 工具 `review_open` + `GET /api/review.current` | 按对话（`sessionId`）维护面清单，一份面对应一个标签页；客户端 `setTimeout` 链每 2 秒轮询一次，窗口隐藏跳过 |
| 展示页面 | `GET /api/review.page` | 读取 `review-surface.json` 指向的入口 HTML 并内联最新 `review-bridge.js`（开发主线 `0.3.2+` 同时按 `"annotate": true` 内联 `annotate.js`） |
| 递送与接收字节 | `/api/review.asset` / `.bridge` / `.upload` | 父页面代帧取回资产并用结构化克隆 `postMessage` 递入，流式限制上传不超过 16 MiB |
| 落盘与唤醒模型 | `/api/review.draft` / `.write` / `.wake` | `draft` 与 `feedback` 严禁共用同文件，原样写盘与无插件宿主逐字节一致；`wake` 做投递去重与日志回读核验 |

### 模型发现接缝

宿主启动时向系统提示注册一段轻量说明（`tool:review_open`，order `2950`，声明 `interpolate: false`），指示模型在需要人工审阅或拍板时构建遵循 `planners-review-core` 的审阅面并调用 `review_open`（且告知“打开不等于同意，等提交消息后再修改”）。设置 `interpolate: false` 是必需的——否则模板引擎会将 `{{REVIEW_BRIDGE}}` 误判为待插值变量而报错。

---

## 2. 为什么走“宿主代传字节”与 iframe 边界

- **为什么子资源必须由父页面中转**：早期实测在 `opaque` origin 下，iframe 自己发起的任何子资源请求到达 DSH 时都会带 `Sec-Fetch-Site: cross-site` 且无浏览器 cookie，被 `/api` 信任围栏直接 403 拦截。因此确立协议：父页面（同源带 cookie）先 `fetch('/api/review.asset')` 取 `arrayBuffer()`，再经 `postMessage`（结构化克隆，不走 base64）转交给子帧自建 `blob:` URL；通信桥同样按源文件每次请求重新按 mtime 选取最新 `review-bridge.js` 后**内联注入**（`/api/review.bridge` 保留作具名出处）。
- **sandbox 安全边界取舍（0.2.5 起）**：审阅 iframe 使用 `sandbox="allow-scripts allow-same-origin"`，原因是 HyperFrames 播放器等工程预览会在页面内嵌同源 iframe；此设定下审阅页被视作同源可信代码，仅可加载可信 Skill 的页面。

---

## 3. HTTP 接口清单

全部十条路由均挂在 DSH Connection 的 `/api` 认证栅栏之下：**无有效浏览器会话 cookie 一律返回 401**（与未注册路径行为一致，验路由在不在必须带 cookie 对照 `/api/review.nonexistent` 回 404）。

| 方法与路径 | 用途 | 关键校验与约束 |
| --- | --- | --- |
| `GET /api/review.current?sessionId=<id>` | 获取本对话审阅面清单、`revision` / `changedSeq`、`pollMs` 与旧兼容字段 | 按 `sessionId` 隔离；拿不到 `sessionId` 时进入 10 秒待认领队列；每 2 秒顺带 `stat` 监视路径 |
| `GET /api/review.surface?surface=<abs>` | 返回面元信息（`id` / `title` / `capabilities` / `wakeMode` / `host`） | `contract_version` 不为 `review-surface/2.0.0` 时在 `review_open` 返回 `warnings` |
| `GET /api/review.page?surface=<abs>` | 输出注入桥后的入口 HTML | `v0.3.1` 要求裸或 script 包裹的 `{{REVIEW_BRIDGE}}` 注入点，缺之 409；`v0.3.2+` 自动追加在 `</body>` 前，`"annotate": true` 时同步内联 `annotate.js` |
| `GET /api/review.bridge` | 获取当前选中公共桥源文件文本 | 供外部检查出典，内联注入前强制核验 `BRIDGE_API` 方法完整 |
| `GET /api/review.asset?surface=<abs>&rel=<path>` | 流式读取 `surface.dir` 内单文件 | realpath 包含性校验防符号链接逃逸，拒绝越界 403 |
| `GET/POST /api/review.draft` | 读回或原样写入未提交草稿（`GET` 为 `0.3.2+` 新增，支持页面刷新/重生成后恢复未提交改动） | 要求 surface 声明 `draft` 且路径不得与 `feedback` 相同（否则 409）；`realpathTarget()` 祖先解析防软链逃逸，原子写落盘 |
| `POST /api/review.write` | `{ surface, payload, sessionId }` 原样写回 `feedback` 文件 | 无信封、换行与格式与无插件宿主逐字节一致 |
| `POST /api/review.command` | 可选命令通道 | 仅 surface 声明 `command` 能力时开放 |
| `POST /api/review.wake` | `{ surface, unit, text, sessionId }` 提交唤醒消息 | 页面有传 `text` 时覆盖模板 `{unit}`；无 `sessionId` 直接 `ok: false` |
| `POST /api/review.upload?surface=<abs>&rel=<path>` | 流式写盘原始二进制附件至 `dir` 相对路径 | 要求双方同时具备 `asset-upload` 能力（否则 403）；采用 `requestBody: 'streaming'` 边读边计数超 **16 MiB** 立刻 `cancel()` 回 413；目标已为软链或最近存在祖先落出 `dir` 均拒 403 |

### 3.1 `capabilities` 交集原则

`init` 下发给页面的 `capabilities` 永远取 **「宿主实际已实现能力 ∩ surface 声明能力」**：宿主绝不向页面广告自己不支持的能力，防止界面亮起必然失败的按钮。对 `upload`、`draft` 路由在未声明能力的 surface 上直接调用一律返回 403。

### 3.2 `watch` 变化感知协议

`watch` 数组中路径以 **`review-surface.json` 文件所在目录** 为基准（不是 `surface.dir`）。任何越出 `dir` 的条目在 `review_open` 返回的 `warnings` 中明确告警（对应校验器报 `watch_outside_dir`）。宿主轮询只读 `mtime` 与 `size`，步进时向帧推送规范事件 `{ type: 'review/changed' }`（无 payload、不重载页面），避免打断用户输入。不用 SSE 以维持零无鉴权路由红线。

---

## 4. 唤醒幂等（`submissionIdentity`）与日志回读核验

- **提交身份去重**：为解决“页面重试或重发同一轮提交被误投两次”以及“不同轮同一句唤醒词被宿主 `requestId` 去重静默吞掉”两难问题，`submissionIdentity()` 在算哈希前剥离每次提交随机产生的投递字段（`provenance.submitted_at`、`provenance.wake`、`items[].id`），仅保留实际结论、正文、框选、附件与版本号——从而保证**同一提交重发得同一 ID、实质修改得新 ID**；无前置提交的纯唤醒使用每次不同 ID，绝不静默丢弃。
- **跨代宿主 API 探测与 `seq > before` 判据**：
  - DSH `0.2.2+` 删除了 `sessionController.inspect()`，改为 `state({ sessionId })` 与 `events({ address, maxMessages })`；插件启动与唤醒同时探测新版 `state/events`、旧版 `inspect`（`<=0.2.1`），缺任一关键宿主 API 启动时发出 `warn`；两者都缺失时返回 HTTP 200 **`accepted-unverified`**（附明确提示）而不是假绿或假红。
  - 只认可时间戳/序列号**严格大于唤醒前水位 `before`（`seq > before`）**的证据（`agents.get(sessionId).inbox`、`session log: agent/inbox/spliced`、`session log: user/message`）：
    - 新入队 / 正在执行：`200 queued` / `200 in-turn`；
    - 检测到比 `before` 更旧的同 ID 记录：`409 duplicate`（客户端中继向人温和提示“已写入，同一次提交此前已送达”，避免假阴性报错）；
    - 超窗口未找到且非去重：`502 undelivered`。
  - 已知实测限度：在回合失败路径上观察到 `updateQueue` 不会自动排空队列（曾测得一条入队消息停留 64 秒直到下次 prompt 顺带取走）。

---

## 5. 多标签与对话隔离行为（0.3.0 / 0.3.1）

- 标签声明 `multiple: true`，每个对话维护一个常驻轮询器，保留已显示过的 `revision`：手动关闭的标签不会在 2 秒轮询时自动弹回，只有 Agent 再次调 `review_open` 递增 `revision` 才重建。
- **对话绑定**：优先调用所属对话标签自己的 `tab.actions.openTab`；仅当该面所属对话当前正在屏幕前激活时才允许走全局控制器展开右侧栏。若后台触发时无法安全放置则进入待放置队列，等切回该对话时渲染；误放入旧布局的错对话标签拒渲染审阅内容，只提示归属错误。
- **同文件多面打开提醒（0.3.3）**：宿主以入口文件 `realpath` 记 30 分钟登记表，同一 HTML 被两个不同审阅面同时打开时在 `review_open` 返回 `warnings` 明说，避免静默覆盖。

---

## 6. 开发模式与版本闸门

```bash
# 修改 lib/client.js 后免重启软链开发（host 侧 lib/index.js 改动仍需重启 dsh web）
ln -sfn /path/to/dsh-review-dock ~/.dsh/profiles/web/node_modules/dsh-review-dock
dsh web --dump-config | grep -A 2 review-dock
```

- `peerDependencies` 声明 `"@deepseek-ai/dsh": "^0.1.7-rc.1 || ^0.2.0-rc.1"`：由于 DSH `loadProfile` 按严格 prerelease 语义比对区间，写窄为 `^0.1.7-rc.1` 会导致桌面应用静默跳过 bundle。
- 实测环境记录（详情与边界见 [CHANGELOG.md](CHANGELOG.md)）：
  - **DSH `0.1.7-rc.2` / `0.2.0-rc.2` / `0.2.1-rc.1`**：隔离 `DSH_HOME` + Chromium 147 Playwright 全链路实测（桥连通、资产 blob URL、16 MiB/无能力 403、符号链真实路径、`read`/`readText`、`review/changed` 单次戳、安装与卸载对账）。
  - **DSH `0.2.2` + 桌面应用 `0.3.1`**：真机重启验证 system prompt 注入、`write`、`wake 200 queued`、重发 `409 duplicate`（真实 `state/events` 日志）与双面各自独立标签。
  - **本地待发布测试基线（0.3.2–0.3.4 工作区）**：`npm test` 62 条单元测试（含 `entry-ownership`、`bridge-injection`、`submission-identity`、`conversation-binding`、`upload-limits`、`wake-verification` 等）。
  - **尚未在真机/线上单独跑过的项**：`github:thePlannerIvan/dsh-review-dock` git 短地址直装、`.tgz` 安装包安装、多会话后台同时触发双对话真机演练、上传超限实时 413 与 `accepted-unverified` 运行时缺失真机演示。
