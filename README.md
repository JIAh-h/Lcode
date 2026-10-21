# Lcode

> 可插拔内核 + 全链路可重放的桌面级 AI 编程工作台。

桌面端（Electron + React）与 CLI 共用同一套内核：会话以**追加式事件日志（JSONL）为权威**，SQLite 只是可随时删库重建的投影；工具调用全程经过权限、审批、沙箱与审计；任何一次对话都能按事件回放。设计文档见 [`docs/README.md`](./docs/README.md)。

## 能力现状

- **内核与数据层**：`@lcode/context` 四派发、会话事件日志/表面投影/分叉、JSONL 编解码与崩溃恢复、SQLite 投影/迁移/重建、中文 FTS、导出与导入。
- **Agent 闭环**：`read/write/edit/glob/grep/shell/terminal/jobs` 工具流水线，审批与权限预设，计划模式，写后 diff 审阅，工作区信任，检查点回滚。
- **扩展能力**：插件宿主（独立 utility process + 受控 RPC）、技能、预设、内置 Profile 装配层；插件必须经系统沙箱启动。
- **上下文与长任务**：上下文来源（时间/指令/repo map/@文件/@会话）、压缩三级（剪枝 / spill / 摘要）、预算判定、子代理、Web 与 LSP 工具。
- **模型**：OpenAI 兼容 / DeepSeek / Anthropic / Ollama / 网关适配器、回放适配器、多模型路由、受控代码模式 `run_code`。
- **桌面体验**：侧栏工作区折叠/置顶/归档与会话操作、会话导入导出（带 SHA-256 来源审计）、归档与回收站、长会话分段渲染、关闭确认。

进度口径以 [`docs/25`](./docs/25-后续开发任务清单.md) 为准：P0–P4、P6、P7 完成；P5 的 Windows 原生沙箱已真机验收，macOS/Linux 等真机；P8 部分开始（导入/导出/归档已完成，发布与协作未开始）。

## 快速开始

要求：Node `^22.19 || >=24`、pnpm `9.12`（`corepack enable`）。国内镜像已配置在 `.npmrc`。

```bash
pnpm install
pnpm dev:desktop        # Electron + Vite（热更新）
pnpm typecheck          # 全仓类型检查
pnpm test               # 单元 / 集成（76 个文件，715 项）
```

CLI 与数据层可以独立使用：

```bash
pnpm --filter @lcode/cli start -- doctor            # 环境自检
pnpm --filter @lcode/cli start -- run "修复测试" --cwd D:/repo
pnpm --filter @lcode/cli start -- search 解析       # 全文检索会话
pnpm --filter @lcode/cli start -- sessions list
pnpm --filter @lcode/cli start -- import shared.jsonl
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:desktop` | 开发态桌面端（Vite + Electron） |
| `pnpm start:desktop` / `pnpm package:desktop` | 启动 / 打包 Windows portable |
| `pnpm dev:cli` | CLI 开发入口 |
| `pnpm typecheck` | 三层 TS 类型检查（host / client / electron） |
| `pnpm test` / `test:coverage` | 测试 / 覆盖率门禁 |
| `pnpm check:invariants` / `check:deps` | 不变量与依赖方向 |
| `pnpm check:docs` / `check:index-size` / `check:size` | 文档、索引体积、包体 |
| `pnpm bench` | 基准（派生、首屏、事件量） |

## 目录结构

```
packages/                 93 个包（按能力分组）
  core/                   context / scope / session / system-prompt / tools / agent / agent-loop / runtime-composition
  api/                    session-api / agents-api / model-api（进程内接口，经 IPC 或 CLI 暴露）
  session-persistence/    JSONL 权威日志、SQLite 投影与索引
  llm/                    llm + deepseek / openai-compatible / anthropic / ollama / gateway / replay
  fs/ shell/ subprocess/ sandbox/ terminal/ jobs/ lsp/ web/
                          能力接口 + 本地实现 + 对应工具
  compaction/ context/ skill/ subagent/ preset/ extension/ model/ code/
                          上下文工程、扩展与高级能力
  interaction/            approval / permission-presets / plan-mode / ask_user / todo
  bundle/                 lcode-base / lcode-desktop（默认组合）
apps/desktop              Electron main / preload / React renderer
apps/cli                  无 GUI 前端（复用同一内核）
docs/                     00–25 设计文档 + 上游架构研究
scripts/                  质量门禁与冒烟脚本
fixtures/                 replay / 集成测试数据
```

## 架构不变量（摘要）

1. **JSONL 是权威**：实时写入与索引重建共用同一个 `projectSession()` 纯函数，删库重建逐行一致。
2. **副作用必须受控**：策略 → 审批 → 沙箱 → 审计；文件写入在 OS 落盘前消费一次性路径许可。
3. **可重放**：模型可见的历史完全由事件日志派生，压缩不删除原始事实。
4. **能力接缝**：接口包定义契约，实现包 `register()`，消费包从 `ctx` 解析；核心循环不含具体能力分支。
5. **凭据不进渲染进程**：渲染层只能看到凭据引用与布尔结果。

## 数据位置

默认在 `~/.lcode`：`sessions/`（JSONL）、`index.db`（可重建投影）、`settings.json`、`credentials/`、`exports/`、`trash/`（7 天保留，后台定时清理）。

```bash
pnpm --filter @lcode/cli start -- index rebuild   # 从 JSONL 重建索引
pnpm --filter @lcode/cli start -- doctor --storage
```

## 文档

- 总览与全局约定：[`docs/00`](./docs/00-文档总览与全局约定.md)
- 产品与验收：[`docs/03`](./docs/03-PRD-需求规格说明.md)、[`docs/04`](./docs/04-MVP范围与验收标准.md)
- 事件与回放：[`docs/06`](./docs/06-会话事件日志与可重放设计.md)
- 安全与沙箱：[`docs/12`](./docs/12-安全权限与沙箱模型.md)
- 接口契约 / 数据字典：[`docs/21`](./docs/21-接口契约与错误码总表.md)、[`docs/22`](./docs/22-数据字典与DDL.md)
- 当前执行队列：[`docs/25`](./docs/25-后续开发任务清单.md)

## 工程约定

- ESM only；包名 `@lcode/*`；包内相对引用带 `.ts`（源码即产物）。
- 依赖方向只许向下：接入 → 消费 → 接口 → 骨架；实现包不得被接口包依赖。
- 失败一律 `LcodeError`（错误码见 `@lcode/util`）；事件 `data` 必须无损 JSON。
- 改动后至少跑 `pnpm typecheck` 与相关测试；涉及 IPC/工具/权益链路的改动需补真实进程验收。
