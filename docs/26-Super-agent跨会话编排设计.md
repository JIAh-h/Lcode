# 26 · Super-agent 落地设计：跨会话编排

> 本文把 DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）的理念，落到 Lcode **现有内核**上。它不重述那篇文章，只回答四个问题：**在我们已有的东西上，哪些能复用、哪些必须新建、边界在哪、按什么顺序做**。
>
> 前置：[20 模块设计](./20-模块设计与接口清单.md) · [21 接口契约](./21-接口契约与错误码总表.md) · [06 事件日志](./06-会话事件日志与可重放设计.md) · [12 安全与沙箱](./12-安全权限与沙箱模型.md) · [25 任务清单 §11.2](./25-后续开发任务清单.md)

| 项 | 约定 |
| --- | --- |
| 状态 | `草案` / `已确认` / `已实现` |
| 事实来源 | 功能现状以代码与测试为准；本文只定义**新增部分**的契约 |
| 不做什么 | 本文不引入 HTTP 服务端、不引入云端调度、不改 JSONL 权威地位 |

---

## 1. 定位：为什么是"跨会话"，而不是"更大的单会话"

### 1.1 三种形态必须先分清

项目推进过程中反复出现一个混淆，先用一张表钉死：

| 概念 | 边界 | 发起方 | 生命周期 | 用户可见 |
| --- | --- | --- | --- | --- |
| **单会话** | 一个 session | 用户 | 一次对话 | 是 |
| **subagent** | **一个会话内部**，为该会话的一个任务而开 | 会话内的 `delegate` 工具 | **跟随父会话**（取消传播） | 否（实现细节） |
| **worker** | **跨会话**，一个 worker = 一个会话 | Router 派发 | **独立**（取消隔离） | 是（正式会话） |

**subagent 不是 worker 的雏形，而是同一套底层能力的另一种用法。** 二者共享"独立子会话 + 工具收窄 + 结构化结果 + 异步"，但生命周期与可见性相反。这个区别决定了取消语义、审计归属与 UI 呈现，因此必须是**两套事件**，而不是一个字段两种取值。

### 1.2 目标用户场景

| 场景 | 现状 | 目标 |
| --- | --- | --- |
| 日常单个任务 | ✅ 单会话，零额外开销 | **保持不变**（默认路径） |
| 一次任务要做到多处 | ⚠️ 用户手动开会话、自己当调度 | Router 派发 N 个 worker 并行 |
| 某个会话需要引用别的会话 | ✅ `@session:id` 显式引用 | 保持显式，不自动注入 |
| 长任务无人盯着 | ❌ 失败了没人知道 | Watchdog 巡检通知 |

**核心约束（来自产品定位）**：日常 95% 以上的使用仍是单会话。跨会话能力必须是**按需启用的编排层**，不能变成默认路径，也不能在无任务时消耗 token。

---

## 2. 能力盘点：super-agent 五项机制在 Lcode 的落点

### 2.1 已具备（可直接复用，不改语义）

| super-agent 机制 | Lcode 已有实现 | 证据 |
| --- | --- | --- |
| **Async ReAct**（不阻塞交互） | `enqueue` 同步入队 + `steer` 插话打断 + `start/wait` 异步派发 | `agent-loop/engine.ts`、`subagent-inprocess` |
| **Inline / Spill**（上下文分层） | `spill-local` + `lcode://spill/<id>` + 手动压缩 + 自动压缩 | P7-02 / v0.3 |
| **独立 Worker 会话** | `sessions.create` 已支持独立会话；`FileHeader.parentSession` 已能标记归属 | `session-persistence-jsonl/jsonl.ts:18` |
| **派发可审计** | `subagent/delegated` / `subagent/completed` 事件 | `core/session/types.ts` |
| **结构化结果** | `SubagentArtifacts`（改动路径 / 工具次数 / usage / 事件数） | P10-02 |
| **多模型路由** | `model-router` 按规则选模型（可给 Router 配轻模型） | P7-06 |

