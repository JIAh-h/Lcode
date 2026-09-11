# fixtures — 测试固定输入

| 目录 | 内容 | 用途 |
|---|---|---|
| `sessions/<scenario>/events.jsonl` | 录制的事件流（`pnpm test:replay:record` 产出） | 快照重放的输入 |
| `diffs/` | 渲染快照期望输出 | 断言投影一致性 |
| `sessions/` | — | — |

**纪律**（文档 23 §10.4）：fixture 里的真实路径、用户名、密钥一律替换为占位符
（`/Users/<user>/...`、`sk-<redacted>`）。录制脚本自动脱敏，不依赖人工检查。

骨架阶段此目录为空，随批次 ③（llm-replay）开始填充。
