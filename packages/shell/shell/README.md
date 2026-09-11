# @lcode/shell

> 能力层接口包（文档 20 §6.1「Shell」族，`ctx.shell`）：**只含类型、接口**，不含实现。
> 沙箱只约束**即将 spawn 的 argv**，不约束工具逻辑（20 §6.1）。

## 实现包

- `shell-local`：本机 shell（批次 ⑤ 落地）
- `shell-sandbox`：受沙箱约束的 shell
- `tool-shell`：把 `ctx.shell` 暴露给模型的消费包（`shell` / `bash`，21 §3.6）

## Known Limitations

- 进程树必须可整体终止（不留孤儿进程）——`subprocess` 族负责；骨架版接口先行。
