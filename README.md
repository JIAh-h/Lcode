<div align="center">

<img src="prototype/images/app_icon_white_card_1024.png" width="96" alt="Lcode 图标" />

# Lcode

**跑在自己电脑上的 AI 编程工作台** —— 桌面端与 CLI 共用同一套内核，对话即任务，改动可回放、可审计。

`Electron 33 · React 18 · TypeScript · pnpm monorepo`

</div>

---

## 这是什么

Lcode 是一个本地优先的 AI coding agent：

- **以对话驱动真实工程任务**——它能读写你的仓库、执行命令、跑测试、提交改动，全程在桌面应用里完成；
- **本地优先**——模型供应商、API Key、会话数据全部由你掌控，不依赖任何云端服务编排；
- **全链路可控**——每一次文件写入和命令执行都要经过权限预设、审批确认与系统沙箱；
- **一切可回放**——会话以追加式事件日志（JSONL）为唯一权威，任何一轮对话都能按事件精确重放，压缩不删除原始事实。

桌面端（Electron）与 CLI 共用同一内核与同一份数据，设计文档见 [`docs/00`](./docs/00-文档总览与全局约定.md)。

## 功能特性

**桌面工作台**

- 工作区/最近任务侧栏：会话置顶、重命名、归档与回收站（可恢复，到期自动清理）
- 流式回复：边生成边渲染 Markdown（含表格），自动贴底、上翻即停、一键回底
- 执行过程紧凑列表：每一步工具调用可展开查看输出、原始参数与「为什么」
- 输入区：斜杠命令（`/model` `/compact` `/plan` `/skills` …）、附件（文件正文/文件夹目录树、支持拖入）、粘贴图片、技能多选
- 上下文状态栏：工作区 · Git 分支 · 实测上下文占用，支持手动压缩（预览 → 确认 → 可撤销）
- 编辑重发 / 重试本轮 / 从任意轮分支 / 回放时间轴；会话导入导出（zip 包，带 SHA-256 审计）
- 中英双语界面，自定义应用图标

**Agent 能力**

- 工具流水线：`read / write / edit / delete / glob / grep / shell / terminal / jobs / lsp / web …`；`delete` 只删单个文件或空目录（不递归），模型收尾清理临时产物用它，不走 shell
- 长会话按轮分页：首屏只发最后若干轮（按 turn 边界切，不会劈开一轮），流式增量不进历史回放路径；产物卡片的逐行 diff 悬停时才按需读取
- 权限预设（只读 / 标准 / 自动 / 完全访问 / 无人值守）、逐次审批、OS 级沙箱（Windows 原生沙箱已真机验收）
- 计划模式：先只读探索出计划，确认后再执行；写后 diff 审阅与检查点回滚
- 异步子代理：`delegate_async` / `delegate_wait` 派发长任务不阻塞主对话，取消向上传播
- 后台作业与终端复用
- **Agent 预设**：标准模式处理日常任务；创造模式在标准能力上加代码运行器与创作指导（写脚本、造插件/技能），新建会话时可选，创建后该会话内固定

**记忆与检索**

- 两层记忆：用户记忆（`~/.lcode/memory/USER.md`，跨项目跟随人）与项目记忆（工作区 `AGENTS.md` 等，团队共享），设置页可直接查看与编辑，保存后下一次请求生效
- 写入走显式触发（用户明确说"记住"或纠正做法），模型经 `edit`/`write` 直接写，不设旁路
- 跨会话检索：`session_search` 让模型在历史会话里全文检索（中文逐字分词，1~3 字查询可命中），结果按片段截断并标注为不可信证据

**跨会话编排（Super-agent）**

一个会话当调度者、多个会话当执行者，用于需要拆分并行推进的任务：

