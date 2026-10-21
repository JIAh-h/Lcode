# Lcode 项目骨架 · 结构说明与后续开发建议

> 交付日期：2026-09-11 · 依据文档集 v0.9（docs/00–23 + 原型）
> 本文回答三件事：① 当前是否具备开发条件；② 代码骨架长什么样、边界在哪；③ 下一步怎么推进。

> **现状提示（2026-10-21）**：本文是初始化阶段的评估，其中“骨架/占位”的能力大多已实现。当前能力与命令以根目录 [README](./README.md) 和 [docs/25](./docs/25-后续开发任务清单.md) 为准。

---

## 一、开发就绪度评估：**结论 = 已具备开发条件**

通读全部 26 篇设计文档 + 高保真原型后，按 [docs/README.md §开发就绪度] 的十二项产物逐项核对：

| # | 产物 | 现状 | 说明 |
|---|---|---|---|
| 1 | 需求文档 | ✅ | 03 PRD（147 条需求，含编号与追溯矩阵）+ 04 MVP（70 条验收项） |
| 2 | 系统设计 | ✅ | 05 五层架构 / 三进程模型 / 七条不变量 |
| 3 | 模块设计 | ✅ | 20 七个骨架包规格 + 全部能力族 + 依赖规则 + 速查表 |
| 4 | 接口契约 | ✅ | 21 十二组方法契约 + 十二个工具契约 + 60+ 错误码 |
| 5 | 数据字典与 DDL | ✅ | 22 十五张表可执行 DDL + 事件字段字典 + JSONL 编码 |
| 6 | 工程规范 | ✅ | 23 仓库结构 / 命令 / TS 三层配置 / 14 条门禁 / v0.1 建包顺序 |
| 7 | 原型图 | ✅ | prototype/lcode-mvp-prototype.html（8 屏 · 三态主题 · 可离线打开） |
| 8 | 测试策略 | ✅ | 15 测试金字塔 + 不变量 I1–I7 在 CI 强制 |
| 9 | 设计系统 | ✅ | 10 §6 令牌精确到色值（校验脚本保证规格外色值 = 0） |
| 10–12 | 分步用例 / 埋点 / 运维材料 | 🟡 | 滚动产出，**不卡开工**（文档已明确判定） |

**两件开工前须知**（源自文档，非本报告新增）：
1. 风险登记册（16）中"用户是否真的想要可审计"仍未验证——它决定的是**要不要做**，不是怎么做；建议写第一行代码前用原型找 5 个真实开发者做一次 15 分钟可用性测试。
2. 文档宣称"可以开工"的直接依据是 v0.8 新补的 20/21/22/23 四篇开发启动包——本骨架正是对这四篇规格的落地。

---

## 二、已交付的代码骨架

### 2.1 目录结构（与 23 §2 仓库结构一致）

```
lcode/
├── package.json  pnpm-workspace.yaml
├── tsconfig.base.json / tsconfig.host.json / tsconfig.client.json   # TS 三层配置（23 §6.1）
├── eslint.config.js  vitest*.config.ts  .changeset/  .env.example
├── packages/                        # 全部 @lcode/* 包（workspace）
│   ├── core/                        # ★ 骨架层（产品契约，8 包）
│   │   ├── context/                 #   内核：Service/Event/Effect + emit/waterfall/parallel/serial
│   │   ├── scope/                   #   作用域原语（避免循环依赖的底座）
│   │   ├── session/                 #   ★ 事件日志 + 表面投影 + 分叉（内存实现 + 单测）
│   │   ├── system-prompt/           #   提示词与工具 schema 装配（纯函数）
│   │   ├── tools/                   #   工具注册表 + 守卫 + 执行流水线
│   │   ├── agent/                   #   Agent 契约 + 活体注册表
│   │   ├── agent-default-model/     #   "当前用哪个模型"的唯一权威
│   │   └── agent-loop/              #   唯一的具体循环（接口占位，批次③落地）
│   ├── util/                        # ★ 零依赖工具：品牌类型/LcodeError/无损JSON/disposer/id/重试
│   ├── llm/  fs/  shell/  sandbox/  terminal/  subprocess/
│   ├── settings/  credentials/  session-persistence/
│   ├── compaction/  skill/  subagent/  jobs/  web/  lsp/
│   ├── interaction/  preset/  extension/  bundle/
├── apps/
│   ├── desktop/                     # ★ Electron main/preload + React 路由 8 屏 + 通用组件 + 三态主题
│   └── cli/                         # headless CLI（命令分发 + doctor 占位）
├── scripts/                         # 门禁：check-deps / check-invariants / check-size / bench
├── fixtures/  examples/             # 测试固定输入 / 可运行组合（待填充）
└── docs/  prototype/                # 设计文档集 + 高保真原型（原样保留）
```

