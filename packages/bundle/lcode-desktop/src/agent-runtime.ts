import { InMemoryAgentStore } from '@lcode/agent'
import { createAgentLoop } from '@lcode/agent-loop'
import type { AgentLoopRuntime } from '@lcode/agent-loop'
import { LocalAgentsApi } from '@lcode/agents-api'
import { createLocalFileCheckpointService, LocalSessionsApi } from '@lcode/session-api'
import type { FileCheckpointService, RuntimeSessionsService } from '@lcode/session-api'
import { InMemoryToolRegistry } from '@lcode/tools'
import { createSystemPromptService } from '@lcode/system-prompt'
import type { SessionService } from '@lcode/session'
import { initZstd } from '@lcode/session-persistence-jsonl'
import type { DesktopServices } from './model-feature.ts'
import { createServices } from './model-feature.ts'
import { FALLBACK_CONTEXT_WINDOW } from '@lcode/model-api'

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
  /** 受发行包信任的内部装配 profile；外部插件不在此选择范围内。 */
  readonly profile?: BuiltinRuntimeProfileId | undefined
  /** 显式注入的网页 Provider；省略时默认 Profile 不暴露联网工具。 */
  readonly web?: WebService | undefined
  /** 显式注入的语言服务 Provider；省略时默认 Profile 不启动语言服务进程。 */
  readonly lsp?: LspService | undefined
  /** 可替换的模型路由策略；省略时仍挂载空规则 provider，保持整轮冻结语义。 */
  readonly modelRouting?: ModelRoutingService | undefined
  /** 可替换的代码运行器；默认 provider 仅在真实只读沙箱下运行。 */
  readonly codeRuntime?: CodeRuntime | undefined
  /** 显式摘要器；只在用户手动压缩时调用，不参与自动触发。 */
  readonly compactionSummarizer?: CompactionSummarizer | undefined
}

import type { Disposer } from '@lcode/util'
import type { SessionEvent } from '@lcode/session'
import type { ApprovalService } from '@lcode/approval'
import { createFsMutationAuthority, createLocalFs } from '@lcode/fs-local'
import { createLocalShell } from '@lcode/shell-local'
import { createWindowsSandbox, createWindowsSandboxBridge } from '@lcode/sandbox-win32'
import { createMacosSandbox } from '@lcode/sandbox-macos'
import { createLinuxSandbox } from '@lcode/sandbox-linux'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import { createLocalJobs } from '@lcode/jobs-local'
import { createShellTool } from '@lcode/tool-shell'
import { createTerminalTool } from '@lcode/tool-terminal'
import { createLocalTerminal } from '@lcode/terminal-pty'
import { createFsTools } from '@lcode/tool-fs'
import type { SandboxService } from '@lcode/sandbox'
import { createLocalPermissionPresets, createLocalWorkspaceTrust, installPolicyHook } from '@lcode/permission-presets'
import { createPlanModeService } from '@lcode/plan-mode'
import { LocalPluginRegistry, type PluginInfo } from '@lcode/plugin-registry'
import { createPluginHost, InstalledPluginLifecycleService, PluginLifecycleManager, pluginUtilityRunnerPath } from '@lcode/plugin-host'
import { createLocalSkillFilesystem } from '@lcode/skill-filesystem'
import { registerSkillTools } from '@lcode/tool-skill'
import { createLocalAgentPresets, type PresetSnapshot } from '@lcode/agent-presets'
import { composeRuntimeProfile, type InternalBundleEntry, type RuntimeCompositionSnapshot } from '@lcode/runtime-composition'
import { registerLocalContextSources } from '@lcode/context-local'
import { registerContextBudget } from '@lcode/context-budget'
import type { TokenMeasurement } from '@lcode/context-budget'
import { createLocalCompactionSummary } from '@lcode/compaction-summary'
import type { CompactionResult, CompactionService } from '@lcode/compaction'
import { registerCompactionPrune } from '@lcode/compaction-prune'
import { registerLocalSpill } from '@lcode/spill-local'
import { registerInprocessSubagents } from '@lcode/subagent-inprocess'
import type { InprocessSubagentService } from '@lcode/subagent-inprocess'
import { createSubagentTool } from '@lcode/tool-subagent'
import type { WebService } from '@lcode/web'
import { createWebTools } from '@lcode/tool-web'
import type { LspService } from '@lcode/lsp'
import { createLspTools } from '@lcode/tool-lsp'
import { createModelRouter, registerModelRouter, type ModelRoutingService } from '@lcode/model-router'
import type { CodeRuntime } from '@lcode/code-runtime'
import { createSubprocessCodeRuntime } from '@lcode/code-runtime-subprocess'
import { createCodeTool } from '@lcode/tool-code'
import { join } from 'node:path'
import { createBuiltinRuntimeProfile, type BuiltinRuntimeProfileId } from './runtime-profile.ts'
import { createModelCompactionSummarizer, type CompactionSummarizer } from './compaction-summarizer.ts'

