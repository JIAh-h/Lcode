import { InMemoryAgentStore } from '@lcode/agent'
import { createAgentLoop } from '@lcode/agent-loop'
import type { AgentLoopRuntime } from '@lcode/agent-loop'
import { LocalAgentsApi } from '@lcode/agents-api'
import { LocalSessionsApi } from '@lcode/session-api'
import { InMemoryToolRegistry } from '@lcode/tools'
import { createSystemPromptService } from '@lcode/system-prompt'
import type { SessionService } from '@lcode/session'
import { initZstd } from '@lcode/session-persistence-jsonl'
import type { DesktopServices } from './model-feature.ts'
import { createServices } from './model-feature.ts'

/**
 * **agent 运行时装配**（docs/24 T5.2/T5.3；20 §5.6）。
 *
 * 这是"把内核接起来"的那一层，也是此前一直缺的一块：`agent-loop` / `sessions.*` /
 * `tools` / `systemPrompt` 各自都有实现，但**没有任何地方把它们拼在一起**——
 * 所以模型配好了也没东西在用。
 *
 * ## 一条关键接线：引擎与 sessions 必须共享同一条日志
 *
 * `getSession` 走 `sessionsApi.sessionServiceFor(sessionId)`，而它是
 * `InMemorySessionStore` 外套了一层**写穿到 JSONL** 的包装（`createPersistedSession`）。
 * 如果图省事直接 `new InMemorySessionStore()`，引擎的事件只会停在内存里——
 * 对话看起来能跑，但**刷新就没了**，而且索引里什么都没有。
 *
 * ## 装配顺序有依赖
 *
 * 1. `createServices()` 建 ctx（`ctx.llm` / `ctx.agentDefaultModel`）
 * 2. 挂 `ctx.tools` / `ctx.systemPrompt`（提示词装配要读工具 schema，所以 tools 先挂）
 * 3. 建 `AgentLoop`（它要 `ctx` 与 `getSession`）
 * 4. 挂 `ctx.agents`（AgentStore 要 `ctx` 与 `getSession`）
 * 5. 最后建 `LocalAgentsApi`（它要 `ctx.agents` 与 `ctx.agentLoop` 都在位）
 */

export interface AgentRuntimeOptions {
  readonly home?: string | undefined
  /** 复用已建好的服务（主进程里与设置页共享同一个 ctx） */
  readonly services?: DesktopServices | undefined
  /**
   * 审批服务（批次⑥）。
   *
   * 省略 = 一切需要审批的动作都会被**拒掉**（fail-closed，D11）——这是合法配置
   * （无人值守场景），但在桌面端漏传就等于"什么都干不了"，所以装配层要显式传。
   */
  readonly approval?: ApprovalService | undefined
  /** 沙箱实现（省略 = 无约束，结果里如实标 `enforced: false`） */
  readonly sandbox?: SandboxService | undefined
  /** 会话的初始工作区根（新会话默认落在这里） */
  readonly workspaceRoot?: string | undefined
}

import type { Disposer } from '@lcode/util'
import type { SessionEvent } from '@lcode/session'
import type { ApprovalService } from '@lcode/approval'
import { createLocalFs } from '@lcode/fs-local'
import { createLocalShell } from '@lcode/shell-local'
import { createLocalSandbox } from '@lcode/sandbox-local'
import { createShellTool } from '@lcode/tool-shell'
import { createFsTools } from '@lcode/tool-fs'
import type { ToolDefinition } from '@lcode/tools'
import type { SandboxService } from '@lcode/sandbox'
import { DEFAULT_PRESET, InMemoryPermissionPresets, installPolicyHook } from '@lcode/permission-presets'

