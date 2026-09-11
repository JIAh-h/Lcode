# @lcode/compaction

> 能力层接口包（文档 20 §6.1「压缩」族，`ctx.compaction`）。
> **压缩 = 追加 `surfaceOp: replace` 事件；不做删除**（D5 / 20 §6.2②）。
> 顺序必须是：**剪枝（去冗余）→ spill（大结果外置）→ 摘要（最后手段）**。

## 实现包

- `compaction-prune`：剪枝（轻量，先去冗余）
- `compaction-summary`：摘要（最后手段）

## Known Limitations

- 触发策略（token 阈值 / 时机）由插件挂 `agent/pre-step` 决定，**本包不判断**（内核无业务 if）。