declare module '@lcode/context' {
  interface Services {
    /** `session-api` 发布契约，desktop bundle 负责把本地 provider 挂进 root Context。 */
    sessions: RuntimeSessionsService
  }
}

export interface SessionContextUsage {
  /** 当前默认模型配置的输入窗口；未配置时 null（不猜） */
  readonly contextWindowTokens: number | null
  /** 当前上下文占用；优先采用供应商 usage 基线 */
  readonly usedTokens: number
  /** 占用百分比（0–100）；未配置窗口时 null */
  readonly percent: number | null
  /** provider = 整段有实测基线；mixed = 实测基线 + 新增估算；estimate = 纯本地估算 */
  readonly usageSource: 'provider' | 'mixed' | 'estimate'
  readonly measurement: TokenMeasurement
}

export interface AgentRuntime {
  readonly services: DesktopServices
  /** `sessions.*`（列表 / 元信息 / 创建 / 取会话句柄） */
  readonly sessions: LocalSessionsApi
  /** `agents.*`（对话入口） */
  readonly agents: LocalAgentsApi
  readonly loop: AgentLoopRuntime
  readonly ctx: DesktopServices['ctx']
  /** P6-01 文件检查点；恢复会追加审计事件，不会修改既有会话历史。 */
  readonly checkpoints: FileCheckpointService
  /** P6 产品入口：安装快照、生命周期和只读检查都由同一 Runtime 持有。 */
  readonly plugins: PluginRuntimeService
  /** P6 产品入口：Skill 只读目录与按需正文加载。 */
  readonly skills: RuntimeSkillService
  /** P6 产品入口：预设只生成可审计的会话快照，不直接越权改变运行时。 */
  readonly presets: RuntimePresetService
  /** P7-02：显式压缩事务；自动触发与成本判定由后续 provider 决定。 */
  readonly compaction: CompactionService
  /**
   * 当前会话的上下文占用估算。返回的是**估算值**（2 字符/token），
   * 供输入框状态栏显示；真实计费仍以 provider usage 为准。
   */
  contextUsage(input: { readonly sessionId: string }): Promise<SessionContextUsage>
  /**
   * 手动压缩较早历史：用当前默认模型生成摘要，并提交 `trigger:'manual'` 事务。
   * 有回合正在执行时拒绝（表面正在被写入，切点不安全）。
   */
  compactSession(input: { readonly sessionId: string }): Promise<CompactionResult>
  /** P7-04：受限的进程内子代理 provider；不能取得审批端口或扩展 root Context。 */
  readonly subagents: InprocessSubagentService
  /** 当前实际的内置组合；只含 service 关系，不含凭据、路径或运行时句柄。 */
  readonly composition: RuntimeCompositionSnapshot
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

export interface PluginRuntimeService {
  list(): readonly PluginInfo[]
  installLocal(path: string): Promise<{ readonly id: string; readonly version: string; readonly hash: string }>
  activate(input: { readonly id: string; readonly version: string }): Promise<void>
  deactivate(input: { readonly id: string; readonly version: string }): Promise<void>
  uninstall(input: { readonly id: string; readonly version: string }): Promise<void>
  inspect(): ReturnType<InstalledPluginLifecycleService['inspect']>
}

export interface RuntimeSkillService {
  catalog(): ReturnType<ReturnType<typeof createLocalSkillFilesystem>['catalog']>
  load(id: string): ReturnType<ReturnType<typeof createLocalSkillFilesystem>['load']>
}

export interface RuntimePresetService {
  list(): ReturnType<ReturnType<typeof createLocalAgentPresets>['list']>
  load(id: string): ReturnType<ReturnType<typeof createLocalAgentPresets>['load']>
  snapshot(input: { readonly sessionId: string; readonly ids: readonly string[] }): Promise<PresetSnapshot>
}

type MountedAgentRuntime = Omit<AgentRuntime, 'composition'>
interface ExtensionFacade { readonly plugins: PluginRuntimeService; readonly skills: RuntimeSkillService; readonly presets: RuntimePresetService }

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
  let mounted: MountedAgentRuntime | undefined
  let sessions: LocalSessionsApi | undefined
  let checkpoints: FileCheckpointService | undefined
  let fsMutationAuthority: ReturnType<typeof createFsMutationAuthority> | undefined
  let extensionFacade: ExtensionFacade | undefined
  let compositionSnapshot: RuntimeCompositionSnapshot | undefined
  const profileId = options.profile ?? 'desktop-default'
  const profileExtras = createOptionalCapabilityEntries(options)
  const profile = createBuiltinRuntimeProfile(
    profileId,
    (ctx) => {
      const provider = new LocalSessionsApi({ home: services.home })
      sessions = provider
      checkpoints = createLocalFileCheckpointService({ home: services.home })
      const unregister = ctx.set('sessions', provider)
      return async () => {
        unregister()
        await provider.close()
        if (ownsServices) services.dispose()
      }
    },
    async (ctx) => {
      if (sessions === undefined) throw new Error('内部组合未能挂载 sessions-local')
      const mountedExecution = mountExecutionBundle(options, services, sessions, ctx)
      fsMutationAuthority = mountedExecution.fsMutationAuthority
      return mountedExecution.dispose
    },
    (ctx) => {
      if (sessions === undefined) throw new Error('内部组合未能挂载 sessions-local')
      return mountToolingBundle(options, sessions, ctx)
    },
    (ctx) => registerModelRouter({ ctx, routing: options.modelRouting ?? createModelRouter() }),
    (ctx) => {
      if (sessions === undefined || fsMutationAuthority === undefined) throw new Error('内部组合缺少 policy provider 依赖')
      return mountPolicyBundle(options, services, sessions, fsMutationAuthority, ctx, () => compositionSnapshot ?? { profile: profileId, entries: [] })
    },
    (ctx) => {
      if (sessions === undefined) throw new Error('内部组合缺少 sessions provider')
      const mountedExtensions = mountExtensionsBundle(options, services, sessions, ctx)
      extensionFacade = mountedExtensions.facade
      return mountedExtensions.dispose
    },
    (ctx) => mountCodeRuntimeBundle(options, ctx),
    (ctx) => {
      if (sessions === undefined || checkpoints === undefined) throw new Error('内部组合缺少 agent provider 依赖')
      return mountAgentBundle(options, sessions, checkpoints, ctx)
    },
    async () => {
      if (sessions === undefined || checkpoints === undefined || extensionFacade === undefined) throw new Error('内部组合缺少 extension provider')
      mounted = await mountDesktopSpine(options, services, sessions, checkpoints, extensionFacade)
      return async () => { await mounted?.dispose() }
    },
    profileExtras,
  )
  const composition = await composeRuntimeProfile(services.ctx, profile)
  compositionSnapshot = composition.snapshot
  if (mounted === undefined) throw new Error('内部组合未能挂载 lcode-spine')
  return {
    ...mounted,
    composition: composition.snapshot,
    dispose: async () => { await composition.dispose() },
  }
}

