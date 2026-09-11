# @lcode/tools

> 骨架层核心（文档 20 §5.3，`ctx.tools`）：**作用域工具注册表 + 受守卫的执行流水线**。
> 冻结模块（改接口走 ADR）。

## 职责

- 注册工具（返回 disposer）
- 当前可见 schema 列表（受作用域与 restrict 影响）
- 收窄可见集合（只能收窄，不能放宽）
- 注册守卫：类型上只有 `deny` 与"弃权"，**没有 allow**（D10 / D11）
- 执行（唯一入口；调用方不得绕过）

## 不做什么

- 不实现任何具体工具（具体工具是 `tool-*` 消费包）。
- 不决定权限（策略通过 guard / waterfall 注入）。
- **不写 session 日志**（S2：只有 session 能写日志；`tool/call` 与 `tool/result` 的落盘由调用方负责）。

## 不变量

| # | 不变量 | 说明 |
|---|---|---|
| T1 | **参数不可被中间件改写**（D9） | 执行器只收"原始 JSON 字符串 + 解析值"二元组，任何钩子拿不到改写权 |
| T2 | 守卫**没有 allow**（类型上不可能） | 杜绝"监听器顺序决定结果" |
| T3 | 工具返回**规范值**，UI 渲染是纯投影（D8） | 模型与 UI 不可能分叉 |
| T4 | 无应答者即 `unavailable`（fail-closed，D11） | 权限缺省安全 |
| T5 | 任何 `tool/call` 必须有配对的 `tool/result`（I3） | 否则下一轮请求会被模型 API 拒绝 |

## 事件（发布）

`tools/pre-execute`（waterfall，可 allow/deny/ask）、`tools/execute`、`tools/post-execute`。
订阅：`agent/pre-step`（用于清理临时状态）。

## Known Limitations

- 参数校验为内置轻量校验（必填键 + 类型初查）；完整 JSON Schema 校验（zod/ajv）随批次 ⑤ 接入。
- 九步流水线的审批 / 沙箱 / 展示投影段由 `interaction/*`、`sandbox`、卡片投影层在后续批次挂载。