export interface AgentRuntime {
  readonly services: DesktopServices
  /** `sessions.*`（列表 / 元信息 / 创建 / 取会话句柄） */
  readonly sessions: LocalSessionsApi
  /** `agents.*`（对话入口） */
  readonly agents: LocalAgentsApi
  readonly loop: AgentLoopRuntime
  readonly ctx: DesktopServices['ctx']
  /**
   * 订阅某个会话的事件流（UI 的数据源，06 §5.1 步骤⑤）。
   *
   * **要求会话已打开**（`sessions.create` / `resume` 会打开它）——这是刻意的：
   * 未打开的会话没有内存镜像，也就没有事件可订阅。调用方拿到的 disposer 要及时调用，
   * 否则会话关闭后订阅还在（虽然不会崩，但会泄漏）。
   *
   * 注意它是**同步广播**：观察者抛错不会影响 `append()`（见 `InMemorySessionStore.broadcast`
   * 的逐个包含），所以 IPC 转发里的异常不会污染引擎的写入路径。
   */
  watchSession(sessionId: string, handler: (event: SessionEvent) => void): Disposer
  dispose(): Promise<void>
}

export async function createAgentRuntime(options: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
  /*
   * zstd 必须在**任何会话读写之前**初始化好。
   *
   * 原因：`loadLog()` 是同步 API，而 zstd 的 WASM 初始化是异步的——所以初始化被设计成
   * "装配层一次 await，底下保持同步"。漏了这一步的后果是**归档过的会话打不开**
   * （报 ES-FORMAT_UNSUPPORTED），而普通会话看不出任何问题。
   */
  await initZstd()

  const services = options.services ?? createServices(options)
  const ownsServices = options.services === undefined
  const { ctx, home } = services

  // ① sessions：事件日志的唯一 owner（+ JSONL 持久化 + SQLite 索引）
  const sessions = new LocalSessionsApi({ home })

  // ② 引擎与 sessions 共享同一条日志（见文件头注释）
  const getSession = (sessionId: string): SessionService => sessions.sessionServiceFor(sessionId)

  // ③ 工具注册表 → 提示词装配（后者要读前者的 schema）
  const tools = new InMemoryToolRegistry(ctx)
  ctx.set('tools', tools)
  const systemPrompt = createSystemPromptService(tools)
  systemPrompt.section('base', BASE_SYSTEM_PROMPT)
  ctx.set('systemPrompt', systemPrompt)

  /*
   * ③b 工具族 + 权限（批次⑤⑥）。
   *
   * 这两件事**必须一起装**（14 §3.5）：只装工具就是"能改文件却没人拦"，
   * 只装权限则没有任何东西可拦。所以它们在这一段里成对出现。
   */
  const sandbox: SandboxService = options.sandbox ?? createLocalSandbox()
  ctx.set('sandbox', sandbox)
  const approval = options.approval

  /*
   * 工作区根取两处之一：显式传入的，或**第一个已打开会话**的 cwd。
   *
   * 这里给的是"新会话的默认工作区"以及"路径解析的基准"。注意**每个会话**的真实
   * 工作区由 `sessions.workspaceOf()` 在审批时现查——多工作区是这个函数的常态，
   * 不能拿一个进程级的基准去代替（见 `PolicyHookOptions.workspaceOf` 的说明）。
   */
  const workspaceRoot = options.workspaceRoot ?? process.cwd()

  /*
   * `fs` 是**单例**，而工作区是**每会话**的（一个进程里可以开着多个项目）。
   * 所以这里把"按会话解析工作区"的能力交给工具层——相对路径在进 `FsService`
   * 之前就被解成绝对路径（20 §6.1）。少了这一步，A 项目里说 `read hello.txt`
   * 会去进程启动目录找（实测踩过）。
   */
  const fsService = createLocalFs({ workspaceRoot })
  ctx.set('fs', fsService)
  const { shell } = createLocalShell({
    workspaceRoot,
    wrap: (argv, policy) => sandbox.wrap(argv, policy),
  })
  ctx.set('shell', shell)

  for (const tool of createFsTools({
    fs: fsService,
    workspaceRoot,
    workspaceOf: (sessionId) => sessions.workspaceOf(sessionId),
  })) {
    tools.register(tool as ToolDefinition)
  }
  tools.register(createShellTool({ shell, workspaceRoot, workspaceOf: (sessionId) => sessions.workspaceOf(sessionId) }))

  // 策略钩子：判定 → 需要则审批 → 只有 allowed-once 才放行
  const presets = new InMemoryPermissionPresets(DEFAULT_PRESET)
  ctx.set('permissionPresets', presets)
  const uninstallPolicy = installPolicyHook({
    ctx,
    ...(approval === undefined ? {} : { approval }),
    presets,
    workspaceOf: (sessionId) => sessions.workspaceOf(sessionId),
    getSession: (sessionId) => {
      try {
        return sessions.sessionServiceFor(sessionId)
      } catch {
        // 会话没打开（例如审批发生在会话关闭之后）：不阻碍判定，只是不落盘
        return undefined
      }
    },
  })

  // ④ 循环（唯一的具体循环）
  const loop = createAgentLoop({ ctx, getSession })
  ctx.set('agentLoop', loop)

  // ⑤ 活体 agent 注册表（依赖 ctx 与 getSession）
  ctx.set('agents', new InMemoryAgentStore(ctx, getSession))

  // ⑥ 边界层：`agents.*`（对话入口）
  const agents = new LocalAgentsApi({ ctx, getSession })

  return {
    services,
    sessions,
    agents,
    loop,
    ctx,
    watchSession(sessionId, handler) {
      // `sessionServiceFor` 会校验"会话已打开"并抛 ES-SESSION_NOT_FOUND——
      // 那正是我们要的行为：未开放的会话没有内存镜像，也没有事件可订阅。
      return sessions.sessionServiceFor(sessionId).onEvent(handler)
    },
    async dispose() {
      uninstallPolicy()
      await sessions.close()
      if (ownsServices) services.dispose()
    },
  }
}