### 2.2 必须新建（本文的主体）

| 机制 | 缺什么 | 落点 |
| --- | --- | --- |
| **Router 会话** | 一种不执行工具、只做派发的会话 | §3 |
| **派发事件** | `worker/dispatched` / `worker/completed` | §4 |
| **异步回传** | Worker 完成后唤醒 Router，而不是回写父 turn | §5 |
| **取消隔离** | Worker 生命周期独立于 Router | §6 |
| **审批归属** | Worker 的审批不得继承 Router | §7 |
| **Watchdog** | 巡检卡死 / 失败静默 / 等人超时 | §8 |

### 2.3 明确不做

- **不做用户不可见的自动派发**：所有派发都必须能追溯到一条用户请求或一次用户点击。
- **不让 Router 持有执行工具**：见 §3.2。
- **不做跨机器调度**：Lcode 是本地优先，worker 就在本机会话目录里。
- **不复用 `subagent/delegated` 承载 worker**：见 §4.1。

---

## 3. Router 会话

### 3.1 定义

Router 是一个**普通会话**，只是被赋予 `role: 'router'` 的运行时能力约束：

```
Router 会话 = 普通 session（同一套 JSONL / 索引 / 回放）
            - 执行类工具（shell / write / edit / terminal / run_code / ...）
            - 直接改文件的能力
            + 派发工具（dispatch / dispatch_status / dispatch_cancel）
            + 汇总能力（读取 worker 结果）
```

**它仍然是一个会话**，因此继承全部既有不变量：I1（日志派生）、I2（副作用受控）、可回放、可导出、可 fork。

### 3.2 三条硬约束

**① 不持有执行工具**

Router 是唯一读取"所有用户消息 + 所有 worker 汇报"的地方，**提示注入攻击面最大**。让它没有执行能力，即使被注入也只能产出错误判断，不能删文件、不能外发数据。

实现上不加新机制：现有 `systemPrompt.tools()` 已经有按 scope 过滤工具的能力（subagent 用它做收窄），Router 复用它把执行类工具过滤掉。

**② 用便宜模型**

Router 只做判断与汇总，不需要强模型。复用 `model-router` 的规则，按 `role === 'router'` 选轻模型。理由在原文的实验数据里：Router 是决策瓶颈（40 事件/分钟时靠批处理才撑住）。

**③ 派发必须落事件**

每一次派发都要写 `worker/dispatched`，包含当时的判断依据。否则 `history.replay` 在 Router 会话上失效——用户看到 worker 建出来了，但不知道为什么建。

### 3.3 Router 如何产生

两种入口，**都是用户显式触发的**：

| 入口 | 行为 |
| --- | --- |
| 新建即 Router | 用户创建会话时选择 `role: 'router'`（CLI `--role router`，桌面侧栏后续接入） |
| 从普通会话升格 | 用户在一个已有会话里说"这事拆出去"，该会话追加 `session/role` 事件转为 Router |

升格是**追加事件**，不改历史。回放时按事件发生时间点判定该位置的 role。

---

## 4. 事件契约

### 4.1 为什么不复用 `subagent/*`

`subagent/delegated` 的语义是"父会话内部的实现细节"，它没有 `routerSessionId`、没有"用户可见"标记、也没有"独立生命周期"。若给它加 `kind` 字段区分，下游每一处（取消、可见性、审计、UI）都会退化成二选一分支——那正是 20 §3 想避免的"能力分支渗进通用层"。

**结论：新增独立事件族。**

### 4.2 `worker/dispatched`（Router → Worker）

```ts
'worker/dispatched': {
  readonly taskId: string            // 派发标识（Router 侧生成，全局唯一）
  readonly workerSessionId: string   // 被创建的 worker 会话
  readonly task: string              // 派给 worker 的任务描述（模型可读）
  readonly routerSessionId: string   // 哪个 Router 派的
  readonly reason?: string           // Router 的判断依据（为什么派这个、为什么拆）
  readonly dispatchedAt: number      // epoch ms
}
```

