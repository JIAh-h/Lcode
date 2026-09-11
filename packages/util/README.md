# @lcode/util

> 零依赖基础工具层。**不依赖任何其它包**（文档 00 §5：`packages/util/` 是唯一允许零依赖的组）。

## 职责

| 模块 | 内容 |
|---|---|
| `brand.ts` | 品牌类型：`SessionId` / `AgentId` / `CallId` / `Seq`（文档 23 §6.3，全仓库唯一定义处） |
| `error.ts` | `LcodeError` 具名错误：`code` / `category` / `message` / `userMessage` / `retryable` / `details` / `cause`（文档 21 §6.1） |
| `error-codes.ts` | 错误码常量全表（`EC-` `ES-` `ET-` `EP-` `EL-` `EX-` `EF-` `EN-` `EM-` `EJ-`，文档 21 §6.2） |
| `json.ts` | 无损 JSON 序列化检查器（不变量 I5：拒绝 BigInt / NaN / undefined / 函数 / 循环引用 / Map / Set / Date / 类实例） |
| `id.ts` | 全局唯一 id 生成（`SessionId` 26 字符 A-Z0-9，nanoid 风格，文档 22 §7.2） |
| `disposer.ts` | `Disposer` 类型与逆序回滚组合（文档 21：卸载即回滚） |
| `time.ts` | epoch ms 时间原语（D18：持久事件只用 number） |
| `guard.ts` | `isPlainObject` / `isJsonValue` 等类型守卫 |
| `async.ts` | `retry`（退避重试）/ `withTimeout` / `deferred` / `AbortSignal` 工具 |

## Known Limitations

- 不提供路径 / 文件 / 网络等任何能力（那是 `fs` 等能力层的事）。
- 不提供日志器（日志属于接入层装配，见 23 §7.4）。
- `error-codes.ts` 是全量常量表；新增错误码必须同时更新 [21 §6.2](../../docs/21-接口契约与错误码总表.md)。
