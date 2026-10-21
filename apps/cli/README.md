# @lcode/cli

> headless CLI（文档 10 §8 / 20 §7.2）：**另一个前端，不是简化版**——复用同一套内核 + 集束，
> 只把渲染换成终端输出。

## 命令

```bash
lcode run <任务描述> [--cwd <dir>] [--trust-workspace]   无 GUI 运行完整任务
lcode run --session <id> <补充要求>                       恢复已有会话继续
lcode sessions list|show <id>                             会话列表 / 详情
lcode export <id> [--format jsonl|md] [--out <dir>]        单会话导出
lcode export --all [--format jsonl|md] [--out <dir>]       全量导出 + manifest.json
lcode import <file.jsonl> [--title <name>]                 导入为新会话
lcode search <词…> [--limit <n>] [--deleted]               全文检索会话消息
lcode delete|restore <id>                                  软删 / 恢复
lcode purge <id> --exported|--force                        移入回收站（7 天保留）
lcode trash [--empty]                                      查看 / 清空回收站
lcode archive [--check]                                    压缩归档空闲 ≥30 天的会话
lcode index rebuild                                        从 JSONL 重建 SQLite 索引
lcode jobs list|kill <id>                                  活动作业（不跨进程接管）
lcode plugins list|inspect|install|activate|deactivate|uninstall
lcode doctor [--model|--sandbox|--index|--storage]         环境与运行时自检
lcode --dump-config [--profile <name>]                     打印最终服务装配（脱敏）
```

## 硬性

- 任何依赖 GUI 的能力（如审批弹窗）必须降级为明确的 **fail-closed** 或终端提问（20 §7.2）。
- stdout 即结果，日志走 stderr（13 §4）。

## Known Limitations

- 未提供 JSON-RPC over stdio 协议模式；与桌面端共用内核，但入口目前是命令式而非长驻服务。
- 后台作业只在原运行时可观察和停止；桌面端的任务面板是当前唯一常驻入口。
- 导入/导出为 JSONL；Markdown 只用于阅读，不能作为恢复输入。
