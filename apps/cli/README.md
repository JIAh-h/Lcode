# @lcode/cli

> headless CLI（文档 10 §8 / 20 §7.2）：**另一个前端，不是简化版**——复用同一套内核 + 集束，
> 只把渲染换成终端输出。

## 当前支持

- `--profile <name>`：按配置档装配运行
- `--dump-config`：打印最终插件装配（含层级与来源，23 §12 排障）
- `lcode doctor`：环境自检（Node / 沙箱 / 权限 / 模型连通性）；`--model` 打印每字段生效值与来源层
- 协议模式（JSON-RPC 2.0 over stdio，D16）
- `lcode run <任务描述> [--cwd <dir>] [--trust-workspace]`：无 GUI 运行完整任务；与桌面端共享模型、会话、工具、审批与事件流。未授信工作区只能读取；此开关显式授予该精确目录写入与命令权限
- `lcode run --session <id> <补充要求>`：恢复已有会话继续任务
- `lcode jobs list|status|read|kill`：说明活动作业的驻留边界；当前不跨进程恢复或接管桌面作业

## 硬性

- 任何依赖 GUI 的能力（如审批弹窗）必须降级为明确的 **fail-closed** 或终端提问（20 §7.2）。
- stdout 即协议，日志走 stderr（13 §4）。

## Known Limitations

- 当前仍未实现 JSON-RPC stdio 与插件；后台作业只在原运行时可观察和停止，桌面端任务面板是当前入口。