**规模**：约 85 个 npm 包（8 个骨架/内核包完整实现，11 个接口包含类型，50 个实现/消费壳包，2 个应用）。

### 2.2 核心模块边界（20 §5 骨架层，全部冻结，改接口走 ADR）

| 包 | ctx key | 职责 | 不做什么 | 已落地 |
|---|---|---|---|---|
| `session` | `ctx.sessions` | 事件日志唯一 owner | 不渲染/不压缩/不判断策略 | ✅ 内存实现 + 单测（seq/表面/分叉/end-seed/订阅） |
| `system-prompt` | `ctx.systemPrompt` | 提示词 + schema 装配 | 不发请求/不选模型 | ✅ 段落/动态上下文/变量/schema 收窄(P4) |
| `tools` | `ctx.tools` | 工具注册 + 守卫流水线 | 不实现具体工具/不判权限 | ✅ 注册/收窄/守卫(无 allow)/执行/事件钩子 |
| `agent` | `ctx.agents` | Agent 契约 + 活体注册表 | 不实现循环 | ✅ 状态机 + 取消落盘(A2) |
| `agent-default-model` | `ctx.agentDefaultModel` | 模型选择唯一权威 | 不做自动路由(D21) | ✅ 分层读写 + watch |
| `agent-loop` | `ctx.agentLoop` | 唯一具体循环 | **不出现针对能力的 if(I6)** | ⏳ 接口占位（批次③） |
| `scope` | —（纯库） | 作用域原语 | — | ✅ |
| `context` | —（内核） | Service/Event/Effect | — | ✅ 四派发模式 |

### 2.3 数据模型定义（22 §3 / 06 §2 落地）

- **事件词汇表** `SessionEventMap`（`@lcode/session`）：16 类事件全量类型化
  （turn/step 边界、user/assistant/tool 表面事件、chunk/tool-call/request-header 日志事件、
  approval/compaction/todo/plan 治理事件），**开放接口**——插件经声明合并扩展（06 §2.2）。
- **事件信封**：`type + seq + time + data + surfaceOp + sourceEventSeqs + ignorable`（06 §2.1）；
  `seq = log.length` 不变量 I2；`data` 进日志即深冻结 + 无损 JSON 校验（I5）。
- **表面机制**（D5）：`deriveMessages()` 纯函数投影；`surfaceOp.replace` 隐藏旧区间且**不做删除**——
  被压缩内容仍可展开（I1 的另一半）。
- **JSONL 物理编码**（22 §4）：file-header 帧 + 事件帧 + `assistant/chunk/batch` 批打包
  （极大连续段，段长上限 4096，`seq = seqFirst + i` 纯函数还原，解包后校验 I2）+ 撕裂/损坏判定注释。
- **SQLite DDL**（22 §3）：15 张表可执行 DDL 常量 + pragma + FTS5 触发器（`@lcode/session-persistence-sqlite`）。
- **错误码全表**（21 §6.2）：60+ 码常量 + `LcodeError` 五段结构 + 分类前缀推导。

### 2.4 路由配置（apps/desktop，8 屏 ↔ 19 号文档 P1–P8）

| 路由 | 页面 | 规格锚点 |
|---|---|---|
| `/` | 首页（问候 + 能力卡 + 输入框） | 19 §3.1 P1 |
| `/sessions/:id` | 工作台（会话流 + 输入区） | 19 §3.2 P2 |
| `/sessions/:id/replay` | 回放（三快照：system/工具/消息） | 19 §3.3 P3 |
| `/sessions/:id/ask` | 询问弹窗（四结果） | 19 §3.4 P4 |
| `/settings` | 设置（左分类右内容，模型配置在此） | 19 §3.5 P5 |
| `/sessions/:id/recovery` | 恢复摘要 | 19 §3.6 P6 |
| `/sessions/:id/fork` | 分叉确认 | 19 §3.7 P7 |
| `/sessions/:id/error` | 异常（人话公式） | 19 §3.8 P8 |

路由采用 Hash 路由（Electron file:// 兼容）；渲染进程**禁止** `node:*` 导入（tsconfig.client 编译期防线，23 §6.1）。

### 2.5 通用组件与设计令牌

- 组件：`AppShell`（菜单栏+侧栏+底部设置入口）、
  `SessionStream`/`ProcessFlow`（过程流折叠，UX-FOLD-001）/`SummaryCard`（最终总结不可折叠，UX-SUMMARY-001）/
  `ArtifactEntry`（产物入口，UX-ARTIFACT-001）/`Composer`（输入区只属于中间会话栏，UX-INPUT-002）、
  `ApprovalModal`/`ErrorBanner`/`Button`。