function mountToolingBundle(options: AgentRuntimeOptions, sessions: LocalSessionsApi, ctx: DesktopServices['ctx']): Disposer {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const tools = new InMemoryToolRegistry(ctx)
  const unregisterTools = ctx.set('tools', tools)
  const systemPrompt = createSystemPromptService(tools)
  systemPrompt.section('base', BASE_SYSTEM_PROMPT)
  /*
   * `agents.inject` 的内容经 `injected_*` 变量到达装配点。变量本身不会自动出现在
   * 提示词里——没有这一段，"注入"就是静默丢失。只在真有内容时追加，正常轮次
   * 的系统提示与指纹保持原样。
   */
  systemPrompt.context('host-injected', (assembleCtx) => {
    const notes = Object.entries(assembleCtx.variables)
      .filter(([name]) => name.startsWith('injected_'))
      .map(([, content]) => content.trim())
      .filter((content) => content !== '')
    return notes.length === 0 ? '' : `## 本轮补充上下文\n\n${notes.join('\n\n')}`
  })
  const unregisterPrompt = ctx.set('systemPrompt', systemPrompt)
  const workspaceOf = (sessionId: string) => sessions.workspaceOf(sessionId)
  for (const tool of createFsTools({ fs: ctx.get('fs'), workspaceRoot, workspaceOf, spill: ctx.get('spill') })) tools.register(tool)
  const unregisterShell = tools.register(createShellTool({ shell: ctx.get('shell'), workspaceRoot, workspaceOf }))
  const unregisterTerminal = tools.register(createTerminalTool({ terminals: ctx.get('terminals'), workspaceRoot, workspaceOf }))
  return () => { unregisterTerminal(); unregisterShell(); unregisterPrompt(); unregisterTools() }
}

