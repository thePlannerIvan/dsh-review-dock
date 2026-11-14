# DSH Review Dock

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-2563eb)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.1%20%7C%200.2.x-0f766e)](#安装)

**DeepSeek Harness（DSH）右侧栏的通用人工审阅宿主：Skill 只要交付一份页面声明，你就能在对话旁的侧栏里直接改稿、拖曳调序、存草稿、上传素材并一键把最终决定送回给 AI。**

> 作者：阿祖不看 TVC（小红书同名）· [demyth.info](https://demyth.info) · [Lawyif@163.com](mailto:Lawyif@163.com)

---

## 一句话看懂：它帮你做什么

没有侧栏宿主时，需要人工拍板或修改的工作（审 PPT 逐页稿、勾留文章修订、核对 Storyline、试用可播视频工程页）通常只能拆成孤立的临时网页：来回切换窗口、复制粘贴长串 JSON 反馈，切走终端后页面里的修改还可能丢失。

**DSH Review Dock** 在 DSH 右侧栏里开出一个通用的“工作台停靠位”——插件本身**不写死任何具体业务 UI**，而是把舞台完全留给各个专业 Skill：

```text
Agent 需要你确认或修改时调用 review_open
  → 1. 在当前对话的右侧栏挂起「审阅」标签页（保留状态，切走不丢）
  → 2. 注入安全通信桥接，页面上的编辑自动写入草稿（不会误触发 AI）
  → 3. 你点「提交/确认」后原样写盘反馈文件，并实时唤醒同一对话的 AI 继续干活
```

*(即便脱离 DSH 在 Codex 或 Claude Code 里跑这些 Skill，它们仍会通过公共接缝 [`planners-review-core`](https://github.com/thePlannerIvan/planners-review-core) 自动退回本地浏览器打开完全相同的页面。)*

---

## 日常用起来有哪些核心能力

- **模型不用人提醒就会用**：内置轻量工具提示与描述（`tool:review_open`），当任务需要你审阅、改稿或拍板时，AI 会主动调起侧栏而不是吐一大段文字让你复制。
- **多页并行且严格按对话隔离**：一份审阅面独立占一个标签页，标题即页面本身的名字（`multiple: true`）；每个标签绑回发起它的那场对话，**后台对话开的审阅绝不会突然弹窗抢占你当前屏幕**。
- **自动存草稿，不与“正式提交”混淆**：页面编辑实时暂存草稿文件，刷新或切走标签不丢进度；只有你明确点提交并唤醒时才触发下一轮，且**同一次提交意外重发会自动去重，不会触发两次 AI**。
- **真实读取、上传素材与变更感知**：支持页面安全读取项目图片/音视频资源、上传补充素材（流式限额 16 MiB），并在源文件被修改时温和提示页面局部刷新，不打断你正在写的批注。

> **版本能力对照**：
> - **v0.3.1（当前 GitHub 发布版）**：完整支持由 Skill 自建的专用审阅页（含 `{{REVIEW_BRIDGE}}` 注入）、多面独立标签页、跨对话隔离、DSH 0.2.2+ 唤醒回读核验与系统提示发现缝。
> - **开发主线 v0.3.2–v0.3.4**：进一步新增**普通 HTML 产物免改直注**（`"annotate": true`，可直接在任何已生成的 HTML 报告上划词批注、改字与框选）、未留注入点自动补入、草稿回读（`draftRead()`）与重复打开同文件警告，详见 [CHANGELOG.md](CHANGELOG.md)。

---

## 安装与卸载

> 环境要求：Node.js ≥ 20；DSH 版本声明 `@deepseek-ai/dsh: ^0.1.7-rc.1 || ^0.2.0-rc.1`。

### 方式一：DSH Web 端（推荐命令行安装）

```bash
# 从本地克隆路径安装（推荐，已通过隔离环境完整实测）
dsh plugin --profile web add /path/to/dsh-review-dock

# 或通过 GitHub 短地址安装
dsh plugin --profile web add github:thePlannerIvan/dsh-review-dock

# 重启 dsh web 生效
```

命令行会自动更新 profile 依赖与 bundles 配置，无需手动修改配置 JSON。如需卸载：

```bash
dsh plugin --profile web remove dsh-review-dock
# 重启 dsh web
```

### 方式二：DSH 桌面应用（`desktop` profile）

桌面端 profile 由应用独立托管（直接运行 `dsh plugin --profile desktop` 会被拒绝）：在桌面应用内打开 **插件管理器**，填入 `dsh-review-dock` 本地文件夹的绝对路径即可热安装生效。

*(首次使用遇到界面侧栏展开后出现「审阅」胶囊即代表安装就绪。)*

---

## 与 Planner 生态配合使用

通过 [Planners Form](https://github.com/thePlannerIvan/planners-form) 或各自仓库安装以下消费 [`planners-review-core`](https://github.com/thePlannerIvan/planners-review-core) 的 Skill，即可直接唤醒本插件右侧栏：

- [Planners Proposal System](https://github.com/thePlannerIvan/Planners-Proposal-System) —— 提案 Storyline 拖拽编排审阅台
- [Planners Bypage](https://github.com/thePlannerIvan/planners-bypage) —— PPT 逐页文稿、真实图片与示意图混排审阅台
- [Planner's PPT Hell](https://github.com/thePlannerIvan/planners-ppt-hell) —— 16:9 SVG 画布直改文字、框选批注与返修工作台
- [Video Idea System](https://github.com/thePlannerIvan/video-idea-system) —— 短视频念稿逐句内联修改与画面样张确认面
- [Video Craft](https://github.com/thePlannerIvan/video-craft) —— 逐字音视频剪辑与实测时间动效工程播放审阅页
- [Editor](https://github.com/thePlannerIvan/editor) —— 长文红/绿内联校对可编辑审阅页

---

## 开发者文档、契约与测试

所有底层协议与宿主工程实现细节（HTTP 鉴权路由表、iframe `allow-same-origin` 安全边界、宿主代传字节与 `ArrayBuffer` 克隆流、16 MiB 流式上传门禁、`submissionIdentity()` 唤醒幂等与 `state/events` 核验细节，以及 DSH `0.1.7`–`0.2.2+` 实测回归清单）已独立整理至：

- **[DEVELOPMENT.md](DEVELOPMENT.md)** —— 插件架构、契约接口细节与验收矩阵
- **[CHANGELOG.md](CHANGELOG.md)** —— 各版本破坏性变更与升级记录

---

## 品牌边界、开源协议与商业合作

- **许可协议**：以 [AGPL-3.0-only](LICENSE) 发布，可商业使用；修改版或网络服务须公开对应源码。
- **署名边界**：作者归属保留在 [NOTICE](NOTICE) 与开发文档中，不强行写入由下游产出的客户交付物；品牌与二开规则见 [TRADEMARK.md](TRADEMARK.md)，安全说明见 [SECURITY.md](SECURITY.md)。
- **商业支持**：私有 DSH 环境集成、企业自定义宿主插件或闭源商业授权，请联系 `Lawyif@163.com` 或访问 [demyth.info](https://demyth.info)，详见 [COMMERCIAL.md](COMMERCIAL.md)。
