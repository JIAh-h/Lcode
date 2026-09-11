# @lcode/sandbox

> 能力层接口包（文档 12 / 20 §6.1「沙箱」族，`ctx.sandbox`）：**约束不是虚拟化**（D13）。
> 使用 OS 原生机制：macOS 沙箱配置 / Linux Landlock+seccomp / Windows AppContainer+Job Object。

## 实现包（按平台，用 os/cpu 字段限制安装，23 §11）

- `sandbox-macos`（darwin）
- `sandbox-linux`（linux）
- `sandbox-win32`（win32）

## 关键规则

- 各平台必须**公开已知逃逸面**（12 §3）。
- 沙箱不可用必须显式降级 `EP-SANDBOX_DEGRADED`，**不得静默**（C3 / 21 §6.3）。

## Known Limitations

- 三平台能力差距边界（12 未决问题）需实测；骨架版仅接口。