function mountPolicyBundle(options: AgentRuntimeOptions, services: DesktopServices, sessions: LocalSessionsApi, mutationAuthority: ReturnType<typeof createFsMutationAuthority>, ctx: DesktopServices['ctx'], profile: () => RuntimeCompositionSnapshot): Disposer {
  const permissionPresets = createLocalPermissionPresets({ home: services.home })
  const unregisterPresets = ctx.set('permissionPresets', permissionPresets)
  const workspaceTrust = createLocalWorkspaceTrust({ home: services.home })
  const unregisterTrust = ctx.set('workspaceTrust', workspaceTrust)
  const subagentProvider = registerInprocessSubagents({ ctx, sessions, workspaceOf: (id) => sessions.workspaceOf(id), profile })
  const unregisterSubagentTool = ctx.get('tools').register(createSubagentTool(ctx))
  const uninstallPolicy = installPolicyHook({ ctx, ...(options.approval === undefined ? {} : { approval: options.approval }), sandbox: ctx.get('sandbox'), presets: permissionPresets, workspaceTrust, mutationAuthority, workspaceOf: (id) => sessions.workspaceOf(id), getSession: (id) => { try { return sessions.sessionServiceFor(id) } catch { return undefined } } })
  const planMode = createPlanModeService({ ctx, getSession: (id) => sessions.sessionServiceFor(id), systemPrompt: ctx.get('systemPrompt'), tools: ctx.get('tools'), ...(options.approval === undefined ? {} : { approval: options.approval }) })
  const unregisterPlan = ctx.set('planMode', planMode)
  return () => { planMode.dispose(); unregisterPlan(); uninstallPolicy(); unregisterSubagentTool(); subagentProvider.dispose(); unregisterTrust(); unregisterPresets() }
}

/**
 * Web 与 LSP 只能由已配置的可信 Provider 显式加入 Profile。默认 desktop/cli
 * 组合保持离线，也不会为了“可用”而暗中启动语言服务进程。
 */
