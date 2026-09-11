# @lcode/llm

> 能力层接口包（文档 18 / 20 §6.1「模型」族，`ctx.llm`）：**只含类型、接口、事件声明、ctx key 声明**，不含实现。

## 内容

| 模块 | 说明 |
|---|---|
| `types.ts` | `LlmAdapter` 适配器契约（providerInfo / listModels / resolveModel / **prepareCall** / stream / providerRetryPolicy） |
| `registry.ts` | 适配器注册表（`register(adapter)` 返回 disposer；消费方按 provider 名查找，**绝不 import 具体包**） |

## 铁律

- **`prepareCall()` 不是可选项**（20 §6.2）：必须把"解析配置 → 拉凭据 → 物化默认值 → 构造请求"
  锁在**同一注册代**上——否则热重载时可能把 A 适配器的能力结果配上 B 适配器的端点。
- 实现包只在 `apply()` 里注册（C1）；消费方通过 `ctx.llm` 解析，不缓存跨会话引用（C2）。
- 不做自动路由 / 自动测速 / 自动降级省钱（D21）。

## 实现包（按平台/供应商）

`llm-anthropic` / `llm-openai` / `llm-deepseek` / `llm-ollama` / `llm-gateway` / `llm-replay`（骨架已含 replay）。

## Known Limitations

- 流协议 `StreamChunk`（闭合联合）定义在 `@lcode/session`（06 §2.3），本包复用。
- 凭据解析（D22）与六层配置合并（D19）由 `credentials` / `settings` 在调用链中注入。