- **写在 Router 会话**（不是 worker 会话）。Router 的日志因此是"调度事实的唯一权威"。
- **同时标记 Worker 的归属**：worker 会话的 `FileHeader.parentSession` 指向 Router，与 `subagent` 复用同一存储字段，但**靠事件类型区分语义**。

### 4.3 `worker/completed`（Worker → Router）

```ts
'worker/completed': {
  readonly taskId: string
  readonly workerSessionId: string
  readonly outcome: 'completed' | 'failed' | 'cancelled'
  readonly summary?: string          // 末条 assistant 文本
  readonly artifacts?: SubagentArtifacts   // 复用 P10-02 的结构化产物
  readonly error?: string
}
```

- **写在 Router 会话**，由 worker 结束时回写。
- 与 `subagent/completed` 的**关键区别**：它不唤醒某个 turn、不阻塞任何人，而是**排进 Router 的队列**（见 §5）。

### 4.4 `session/role`（role 变更）

```ts
'session/role': { readonly role: 'router' | 'worker' | 'normal'; readonly reason?: string }
```

用于"从普通会话升格为 Router"。**不改历史**，只追加。回放时按 seq 判定每个位置的有效 role。

---

## 5. 完成回传与唤醒

### 5.1 两种回传的区别

这是与 subagent 最本质的差异，必须在实现时锁死：

| | subagent | worker |
| --- | --- | --- |
| 回传方式 | 回写父会话事件 + **父 turn 内 await 消费** | 回写 Router 事件 + **排进 Router 队列** |
| 谁在等 | 父 turn 阻塞等 | 无人在等（Router 可能 idle） |
| Router idle 时 | 不适用 | **投递为一条新输入**，自动开始新一轮 |
| 父会话已销毁 | 结果丢弃 + 吞异常（P10-05 已实现） | **worker 结果仍落盘**（worker 有独立生命周期） |

### 5.2 唤醒实现

复用现有 `agents.followup` 的入队语义，但**由系统投递而不是用户输入**：

```
worker 结束
  → 写 worker/completed 到 Router 会话
  → 若 Router 有活跃 agent：enqueue 一条系统消息（含 taskId 与摘要）
  → 若 Router 无活跃 agent：先 resume，再 enqueue
  → Router 新一轮据此决定"继续派发 / 汇总回复用户 / 什么都不做"
```

**注意**：这条系统消息必须能被回放——它作为一条 `user/message` 写入是不够的（会污染用户消息历史），应当作为 **`worker/completed` 事件本身**被 Router 的下一轮请求派生读取。也就是说：Router 的模型可见历史由 `deriveMessages` 从它自己的日志派生，`worker/completed` 投影成一条"系统通知"内容块。

### 5.3 投递节奏：批量而非即时

原文实验里 Router 的批处理把单次决策时间从 6.4s 降到 1.6s。Lcode 应照做：

- 多个 worker 在 **200ms 窗口内**完成 → 合并成一次 Router 唤醒
- 单个 worker 完成 → 立即可唤醒
- 唤醒频率上限（避免 worker 批量失败时刷屏 Router）：默认每 Router 每 10s 最多 1 次，超出则合并

### 5.4 汇报策略：自动汇报，但只在有结果时开口

**已确定：worker 完成后 Router 自动向用户汇报**，不需要用户主动来问。但"自动"不等于"每次都说话"——原文的"静默复现并修复"给出了同一原则：

> 确认问题确实存在且找到简单可行的修复方法之后才提交，否则保持安静。

落到 Lcode 的三条规则：

| 情形 | Router 行为 |
| --- | --- |
| worker 有实质产出（改动 / 结论 / 需要决策） | **主动汇报**，合并成一条 |
| worker 完成但无产出（查了没发现问题） | 记录事件，**不主动开口** |
| worker 失败或取消 | 汇总成一条失败摘要，**必须开口**（失败不能静默） |