function createOptionalCapabilityEntries(options: AgentRuntimeOptions): readonly InternalBundleEntry[] {
  const entries: InternalBundleEntry[] = []
  if (options.web !== undefined) {
    const web = options.web
    entries.push({
      id: 'web-provider',
      requires: ['tools'],
      provides: ['web'],
      mount: (ctx) => {
        const unregisterWeb = ctx.set('web', web)
        const unregisterTools = createWebTools(web).map((tool) => ctx.get('tools').register(tool))
        return () => {
          for (const unregister of unregisterTools.reverse()) unregister()
          unregisterWeb()
        }
      },
    })
  }
  if (options.lsp !== undefined) {
    const lsp = options.lsp
    entries.push({
      id: 'lsp-provider',
      requires: ['tools', 'subprocess', 'sandbox'],
      provides: ['lsp'],
      mount: (ctx) => {
        const unregisterLsp = ctx.set('lsp', lsp)
        const unregisterTools = createLspTools(lsp).map((tool) => ctx.get('tools').register(tool))
        return () => {
          for (const unregister of unregisterTools.reverse()) unregister()
          unregisterLsp()
        }
      },
    })
  }
  return entries
}

function mountExtensionsBundle(
  options: AgentRuntimeOptions,
  services: DesktopServices,
  sessions: LocalSessionsApi,
  ctx: DesktopServices['ctx'],
): { readonly facade: ExtensionFacade; readonly dispose: Disposer } {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  // Skills 与 preset 都是本地只读声明；启用后的插件生命周期则始终走受控 utility host。
  const skills = createLocalSkillFilesystem({
    roots: [
      { path: join(services.home, 'skills'), source: 'user' },
      { path: join(workspaceRoot, '.lcode', 'skills'), source: 'workspace' },
    ],
  })
  const unregisterSkills = ctx.set('skills', skills)
  const unregisterSkillTools = registerSkillTools(skills, ctx.get('tools'))
  const localPresets = createLocalAgentPresets({
    roots: [
      { path: join(services.home, 'presets'), source: 'user' },
      { path: join(workspaceRoot, '.lcode', 'presets'), source: 'workspace' },
    ],
  })
  const unregisterPresets = ctx.set('presets', localPresets)
  const registry = new LocalPluginRegistry({ home: services.home, coreVersion: '0.1.0' })
  const lifecycle = new PluginLifecycleManager({
    context: ctx,
    tools: ctx.get('tools'),
    systemPrompt: ctx.get('systemPrompt'),
    startHost: async ({ target, onRequest }) => await createPluginHost({
      manifest: target.manifest,
      argv: [process.execPath, pluginUtilityRunnerPath, target.entryPath],
      cwd: workspaceRoot,
      workspace: { root: workspaceRoot, trusted: ctx.get('workspaceTrust').isTrusted(workspaceRoot) },
      subprocess: ctx.get('subprocess'),
      sandbox: {
        policy: { mode: 'read-only', workspaceRoot, allowNetwork: false },
        wrap: async (argv) => await ctx.get('sandbox').wrap(argv, { mode: 'read-only', workspaceRoot, allowNetwork: false }),
      },
      onRequest,
    }),
  })
  const lifecycleService = new InstalledPluginLifecycleService(lifecycle, registry)
  const unregisterPlugins = ctx.set('plugins', lifecycleService)
  const facade: ExtensionFacade = {
    plugins: {
      list: () => registry.list(),
      installLocal: async (path) => await registry.install({ source: { kind: 'local', path } }),
      async activate(input) { await lifecycleService.activate(input) },
      async deactivate(input) { await lifecycleService.deactivate(input) },
      async uninstall(input) { await lifecycleService.uninstall(input) },
      inspect: () => lifecycleService.inspect(),
    },
    skills: { catalog: () => skills.catalog(), load: (id) => skills.load(id) },
    presets: {
      list: () => localPresets.list(),
      load: (id) => localPresets.load(id),
      snapshot: async ({ sessionId, ids }) => {
        const snapshot = await localPresets.snapshot(sessionId, ids)
        sessions.sessionServiceFor(sessionId).append({ type: 'preset/snapshot', data: snapshot })
        return snapshot
      },
    },
  }
  for (const plugin of registry.list().filter((entry) => entry.state === 'enabled')) {
    void lifecycleService.activate(plugin).catch((error: unknown) => {
      console.warn(`[lcode] 插件 ${plugin.id}@${plugin.version} 未能恢复：`, error)
    })
  }
  return {
    facade,
    dispose: async () => {
      unregisterSkillTools()
      await lifecycle.dispose()
      unregisterPlugins()
      unregisterPresets()
      unregisterSkills()
    },
  }
}