- **Router 会话**只判断与派发，**不持有任何执行工具**（不能改文件、不能跑命令）；worker 是工作区里真实可见的独立会话
- 派发时给出**边界**（`scope`）与**完成判据**（`doneWhen`），worker 的完成标准不由它自己定义
- `inject_worker` 可向已派发的 worker 追加输入——补充要求、追问细节、回答它的提问，**不打断**已完成的进度
- worker 通过 `report_to_router` 主动回传进度 / 求助 / 完成；求助**绕过批处理立刻上报**
- `list_workers` 让 Router 主动巡检；会话页状态条随时可见在途数量并单独取消
- 授权档位**按会话**：新建编排会话默认真派发，也可降为「只观察」预演
- 汇报自动合并（200ms 窗口 + 10s 冷却），无产出不打扰、失败必开口

设计见 [`docs/26`](./docs/26-Super-agent跨会话编排设计.md)，验收见 [`docs/27`](./docs/27-P11跨会话编排测试报告.md)。

**上下文工程**

- 稳定系统前缀 + 轮次级固定/屏蔽，保护供应商提示词缓存命中
- 手动压缩三级策略（剪枝 / spill / 摘要），摘要生成先预览、可调范围、可撤销
- 上下文来源：运行时环境、repo map、@文件、技能指令；附件正文随消息发送（超长自动截断并提示按路径续读）

**模型接入**

- OpenAI 兼容 / DeepSeek / Anthropic / Ollama / 网关适配器，多供应商多模型，界面内增删与连通性测试
- 供应商元数据驱动的模型能力识别（视觉支持、上下文窗口上限）；凭据只存主进程，渲染层只见引用

**扩展**

- 插件两个半区：**host**（宿主进程内加载，注册工具/提示词段/事件订阅/HTTP 路由）与 **client**（渲染层界面扩展：主题换肤、侧边栏/会话流/设置页面板）；插件安全靠"只能调用 ctx 提供的能力 + contributes 逐项核对 + 权限白名单"
- **插件资源通道**：`lcode-plugin://` 协议伺服插件自己目录里的图片/视频/字体；不够用时插件可 `ctx.registerRoute` 自建路由（对齐 DSH 的 webServer——平台只给入口，资源由插件伺服）
- **统一插件加载器**：内置能力与第三方插件走同一个装配路径（依赖拓扑排序、缺失即启动期报错）；`plugins.disabled` 按条目粒度禁用任一能力；坏插件降级告警不拖垮应用
- **创造模式自验证闭环**：`plugin_install` 装进真实环境、`plugin_verify` 在一次性临时环境里装一遍并断言声明的贡献项是否真的注册，失败可自己改到通过
- 创造模式技能（`lcode-plugin-creator`）：渐进式披露规范 + 四个可运行模板（工具/提示词/监听器/主题），端到端验证过的安装与校验清单
- 技能（SKILL.md / zip 导入，用户与工作区两级目录）

## 快速开始

环境要求：Node `^22.19 || >=24`、pnpm `9.12`（`corepack enable`）。国内镜像已配置在 `.npmrc`，无需额外设置。

```bash
pnpm install
pnpm dev:desktop        # 启动桌面端（Vite + Electron，热更新）
```

首次启动进入「设置 → 模型」添加供应商（接口地址 + API Key + 模型），即可开始对话。

打包 Windows portable 版（自带图标与版本信息的 `Lcode.exe`）：

```bash
pnpm package:desktop    # 产物在 out/lcode-win32-x64/
```

打包 Windows 安装器（NSIS，可选安装路径 / 快捷方式 / 卸载项）：

```bash
pnpm package:setup      # 产物为 out/Lcode Setup <version>.exe
```

两条发布路径共用同一份 staging（`out/lcode-win32-x64/`）：portable 脚本负责收集 Electron
runtime、原生 SQLite 绑定与沙箱 helper，`electron-builder.config.cjs` 再把它封成安装器。
数据目录固定在 `~/.lcode`（`LCODE_HOME` 可覆盖），与安装路径无关，所以**升级或重装不会丢配置**。

CLI 可以独立使用（复用同一内核与数据）：