"必须开口"与"保持安静"的分界是：**用户是否需要据此做决定**。失败需要（要不要重试、要不要换方案），无事发生不需要。

一次汇报的粒度：同一批（§5.3 的 200ms 窗口）完成的 worker 合并成**一条**消息，而不是每个 worker 一条——否则并行度越高，打扰越密集，正好违背 super-agent 的初衷。

---

## 6. 取消语义（与 subagent 相反）

| | subagent | worker |
| --- | --- | --- |
| 父级/调度方取消 | **传播**：父停子停（P10-05 已实现） | **隔离**：Router 停，worker 继续 |
| 为什么 | 会话内的内部执行单元，父不要了结果就是垃圾 | 独立任务实体，用户的"暂停 Router"不等于"取消所有任务" |
| 如何停 | 自动化 | **显式** `worker.cancel(workerSessionId)` |

**Worker 的取消出口必须有**，否则"取消隔离"会变成"无法取消"。设计：

```
workers.list({ routerSessionId })      → 在途 worker 列表
workers.cancel({ workerSessionId })    → 取消该 worker 的当前 turn（复用 agents.cancel）
workers.status({ workerSessionId })    → idle / running / waiting-approval / settled
```

`workers.cancel` 只取消 worker 的**当前 turn**，不销毁会话、不删日志——与 `agents.cancel` 语义一致（P0-04 冻结的粒度）。

---

## 7. 权限与审批归属

### 7.1 必须钉死的不变量

> **Worker 的审批不得继承 Router 的权限档。**

原因：`history.why` 要能回答"这个写操作是谁批的"。若 worker 的写操作落在一个继承自 Router 的授权下，归因链就指向了 Router 会话——而 Router 根本没有经历过那次审批。

### 7.2 实现规则

| 动作 | 审批落在哪 | 说明 |
| --- | --- | --- |
| Worker 内越界写 | **Worker 会话** | 与普通会话完全一致，不特殊化 |
| Worker 内 shell 联网 | **Worker 会话** | 同上 |
| Router 派发本身 | **不审批** | 派发不是副作用；但要落事件可审计 |
| Worker 权限档 | **继承自创建时的策略快照** | 与 `preset/snapshot` 一致，会话内冻结 |

### 7.3 门禁

新增一条检查（放在 `check-invariants.mjs` 的 P5-00 族里）：

> 扫描 worker 会话创建路径，禁止从 Router 会话读取 `approvalPolicy` / `preset` 作为 worker 的授权来源。

这条**必须是静态门禁**，不能只靠 code review——它是审计链的根。

### 7.4 编排授权的三档开关（对齐官方原型）

官方 `dsh-superagent` v0.1.0 的默认授权是 **`observe`**：只记录"它本来会执行的动作"，不真正执行，建议先跑一两周再放开。这个设计对 Lcode 同样必要——跨会话编排是本项目里**第一个能自主花钱、自主派发**的能力，不能一上线就是全开。

| 档位 | 行为 | 适用 |
| --- | --- | --- |
| `off` | 完全关闭跨会话编排，Router 角色不可用 | 默认只想要单会话的用户 |
| **`observe`（默认）** | 允许 Router 判断与"预演派发"，记录 `worker/dispatched` 事件但**不创建 worker 会话、不调用模型** | 首次启用、评估它会怎么拆分任务 |
| `auto` | 真正派发并执行 | 信任建立后显式切换 |

**为什么默认 `observe` 而不是 `off`**：`off` 让用户看不到任何价值，`observe` 能让人先看到"它会怎么拆"，再决定是否放手——这正是官方选 `observe` 作默认的理由。

