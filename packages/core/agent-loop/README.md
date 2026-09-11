# @lcode/agent-loop

> 骨架层核心（文档 20 §5.6，`ctx.agentLoop`）：**全仓库唯一的具体循环**。
> 冻结模块（改接口走 ADR）。⚠️ 本包是产品宪法第三条的直接审判席——实现时
> `if` 所判断的内容**不得涉及任何具体能力**（I6，CI 静态检查守住）。

## 职责

- `create(spec)` / `resume(ref)`：创建/恢复 agent（与 `core/agent` 注册表协同）

## 不做什么

- 不出现任何针对具体能力的 `if`（不得出现 `if (needsApproval)`、`if (tokens > limit)` 之类分支）。
- 循环的协作点全部通过事件，不通过 if（20 §5.6 协作点表）：

| 时机 | 事件 | 谁用 |
|---|---|---|
| 构建请求前 | `agent/pre-step` | 压缩、上下文注入、守卫 |
| 请求可用时 | `agent/request`（waterfall，可替换调用配置） | 模型替换、降级 |
| 请求发出前 | `request/header` 落盘 | 可重放的审计点 |
| 流式片段到达 | `session/event`（chunk 类） | UI 流式渲染 |
| 工具调用前后 | `tools/pre-execute` / `tools/post-execute` | 策略、审计 |
| 轮结束 | `turn/end` | UI 收尾（最终总结的触发点） |

## 不变量

| # | 不变量 |
|---|---|
| L1 | 源码中不出现针对具体能力的判断（I6，AST 扫描守住） |
| L2 | 每次请求的 system 与 messages 必须逐字节等于从日志重建的结果（I1） |
| L3 | 循环不捕获"取消"以外的异常吞掉——任何异常都必须变成可归因的错误或明确的中断 |

## Known Limitations

- **骨架阶段未实现具体循环**（批次 ③ 落地）：以 `llm-replay` 适配器驱动，无密钥也能跑通一次循环。
- 当前仅导出接口与类型；工厂 `createAgentLoop()` 抛 `EC-NOT_READY` 作为占位。
