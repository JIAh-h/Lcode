# Lcode

> 可插拔内核 + 全链路可重放的桌面级 AI 编程工作台。
> 完整设计文档见 [`docs/README.md`](./docs/README.md)；本文件说明**代码骨架**。

## 当前状态：项目骨架（v0.1 地基）

本仓库已按 [docs/23 工程脚手架与开发规范](./docs/23-工程脚手架与开发规范.md) 搭好 monorepo 骨架：

- **内核与骨架层**（含最小可运行实现）：`@lcode/context`（Service/Event/Effect 四派发）、
  `@lcode/scope`、`@lcode/session`（事件日志 + 表面投影 + 分叉，**带单测**）、`@lcode/system-prompt`、
  `@lcode/tools`（注册表 + 守卫 + 执行流水线）、`@lcode/agent`、`@lcode/agent-default-model`、`@lcode/agent-loop`（接口占位）
- **数据模型**：`@lcode/session` 事件词汇表（SessionEventMap，开放可扩展）、`@lcode/session-persistence-jsonl`
  帧编解码 + chunk 批打包、`@lcode/session-persistence-sqlite` 15 张表 DDL
- **基础工具**：`@lcode/util`（品牌类型 / LcodeError+错误码全表 / 无损 JSON(I5) / disposer / id / 重试超时）
- **能力层**：`llm`（LlmAdapter 接口）+ `llm-replay`（无密钥回放）；fs/shell/sandbox/terminal/subprocess/
  settings/credentials/compaction/skill/subagent/jobs/web/lsp/approval/extension/preset 接口包 + 50 个实现壳包
- **接入层**：`apps/desktop`（Electron main/preload + React 路由 8 屏 + 通用组件 + 三态主题）、`apps/cli`
- **工程配套**：`pnpm-workspace`、TS 三层配置、门禁脚本（check:deps / check:invariants / check:size）、fixtures、.changeset

## 快速开始

```bash
corepack enable          # 启用 pnpm（Node ≥22.19）
pnpm install
pnpm run typecheck       # 全仓类型检查
pnpm test                # 单测（util / session 已就位）
pnpm run check:deps      # 依赖方向检查（20 §3）
pnpm run dev:desktop     # 起桌面 UI（开发模式）
pnpm --filter @lcode/cli dev -- doctor   # 起 CLI
```

> 桌面端骨架 UI 也可直接在浏览器跑：`pnpm --filter @lcode/desktop exec vite` 后访问 `http://localhost:5173`
> （Electron 壳在 `pnpm dev` 中启动；首次需联网下载 Electron 二进制）。

## 目录速览

```
packages/            # @lcode/* 全部包
  core/              # 骨架层（8 包，产品契约）
  llm/ fs/ shell/ sandbox/ terminal/ subprocess/
  settings/ credentials/ session-persistence/ interaction/
  context/ compaction/ skill/ subagent/ jobs/ web/ lsp/
  preset/ extension/ bundle/ util/
apps/                # desktop（Electron）/ cli
examples/            # （空）可运行最小组合
scripts/             # 门禁脚本
fixtures/            # 测试 fixture（录制事件流，待填充）
docs/                # 设计文档（00–23）
prototype/           # 高保真原型（HTML）
```

## 约定速记（详见 docs/00 与 docs/20）

- 包名 `@lcode/*`；ESM only；跨包用包名，包内相对引用带 `.ts`
- 依赖方向：**只许向下**——接入 → 消费 → 接口 → 骨架；实现包不得被接口包依赖
- 能力接缝统一三角：接口包（Definition）+ 实现包（Provider，`register()`）+ 消费包（Consumer，`ctx` 解析）
- 一切失败用 `LcodeError`（错误码见 `@lcode/util`）；`userMessage` 必须过术语黑名单（19 §6.2）
- 事件 data 必须无损 JSON（不变量 I5）；核心循环不得出现针对具体能力的 `if`（I6）