/**
 * 系统提示（基础段）。
 *
 * 工具清单本身由 `createSystemPromptService(tools)` 从注册表读（`schemas()`），
 * 所以这里**只写"你是谁、怎么干活"**，不重复罗列工具名——罗列会有两个来源，
 * 而它们迟早会不一致。
 *
 * 三条纪律写在这里是因为它们决定了模型**怎么用**工具，光有 schema 表达不出来：
 * 读之前先找、改之前先看、失败了自己纠错而不是编造。
 */
const BASE_SYSTEM_PROMPT = [
  '你是 Lcode —— 一个跑在用户本机、面向开发者的 AI 编码助手。',
  '',
  '## 怎么干活',
  '',
  '- 需要看代码就用 read / glob / grep 去**真的读**，不要凭印象猜文件内容。',
  '- 改代码用 edit（精确替换）或 write（整文件覆盖）。edit 要求 old 在文件里唯一出现，',
  '  不唯一时会报错并告诉你出现几次 —— 那是让你补充上下文，不是让你换一种改法。',
  '- 需要跑命令/测试用 shell。**退出码非 0 不代表工具坏了**，那是命令的结果',
  '  （比如 grep 没匹配到会返回 1），请读 stdout/stderr 判断发生了什么。',
  '- 工具失败会以结构化错误返回给你，**带错误码**。看错误码判断原因并自己修正，',
  '  不要重复同一个失败的调用。',
  '',
  '## 关于权限',
  '',
  '工作区内的读写可以直接做。改动工作区之外的文件、跑项目里没出现过的命令、',
  '读取疑似凭据的文件（.env / id_rsa / .ssh 等）会**先询问用户**。',
  '如果某个操作被拒绝，那不是 bug —— 那是用户或策略的决定。',
  '不要试图绕过它（比如换一条等价命令），把情况如实告诉用户。',
  '',
  '## 边界',
  '',
  '- 不要编造文件内容、命令输出或测试结果。没读过就说没读过。',
  '- 不确定的事要说不确定。',
].join('\n')