function mountCodeRuntimeBundle(options: AgentRuntimeOptions, ctx: DesktopServices['ctx']): Disposer {
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const runtime = options.codeRuntime ?? createSubprocessCodeRuntime({
    subprocess: ctx.get('subprocess'),
    sandbox: ctx.get('sandbox'),
    workspaceRoot,
  })
  const unregisterRuntime = ctx.set('codeRuntime', runtime)
  const unregisterTool = ctx.get('tools').register(createCodeTool({ runtime, tools: ctx.get('tools') }))
  return () => {
    unregisterTool()
    unregisterRuntime()
  }
}

function mountExecutionBundle(options: AgentRuntimeOptions, services: DesktopServices, _sessions: LocalSessionsApi, ctx: DesktopServices['ctx']): { readonly fsMutationAuthority: ReturnType<typeof createFsMutationAuthority>; readonly dispose: Disposer } {
  const unregister: Disposer[] = []
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const subprocess = createLocalSubprocess()
  unregister.push(ctx.set('subprocess', subprocess))
  const sandbox = options.sandbox ?? defaultSandbox(subprocess, workspaceRoot)
  unregister.push(ctx.set('sandbox', sandbox))
  const fsMutationAuthority = createFsMutationAuthority()
  unregister.push(ctx.set('fs', createLocalFs({ workspaceRoot, mutationAuthority: fsMutationAuthority })))
  unregister.push(registerCompactionPrune({ ctx }))
  unregister.push(registerLocalSpill({ ctx, home: services.home }))
  const jobs = createLocalJobs()
  unregister.push(ctx.set('jobs', jobs))
  const { shell } = createLocalShell({ workspaceRoot, subprocess, wrap: (argv, policy) => sandbox.wrap(argv, policy), jobs })
  unregister.push(ctx.set('shell', shell))
  const terminals = createLocalTerminal({ workspaceRoot, subprocess, sandbox })
  unregister.push(ctx.set('terminals', terminals))
  return { fsMutationAuthority, dispose: async () => { await jobs.dispose(); await terminals.dispose(); for (const dispose of unregister.reverse()) dispose() } }
}