- 注：签名元素原为四个，其中「常驻时间轴脊柱」已于 2026-09-14 作废（见 [ADR-0106](./docs/17-架构决策记录ADR.md#adr-0106)），
  对应组件 `TimelineSpine.tsx` 一并删除。当前签名元素为三个：过程流 / 最终总结 / 产物入口。
- 令牌：`styles/theme.css` 严格取自原型 CSS 变量（浅/深/**色盲友好**三态），规格外色值 = 0。
- 文案纪律：界面不出现内部术语（UX-COPY-001 黑名单）；错误条按「人话公式」呈现。

### 2.6 基础工具函数（@lcode/util，零依赖）

品牌类型（SessionId/AgentId/CallId/Seq，23 §6.3 唯一定义处）、`LcodeError` + 错误码全表、
`assertLosslessJson`（I5 检查器：拒绝 BigInt/NaN/undefined/函数/循环引用/Map/Set/Date/类实例）、
`freezeLossless`/`deepFreeze`、disposer 逆序回滚、Crockford 风格 id 生成、指数退避重试/超时/可取消延时。

---

## 三、与文档的偏差（骨架阶段临时约定，需记录）

| 项 | 文档要求 | 骨架现状 | 何时对齐 |
|---|---|---|---|
| 包 `exports` | 构建产物（lib/）单入口 | 指向 `src/index.ts`（tsx 直跑，免构建） | 发布链搭建时切回 lib/ + 23 §11 纪律 |
| `agent-loop` | 具体循环 | 接口占位，`createAgentLoop()` 抛 NOT_READY | 批次 ③（llm-replay 驱动） |
| 参数校验 | 完整 schema 校验 | 轻量（必填 + 类型初查） | 批次 ⑤（tool-fs 接入时） |
| 持久化 I/O | 原子物化/revision/崩溃恢复 | 仅纯函数编解码 + DDL 常量 | 批次 ②/⑧ |
| `check:invariants` I6 | AST 解析 | 源码关键词粗扫（注释可能误伤） | CI 完善时（23 未决问题已记录） |
| settings 六层合并 | D19 逐字段合并 | 仅接口 + 单层权威（agent-default-model） | 批次 ④ |

---

## 四、后续开发建议（对齐 23 §14 的八批推进）

> 原则：**每建一个包就能跑一个的测试**，不要一次铺开全部目录。

| 批次 | 目标 | 入口 | 验收锚点 |
|---|---|---|---|
| **① 地基（已就绪）** | util / scope / session | 已落地 + 单测 | I2 / I5 通过 |
| **② 派生** | JSONL → SQLite → system-prompt 联调 | 补持久化 I/O（原子物化、revision） | 会话能落盘、能重建（I1 起步） |
| **③ 循环 ⭐** | llm-replay → agent-loop 真实循环 | **无密钥跑通一次循环**（最值钱的一步） | I1 / I6；test:replay 可跑 |
| **④ 能力** | llm-deepseek → settings 六层 → credentials → agent-default-model 贯通 | 真实模型跑一次对话 | M-MODEL-* |
| **⑤ 工具** | fs / shell 族 + tool-fs / tool-shell | 能读写文件、跑命令 | M-TOOL-01–07 |
| **⑥ 治理** | approval + permission-presets → sandbox 三平台 | 越界写入会问、能拦住 | M-SEC-*、EP-* |
| **⑦ 前端** | apps/cli → apps/desktop（main → preload → renderer 事件流） | 能演示 8 分钟脚本；renderer 接 session/event 真实流 | M-UX-* |
| **⑧ 加固** | 崩溃恢复 + 回放 UI + 集束装配 | v0.1 出口标准 | ES-RECOVERY_REPAIRED 等 |

**开工第一步建议**：批次 ③ 的 `llm-replay → agent-loop`——它让"整个循环的骨架可以在不花钱、不联网的情况下被完整测试"，是文档 15 快照重放策略成立的前提，也是排期上最容易被忽略、却最值钱的一步（23 §14 原文）。

**文档纪律提醒**：改接口 → 同步 20；改决策 → 加 17 ADR；改文档 → 跑 `python docs/tools/check.py`；
本骨架的所有"接口包不得被实现包依赖"等规则已由 `pnpm run check:deps` 守护。

---

## 五、验证结果

（待补：pnpm install + 全仓 typecheck + 单测结果，见完成后记录）
