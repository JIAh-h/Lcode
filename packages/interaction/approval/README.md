# @lcode/approval

> 能力层接口包（文档 20 §6.1「交互」族，`ctx.approval`）。冻结模块（改接口走 ADR）。
> 审批**一次性**、**fail-closed**（无应答者即拒绝，D11）；**不允许"永久允许"**。
> 四个结果（22 §6.5）：`allowed-once` / `rejected` / `cancelled` / `unavailable`；
> `rejected` 与 `cancelled` 是两个不同的事实，不得合并。

## 应答者

- 由接入层提供（desktop 弹窗 / CLI 终端提问）；CLI 下部分场景只能 fail-closed（20 §7.2）。
- 审批必须落盘为可审计事件（12 §5.5）：`approval/asked` 与 `approval/decided` 成对。