/** `agent-local` 只装配内置 agent 协作服务；具体实现仍归各能力包所有。 */
function mountAgentBundle(
  options: AgentRuntimeOptions,
  sessions: LocalSessionsApi,
  checkpoints: FileCheckpointService,
  ctx: DesktopServices['ctx'],
): Disposer {
  const unregisterServices: Disposer[] = []
  const getSession = (sessionId: string): SessionService => sessions.sessionServiceFor(sessionId)
  const systemPrompt = ctx.get('systemPrompt')
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const jobs = ctx.get('jobs')
  const terminals = ctx.get('terminals')

  // 检查点只在 `turn/end` 已写入后串行生成。agent-loop 不依赖具体快照实现，
  // 通过此协作点保持“一切皆插件”的装配方向。
  const uninstallCheckpoints = ctx.on('agent/turn-ended', async (payload) => {
    const workspace = sessions.workspaceOf(payload.sessionId)
    if (workspace === undefined) return
    const checkpoint = await checkpoints.capture({
      sessionId: payload.sessionId,
      workspaceRoot: workspace,
      session: payload.session,
      turn: payload.turn,
      endSeq: payload.endSeq,
    })
    payload.session.append({
      type: 'checkpoint/created',
      data: {
        checkpointId: checkpoint.checkpointId,
        turn: checkpoint.turn,
        endSeq: checkpoint.endSeq,
        files: checkpoint.files.length,
        partial: checkpoint.partial,
        ...(checkpoint.skipped.length === 0 ? {} : { skipped: checkpoint.skipped }),
      },
    })
  })

  // ④ 循环（唯一的具体循环）
  const loop = createAgentLoop({ ctx, getSession })
  unregisterServices.push(ctx.set('agentLoop', loop))

  // ⑤ 活体 agent 注册表（依赖 ctx 与 getSession）
  unregisterServices.push(ctx.set('agents', new InMemoryAgentStore(ctx, getSession)))
  const unregisterContextSources = registerLocalContextSources({ ctx, workspaceRoot, systemPrompt, sessions })
  const unregisterContextBudget = registerContextBudget({ ctx })
  const compaction = createLocalCompactionSummary()
  unregisterServices.push(ctx.set('compaction', compaction))
  // 发布中的后台作业归属到 agent。对话回合取消不碰它；只有 agent 被销毁时才清理。
  const uninstallJobOwnerCleanup = ctx.on('agent/disposed', async ({ agentId }) => {
    await jobs.disposeOwner(agentId)
    await terminals.disposeOwner(agentId)
  })
  return () => {
    uninstallJobOwnerCleanup()
    unregisterContextBudget()
    unregisterContextSources()
    uninstallCheckpoints()
    for (const unregister of unregisterServices.reverse()) unregister()
  }
}

/** `lcode-spine` 只将已装配的服务投影为桌面/CLI 共用的产品门面。 */
async function mountDesktopSpine(
  options: AgentRuntimeOptions,
  services: DesktopServices,
  sessions: LocalSessionsApi,
  checkpoints: FileCheckpointService,
  extensions: ExtensionFacade,
): Promise<MountedAgentRuntime> {
  const { ctx } = services
  const getSession = (sessionId: string): SessionService => sessions.sessionServiceFor(sessionId)
  // ⑥ 边界层：`agents.*`（对话入口）
  const agents = new LocalAgentsApi({ ctx, getSession })

  return {
    services,
    sessions,
    agents,
    loop: ctx.get('agentLoop') as AgentLoopRuntime,
    ctx,
    checkpoints,
    plugins: extensions.plugins,
    skills: extensions.skills,
    presets: extensions.presets,
    compaction: ctx.get('compaction') as CompactionService,
    async contextUsage({ sessionId }) {
      const session = getSession(sessionId)
      // 与真正发请求时同一套装配：估算 system / tools 不能各算各的
      const assembled = await ctx.get('systemPrompt').assemble({ sessionId })
      const measurement = ctx.get('contextBudget').measure({
        session,
        system: assembled.system,
        tools: assembled.tools,
      })
      const contextWindowTokens = activeContextWindow(services) ?? null
      const usedTokens = measurement.providerTotal ?? measurement.total
      const usageSource = measurement.providerTotal === undefined
        ? 'estimate'
        : (measurement.providerDeltaTokens ?? 0) > 0
          ? 'mixed'
          : 'provider'
      const percent = contextWindowTokens === null
        ? null
        : Math.min(100, Math.round((usedTokens / contextWindowTokens) * 1000) / 10)
      return { contextWindowTokens, usedTokens, percent, usageSource, measurement }
    },
    async compactSession({ sessionId }) {
      const session = getSession(sessionId)
      const boundary = [...session.events()].reverse().find((event) => event.type === 'turn/start' || event.type === 'turn/end')
      if (boundary?.type === 'turn/start') throw new Error('这一轮还在执行，先暂停再压缩上下文')
      // 只在用户显式点击时调用摘要器；没有任何自动触发路径
      const summarize = options.compactionSummarizer ?? createModelCompactionSummarizer({ ctx })
      const summary = await summarize({ sessionId, session })
      return ctx.get('compaction').compact({ session, summary, trigger: 'manual' })
    },
    subagents: ctx.get('subagents') as InprocessSubagentService,
    watchSession(sessionId, handler) {
      // `sessionServiceFor` 会校验"会话已打开"并抛 ES-SESSION_NOT_FOUND——
      // 那正是我们要的行为：未开放的会话没有内存镜像，也没有事件可订阅。
      return sessions.sessionServiceFor(sessionId).onEvent(handler)
    },
    async dispose() {},
  }
}

