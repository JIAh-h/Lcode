# @lcode/terminal

> 能力层接口包（文档 20 §6.1「终端」族，`ctx.terminals`）。
> **终端输入不经过模型**，除非显式引用（20 §6.1）。实现：`terminal-pty`；消费：`tool-terminal`。

## Known Limitations

- Windows ConPTY 行为差异与 CI 覆盖策略待定（23 未决问题）。
