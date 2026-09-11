# @lcode/agent

> 骨架层核心（文档 20 §5.4，`ctx.agents`）：**Agent 契约、活体注册表、创建/恢复工厂接缝、发起者上下文**。
> 冻结模块（改接口走 ADR）。

## 职责

- `create(spec)`：创建 agent（共享会话 id，D17）
- `resume(ref)`：从既有会话恢复 agent（活体重建）
- `get` / `list`：活体注册表查询
- `withInitiator(initiator, fn)`：让后续操作归属到某个发起者（子代理与工具调用链的归属）

## 不做什么

- 不实现循环（那是 `agent-loop`）、不管 UI 状态。

## 不变量

| # | 不变量 |
|---|---|
| A1 | `agentId` 与会话共享同一 id（D17）；全局唯一 |
| A2 | 取消后必须落盘一个明确的结束事件；不得留下"看起来还在跑"的状态 |
| A3 | 无内容的 assistant 消息**也必须落盘**（否则重放时消息序列会变） |
| A4 | `dispose()` 后不得再有该 agent 的事件；在途操作必须收敛为取消态 |

## 事件（发布）

`agent/created`、`agent/status`、`agent/inbox`、`agent/disposed`。
订阅：`session/end-seed`（重建活体注册表）。

## Known Limitations

- `followup` / `steer` / `inject` 的具体执行语义由 `agent-loop` 提供（批次 ③）；本包当前提供状态机与注册表。
