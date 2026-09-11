# @lcode/cli

> headless CLI（文档 10 §8 / 20 §7.2）：**另一个前端，不是简化版**——复用同一套内核 + 集束，
> 只把渲染换成终端输出。

## 必须支持（骨架占位）

- `--profile <name>`：按配置档装配运行
- `--dump-config`：打印最终插件装配（含层级与来源，23 §12 排障）
- `lcode doctor`：环境自检（Node / 沙箱 / 权限 / 模型连通性）；`--model` 打印每字段生效值与来源层
- 协议模式（JSON-RPC 2.0 over stdio，D16）

## 硬性

- 任何依赖 GUI 的能力（如审批弹窗）必须降级为明确的 **fail-closed** 或终端提问（20 §7.2）。
- stdout 即协议，日志走 stderr（13 §4）。

## Known Limitations

- 骨架版仅命令分发 + doctor 占位；内核装配随批次 ⑦ 落地。