function activeContextWindow(services: DesktopServices): number | undefined {
  const selection = services.ctx.get('agentDefaultModel').get()
  if (selection === undefined) return undefined
  const providers = services.readSetting('model.providers')
  const config = Array.isArray(providers)
    ? providers.find((candidate) => typeof candidate === 'object' && candidate !== null && (candidate as { name?: unknown }).name === selection.provider) as { context_window_in?: unknown; context_window_max?: unknown } | undefined
    : undefined
  if (typeof config?.context_window_in === 'number' && config.context_window_in > 0) return config.context_window_in
  // 用户没显式配置时用供应商返回的模型上限（保存时探测并缓存）
  if (typeof config?.context_window_max === 'number' && config.context_window_max > 0) return config.context_window_max
  // 供应商也没给：保守回落，设置页会明确标注
  return FALLBACK_CONTEXT_WINDOW
}

function defaultSandbox(subprocess: ReturnType<typeof createLocalSubprocess>, workspaceRoot: string): SandboxService {
  if (process.platform === 'win32') return createWindowsSandbox({ bridge: createWindowsSandboxBridge({ subprocess, workspaceRoot }) })
  if (process.platform === 'darwin') return createMacosSandbox()
  if (process.platform === 'linux') return createLinuxSandbox()
  // 未知平台也必须保守降级；Linux/macOS 不能被未知平台的实现假冒。
  return {
    async status() {
      return {
        available: false,
        mechanism: 'none',
        knownEscapeSurfaces: ['文件系统（无约束）', '网络（无约束）', '进程（无约束）'],
        degraded: true,
        reason: `当前平台（${process.platform}）没有可用的原生沙箱 Provider。`,
        capabilities: {
          platform: process.platform,
          mechanism: 'none',
          boundaries: {
            filesystem: { state: 'unavailable', plannedMechanism: 'none', message: '未知平台没有文件系统沙箱' },
            network: { state: 'unavailable', plannedMechanism: 'none', message: '未知平台没有网络沙箱' },
            spawn: { state: 'unavailable', plannedMechanism: 'none', message: '未知平台没有进程沙箱' },
          },
          reason: `当前平台（${process.platform}）没有可用的原生沙箱 Provider。`,
        },
      }
    },
    async wrap(argv) { return { enforced: false, wrappedArgv: [...argv], degradationReason: `当前平台（${process.platform}）没有可用的原生沙箱 Provider。` } },
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
  '是否需要询问由当前权限预设和实际沙箱状态共同决定。当前没有系统级沙箱约束时，',
  '任何改写文件或执行命令都会把“沙箱降级”作为影响面向用户询问；不询问的预设会拒绝这些操作。',
  '改动工作区之外的文件、跑项目里没出现过的命令、读取疑似凭据的文件（.env / id_rsa / .ssh 等）',
  '也会**先询问用户**。',
  '如果某个操作被拒绝，那不是 bug —— 那是用户或策略的决定。',
  '不要试图绕过它（比如换一条等价命令），把情况如实告诉用户。',
  '',
  '## 边界',
  '',
  '- 不要编造文件内容、命令输出或测试结果。没读过就说没读过。',
  '- 不确定的事要说不确定。',
].join('\n')