```bash
pnpm --filter @lcode/cli start -- doctor                 # 环境自检
pnpm --filter @lcode/cli start -- run "修复失败的测试" --cwd D:/repo
pnpm --filter @lcode/cli start -- search 解析             # 会话全文检索
pnpm --filter @lcode/cli start -- sessions list
```

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:desktop` | 开发态桌面端（Vite + Electron） |
| `pnpm start:desktop` | 以构建产物启动桌面端 |
| `pnpm package:desktop` | 打包 Windows portable |
| `pnpm package:setup` | 打包 Windows 安装器（NSIS） |
| `pnpm dev:cli` | CLI 开发入口 |
| `pnpm typecheck` | 三层类型检查（host / client / electron） |
| `pnpm test` | 单元 / 集成测试（Vitest） |
| `pnpm check:invariants` / `check:deps` | 架构不变量与依赖方向门禁 |
| `pnpm check:docs` / `check:size` / `bench` | 文档、包体与基准 |

## 架构一览

```
┌────────────────────────────────────────────┐
│  apps/desktop (Electron + React)  apps/cli │   ← 前端，可替换
├────────────────────────────────────────────┤
│  bundle/lcode-desktop · lcode-base         │   ← 默认能力组合
├────────────────────────────────────────────┤
│  agent-loop · tools · interaction · llm    │   ← 能力实现
│  subagent · orchestration · compaction …   │
│  skill · sandbox · terminal · context …    │
├────────────────────────────────────────────┤
│  api/*  接口契约（session / agents / model）│   ← 进程内接口
├────────────────────────────────────────────┤
│  session-persistence：JSONL 权威 + SQLite 投影 │  ← 数据层
└────────────────────────────────────────────┘
```

97 个包按能力分组，核心不变量：

1. **JSONL 是权威**：索引可随时删库重建，逐行一致；
2. **副作用必须受控**：策略 → 审批 → 沙箱 → 审计；
3. **可重放**：模型可见的历史完全由事件日志派生；
4. **能力接缝**：接口包定义契约，实现包 `register()`，核心循环不含具体能力分支；
5. **凭据不进渲染进程**：渲染层只能看到凭据引用与布尔结果。

## 数据与配置位置

默认都在 `~/.lcode`：

| 路径 | 内容 |
| --- | --- |
| `sessions/` | 会话 JSONL（权威日志） |
| `index.db` | SQLite 投影（可随时 `index rebuild` 重建） |
| `settings.json` · `credentials/` | 配置与凭据（凭据值只在主进程解密） |
| `memory/USER.md` | 用户记忆（跨项目个人偏好，可手改） |
| `plugins/` | 已安装的第三方插件（`<id>/<version>/`） |
| `skills/` | 用户技能（工作区级在 `<repo>/.lcode/skills`） |
| `exports/` · `trash/` | 导出包与回收站（7 天保留，后台清理） |

## 文档

完整设计与契约都在 [`docs/`](./docs/00-文档总览与全局约定.md)（00–30 号文档）：产品与验收（03/04）、事件日志与回放（06）、上下文工程（09）、安全与沙箱（12）、接口契约与数据字典（21/22）、跨会话编排（26/27）、记忆系统（28）、跨会话检索（29）、统一插件加载器草案（30）、任务清单（25）。

## 工程约定

- ESM only；包名 `@lcode/*`；包内相对引用带 `.ts`（源码即产物）。
- 依赖方向只许向下：接入 → 消费 → 接口 → 骨架。
- 失败一律 `LcodeError`（错误码见 `@lcode/util`）；改动后至少跑 `pnpm typecheck` 与相关测试。

## 状态

当前进度以 [`docs/25`](./docs/25-后续开发任务清单.md) 为准：核心内核、Agent 闭环、上下文工程、桌面体验、MCP/LSP/语义索引、异步子代理、**跨会话编排**（P0–P7、P9–P11）、**记忆系统**、**跨会话检索**、**client 插件**、创造模式与**统一插件加载器**（docs/30 P0–P4）已完成；Windows 原生沙箱已真机验收；发布与协作（P8）进行中。

测试与门禁：**1017 项测试 / 112 个测试文件**全绿，`typecheck`、架构不变量、依赖方向、文档完整性、包体积门禁全部通过；跨会话编排另用真实模型跑通 `auto` 与 `observe` 两档端到端流程；client 插件（换肤）已端到端验证。

## 许可证

[MIT](./LICENSE) © 2026 JIAh-h