**与权限预设的关系**：这一档控制的是"能不能编排"，与 [12 §3](./12-安全权限与沙箱模型.md#3-三条正交的权限轴) 的三条权限轴**正交**。即使编排是 `auto`，worker 内部的写操作仍要过它自己的审批（§7.2）。

---

### 7.5 并发上限

#### 7.5.1 官方怎么做的

**官方没有给出并发 worker 数量的数值上限**（未披露）。原型里 Worker 是**独立终端会话**（依赖 tmux），本质是进程隔离——上限由机器资源与 tmux 会话数自然约束，代码里没有常量。

这带来一个必须承认的差异，也是**方案 A 的前提**：

| | 官方原型 | Lcode（方案 A） |
| --- | --- | --- |
| Worker 形态 | 独立 tmux 会话（进程级） | **同进程内的会话** |
| 资源上限来源 | OS 进程数 | 我们自己设的常量 + 内存 |
| 崩溃隔离 | 有（进程退出即回收） | **无**（共享 Node 堆） |

**方案 A 已确定**：worker 保持同进程会话，换取实现量与 I1 可回放不受影响。代价是必须自己定上限、并接受"一个 worker 跑飞会影响主进程"这一风险（缓解见 §11）。

#### 7.5.2 Lcode 的取值

| 项 | 值 | 说明 |
| --- | --- | --- |
| `maxConcurrentWorkers` | **8**（默认，可配置） | 编排层默认值。8 是经验取值：单进程内每个 worker 占一份事件日志镜像 + 一个 `TurnEngine`，8 条并发流式请求在普通开发机上仍在可接受范围 |
| 上限的可配置性 | 设置页 + CLI flag | 用户可按机器与预算调整；设 0 表示不限 |
| 超限行为 | **排队**，不拒绝 | 与 `drain()` 的队列语义一致；拒绝会让 Router 的派发决策白跑 |

**为什么是 8 而不是更小**：subagent 的并发是会话内的（深度 2），worker 是跨会话的，两者叠加后单进程内的活跃引擎数会明显上升。8 是在"并行收益"与"单进程内存压力"之间的折中——低于这个数，跨会话编排的收益不足以覆盖 token 成本（§9.2）；高于这个数，需要先解决 §11 的资源风险项。

**注意**：这是**编排层**的上限，与 subagent 的 `MAX_DEPTH = 2` 是两套不同的限制：

| 限制 | 作用域 | 值 |
| --- | --- | --- |
| `MAX_DEPTH` | 会话**内**的 subagent 嵌套深度 | 2 |
| `maxConcurrentWorkers` | 跨会话的 worker 并发数 | **8**（可配置，0 = 不限） |
| **worker 的派发深度** | worker **不允许**再派发 worker | **1**（硬编码，不可配置） |

worker 深度必须是 1 且不可配置：一旦允许 worker 再派发，取消语义、审计归属、成本预估全部失效——那是三层结构，不是本文设计的双层。

#### 7.5.3 单进程的额外约束

因为走了方案 A（同进程），除了数量上限还要守住两条：

1. **worker 不得无限累积**：完成的 worker 会话保留在存储里，但内存镜像应在 agent `dispose` 后释放——复用现有 `AgentHandle.dispose` 语义，不新增机制。
2. **派发前检查内存水位**：若 Node 堆占用超过阈值，新 worker **排队**而非启动。这是兜底，不替代 `maxConcurrentWorkers`。

> 若将来把 worker 改成独立进程（方案 B，见 §7.5.1 对比表），`maxConcurrentWorkers` 可以退化为"仅防误用"的安全阀，真正上限交给 OS。

---

## 8. Watchdog

### 8.1 职责边界（最重要的一条）

> **Watchdog 只通知，不派发、不接管、不自动重试。**

原文里 Watchdog 也是"检查 + 提醒"，派发仍是 Router 的事。让 Watchdog 有派发权 = 让一个定时任务能自主花钱。

### 8.2 检查项

| 检查 | 判据 | 通知 |
| --- | --- | --- |
| 卡死 | `running` 且超过 N 分钟无新事件 | 会话卡片角标 |
| 等人超时 | `waiting-approval` 超过 N 分钟 | 同上次（**不自动拒绝**） |
| 失败静默 | `turn/end(reason:'error')` 且用户未查看 | 汇总列表 |
| worker 堆积 | 同一 Router 在途 worker 超过阈值 | 提示用户处理 |

### 8.3 实现形态

- 主进程定时任务（默认 5 分钟一轮），**不常驻模型调用**
- 判据全部读日志，不读进程内状态（可回放）
- 复用现有 `watchTurnFailure` 的失败检测逻辑，从"单会话"扩成"跨会话汇总"
- 通知只推事实，文案由渲染层 i18n 给（延续 `lcode:session.turnFailed` 的约定）

---

## 9. 上下文与成本

### 9.1 Router 的上下文纪律

Router 不能把 worker 的完整日志读进来——那正是 Inline/Spill 要解决的问题：

| 内容 | 处理 |
| --- | --- |
| worker 摘要 | Inline（`worker/completed.summary`，限长） |
| worker 结构化产物 | Inline（`artifacts`，小对象） |
| worker 完整日志 | **Spill**：Router 只知道 `workerSessionId`，需要时用 `@session:` 展开 |
| Router 自己的历史 | 长跑时自动压缩（现有 v0.3 机制） |

**Chain of Recall**：`taskId → workerSessionId → 具体 seq`，靠事件里的标识串起来，Router 不必预读。

### 9.2 成本预期

原文实验数据（可直接作为预期基线，不是承诺）：

| 方案 | p50 | p95 | cache-read tokens/run |
| --- | --- | --- | --- |
| super-agent | 12.4 min | 15.7 min | 23.2M |
| 单会话 + 子代理（delegation-first） | 13.8 min | 29.0 min | 10.8M |

**结论：跨会话编排是用 token 换 p95 延迟。** 因此：
- 默认 `observe`（§7.4），用户显式切到 `auto` 才真正派发
- 设置页需要明示这一权衡
- Lcode 本地优先、用户自付费用，这一条必须写进产品文案

---

## 10. 实施顺序

每一步都是可独立验收的单元，不做跨步依赖：

| ID | 任务 | 前置 | 验收 |
| --- | --- | --- | --- |
| P11-01 | `worker/dispatched` + `worker/completed` 事件 + worker 独立会话 | P10 | CLI 手动派发 2 个 worker，各自独立会话、事件可回放 |
| P11-02 | `workers.list/status/cancel` | P11-01 | 取消隔离可验证：Router 停 worker 继续；显式 cancel 生效 |
| P11-03 | Router 会话类型（无执行工具 + 轻模型 + 派发工具） | P11-01 | Router 请求头里没有 shell/write；派发生效 |
| P11-04 | 完成回传、Router 唤醒与自动汇报 | P11-02、P11-03 | worker 完成后 Router 自动开新一轮并汇报；200ms 内多个合并成一条；无产出的 worker 不主动开口 |
| P11-05 | 审批归属门禁 + 派发深度门禁 | P11-03 | 违规实现使 `check:invariants` 变红；worker 内再派发 worker 被拒绝 |
| P11-06 | 编排授权三档（`off`/`observe`/`auto`） | P11-04 | 默认 `observe`：落 `worker/dispatched` 但不创建会话、不调模型 |
| P11-07 | 并发上限 `maxConcurrentWorkers`（默认 3，超限排队） | P11-04 | 第 4 个 worker 排队而非拒绝；可配置生效 |
| P11-08 | Watchdog（只通知） | P11-04 | 卡死/失败静默可被检出并通知；**不产生任何派发** |
| P11-09 | CLI `lcode superagent` | P11-04 | 端到端：一条命令跑通 Router + N worker |

**桌面端接入（侧栏展示 worker、Router 徽标）不在这批**，等 CLI 验证过交互形态再做，避免过早固化 UI。

---

## 11. 风险与未决

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Router 成为成本黑洞 | 用户账单失控 | 编排默认 `observe`（§7.4）；`maxConcurrentWorkers` 默认 8（§7.5）；Watchdog 报堆积 |
| **单进程共享堆**（方案 A 的固有代价） | 一个 worker 跑飞会拖垮主进程；多个 worker 同时流式时内存压力叠加 | §7.5.3 的堆水位排队；worker 完成后立即 `dispose` 释放镜像；后续如需强隔离，按 §7.5.1 评估方案 B |
| 提示注入经 worker 汇报回流 | Router 被诱导派发恶意任务 | Router 无执行工具（§3.2）；worker 汇报按不可信数据容器注入（复用 `untrustedSection`） |
| 事件族膨胀 | 维护成本 | worker 事件只进 `worker/*`，不复用 subagent；`ContextProvenance` 需同步扩展 |
| Router 空闲时被唤醒风暴 | 资源浪费 | 批处理窗口 + 频率上限（§5.3） |
| 用户分不清 worker 与普通会话 | 认知负担 | worker 会话在列表中带来源徽标；默认折叠进 Router 分组 |

### 11.1 已定决策（2026-11-09）

| # | 问题 | 决定 | 落点 |
| --- | --- | --- | --- |
| 1 | worker 完成后是否自动汇报 | **自动汇报**；但"只在有结果时开口"，无产出的不打扰，失败的必须开口 | §5.4 |
| 2 | worker 能否再派发 worker | **不允许**，深度硬编码为 1 且不可配置 | §7.5.2 |
| 3 | worker 并发上限 | **8**（可配置，0 = 不限）。官方未披露数值，且 Lcode 走**方案 A**：worker 是同进程会话而非独立进程，上限必须自己定 | §7.5 |
| 4 | 编排授权默认档 | **`observe`**（对齐官方原型默认值），不是全开 | §7.4 |
| 5 | worker 是否独立进程 | **方案 A：不做独立进程**，保持同进程会话，以保护 I1 可回放与实现量 | §7.5.1 |

---

## 12. 与既有不变量的一致性

| 不变量 | 本文是否破坏 | 说明 |
| --- | --- | --- |
| **I1 JSONL 权威** | 否 | 所有派发与完成都是事件；Router 的模型可见历史由自身日志派生 |
| **I2 副作用受控** | 否 | worker 走与普通会话完全相同的策略→审批→沙箱链路 |
| **可重放** | 否 | `worker/dispatched` 含判断依据；worker 日志独立完整 |
| **能力接缝** | 否 | worker 复用 `sessions` / `agents` 服务，不新增内核分支 |
| **I7 凭据不进渲染层** | 否 | 事件只带 `taskId` / `workerSessionId`，不带凭据 |

---

## 13. 变更记录

| 日期 | 版本 | 内容 |
| --- | --- | --- |
| 2026-11-06 | v0.1 | 初稿：能力盘点、Router 约束、事件契约、取消隔离、审批归属、Watchdog、实施顺序 |
| 2026-11-09 | v0.2 | 四项决策落定：自动汇报策略（§5.4）、worker 不可再派发（§7.5.2）、并发上限（§7.5）、编排授权默认 `observe`（§7.4）。P11 任务由 7 项扩为 9 项（拆出授权三档与并发上限）。**修正**：官方文档并未给并发 worker 上限数值，原型靠 tmux 进程隔离；亦补入此前遗漏的 `off`/`observe`/`auto` 三档授权 |
| 2026-11-09 | v0.3 | 并发上限由 3 改为 **8**（可配置，0 = 不限）。**修正 v0.2 的推理错误**：原用"人同时跟进 3~5 个会话"论证进程数上限，这是两件无关的事。同时明确**方案 A**：worker 保持同进程会话（不做独立进程），因此上限必须自定，并补 §7.5.3 的单进程额外约束（堆水位排队、完成后 dispose） |
