import type { RuntimeCompositionSnapshot } from '@lcode/runtime-composition'
import { BUILTIN_AGENT_PRESETS } from './builtin-presets.ts'

/**
 * 内置插件目录（只读）。
 *
 * 发行包遵循“一切皆插件”的装配方式，但内置能力的启用/停用写在代码里：
 * - **全局插件** = 运行时组合里实际挂载的 bundle（会话、执行、工具、模型、策略…）；
 * - **会话插件** = 每轮真正进入模型工具清单的能力（工具 + 角色/指令/时间等常驻能力）。
 *   是否属于某个模式，由 `builtin-presets.ts` 的 Agent 预设显式声明。
 *
 * 这里只暴露“叫什么、做什么、是否配置、是否在跑”，不提供任何开关；
 * 状态来自真实组合快照、工具注册表与预设声明，避免 UI 与运行时漂移。
 */

export type BuiltinPluginGroup = 'session' | 'global'
export type BuiltinPluginModeId = string

export interface BuiltinPluginModeState {
  readonly configured: boolean
  readonly running: boolean
}

export interface BuiltinPluginView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly group: BuiltinPluginGroup
  /** 完整名称：内置包名（会话插件）或组合条目 id（全局插件） */
  readonly fullName: string
  /** 来自：哪些预设配置了它；全局插件为「内置内核」 */
  readonly source: string
  readonly provides: readonly string[]
  readonly requires: readonly string[]
  readonly modes: Readonly<Record<BuiltinPluginModeId, BuiltinPluginModeState>>
}

export interface BuiltinPluginMode {
  readonly id: BuiltinPluginModeId
  readonly name: string
  readonly description: string
}

export interface BuiltinPluginCatalog {
  readonly profile: string
  readonly modes: readonly BuiltinPluginMode[]
  readonly plugins: readonly BuiltinPluginView[]
}

const MODES: readonly BuiltinPluginMode[] = BUILTIN_AGENT_PRESETS.map((preset) => ({
  id: preset.id,
  name: preset.name,
  description: preset.description,
}))

interface SessionPluginDef {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly fullName: string
  /** 任一工具注册即视为已挂载；缺省为常驻能力 */
  readonly tools?: readonly string[]
  readonly resident?: boolean
}

const SESSION_PLUGINS: readonly SessionPluginDef[] = [
  {
    id: 'persona',
    name: '智能体角色设定',
    description: '为当前智能体提供组合中定义的角色与行为说明。',
    fullName: '@lcode/system-prompt',
    resident: true,
  },
  {
    id: 'agent-instructions',
    name: '工作区指令加载',
    description: '读取 AGENTS.md、CLAUDE.md 等工作区规则文件，为 AI 提供工作区约定。',
    fullName: '@lcode/system-prompt',
    resident: true,
  },
  {
    id: 'time-context',
    name: '时间与环境感知',
    description: '每一步把当前时间、工作区与运行环境告诉模型。',
    fullName: '@lcode/context-local',
    resident: true,
  },
  {
    id: 'plan-guard',
    name: '只读探索约束',
    description: '计划模式下收窄可见工具与写操作，只允许读取、搜索与提交计划。',
    fullName: '@lcode/plan-mode',
    resident: true,
  },
  {
    id: 'tool-fs-read',
    name: '文件读取工具',
    description: '让 AI 读取工作区文件。',
    fullName: '@lcode/tool-fs',
    tools: ['read'],
  },
  {
    id: 'tool-fs-write',
    name: '文件写入工具',
    description: '让 AI 创建、编辑工作区文件。',
    fullName: '@lcode/tool-fs',
    tools: ['write', 'edit'],
  },
  {
    id: 'tool-fs-search',
    name: '文件搜索工具',
    description: '让 AI 按文件名或文本内容搜索本地文件。',
    fullName: '@lcode/tool-fs',
    tools: ['glob', 'grep'],
  },
  {
    id: 'tool-shell',
    name: 'Shell 命令工具',
    description: '让 AI 执行系统命令，并按权限预设管理前台与后台运行。',
    fullName: '@lcode/tool-shell',
    tools: ['shell'],
  },
  {
    id: 'tool-terminal',
    name: '终端工具',
    description: '为 AI 与用户提供可复用的终端会话。',
    fullName: '@lcode/tool-terminal',
    tools: ['terminal'],
  },
  {
    id: 'tool-subagent',
    name: '子代理工具',
    description: '把独立子任务交给受限的进程内子代理执行。',
    fullName: '@lcode/tool-subagent',
    tools: ['delegate'],
  },
  {
    id: 'tool-skill',
    name: '技能工具',
    description: '列出并按需加载本地技能说明。',
    fullName: '@lcode/tool-skill',
    tools: ['skill_list', 'skill_load'],
  },
  {
    id: 'tool-code',
    name: '代码运行工具',
    description: '在受限代码运行器中执行 JavaScript，用 await tools.<工具名>(参数) 调用当前可见工具。',
    fullName: '@lcode/tool-code',
    tools: ['run_code'],
  },
  {
    id: 'tool-web',
    name: '网页工具',
    description: '读取网页并调用 Tavily 搜索；出站域名按工作区白名单授权，返回内容按不可信数据处理。',
    fullName: '@lcode/tool-web',
    tools: ['web_fetch', 'web_search'],
  },
  {
    id: 'plan-tools',
    name: '计划工具',
    description: '提交结构化计划，并在执行实质偏离时请求用户确认。',
    fullName: '@lcode/plan-mode',
    tools: ['submit_plan', 'request_plan_change'],
  },
]

const GLOBAL_PLUGINS: Readonly<Record<string, { readonly name: string; readonly description: string }>> = {
  'sessions-local': {
    name: '会话与事件日志',
    description: 'JSONL 权威日志、表面投影与分叉；索引只是可重建的投影。',
  },
  'execution-local': {
    name: '本机执行底座',
    description: '子进程、沙箱、文件系统、Shell、终端与压缩剪枝。',
  },
  'tooling-local': {
    name: '工具系统',
    description: '工具注册表、参数校验、权限守卫与系统提示装配。',
  },
  'model-local': {
    name: '模型服务',
    description: '复用宿主已配置的模型与凭据引用，不把密钥带进渲染进程。',
  },
  'model-routing-local': {
    name: '模型路由',
    description: '按会话与轮次选择供应商和模型。',
  },
  'policy-local': {
    name: '权限与策略',
    description: '权限预设、工作区信任、计划模式与子代理。',
  },
  'extensions-local': {
    name: '扩展服务',
    description: '技能目录、Agent 预设与第三方插件宿主。',
  },
  'code-runtime-local': {
    name: '代码运行服务',
    description: '受控代码运行时：提供 run_code 工具，在隔离环境执行并逐项走权限。',
  },
  'agent-local': {
    name: 'Agent 循环',
    description: '请求装配、上下文预算、压缩与工具循环。',
  },
  'lcode-spine': {
    name: '会话编排主干',
    description: '轮次装配、技能注入与宿主补充上下文。',
  },
  'web-provider': {
    name: 'Web 能力',
    description: '显式配置后才加入组合的网页抓取与搜索工具。',
  },
  'lsp-provider': {
    name: 'LSP 能力',
    description: '显式配置后才加入组合的语言服务工具。',
  },
}

const GLOBAL_ORDER = [
  'sessions-local',
  'execution-local',
  'tooling-local',
  'model-local',
  'model-routing-local',
  'policy-local',
  'extensions-local',
  'code-runtime-local',
  'agent-local',
  'lcode-spine',
]

export interface BuiltinPluginCatalogInput {
  readonly composition: RuntimeCompositionSnapshot
  /** 当前工具注册表暴露的工具；用于判断会话插件是否真正挂载 */
  readonly tools: readonly { readonly name: string; readonly description?: string }[]
  readonly platform?: string
}

export function buildBuiltinPluginCatalog(input: BuiltinPluginCatalogInput): BuiltinPluginCatalog {
  const registered = new Map(input.tools.map((tool) => [tool.name, tool]))
  const session: BuiltinPluginView[] = []
  const covered = new Set<string>()

  for (const def of SESSION_PLUGINS) {
    const toolNames = def.tools ?? []
    for (const name of toolNames) covered.add(name)
    const mounted = def.resident === true || (toolNames.length > 0 && toolNames.every((name) => registered.has(name)))
    if (!mounted && toolNames.length > 0) continue
    const name = def.id === 'tool-shell' && input.platform === 'win32' ? 'PowerShell 命令工具' : def.name
    const modes = modesOf((preset) => preset.plugins.includes(def.id))
    session.push({
      id: def.id,
      name,
      description: def.description,
      group: 'session',
      fullName: def.fullName,
      source: sourceOf(modes),
      provides: [],
      requires: [],
      modes: runningModes(modes, mounted),
    })
  }

  /* 第三方插件或宿主新增的工具也要出现在清单里，而不是被静默漏掉 */
  for (const [name, tool] of registered) {
    if (covered.has(name)) continue
    const description = (tool.description ?? '').split('\n')[0]?.slice(0, 140) ?? ''
    // 未声明的动态工具不进更窄的预设；标准模式视为可用
    const modes = modesOf((preset) => preset.id === 'standard')
    session.push({
      id: `tool-${name}`,
      name: `工具 ${name}`,
      description: description === '' ? '运行时注册的工具。' : description,
      group: 'session',
      fullName: '运行时注册',
      source: sourceOf(modes),
      provides: [],
      requires: [],
      modes: runningModes(modes, true),
    })
  }

  const entries = [...input.composition.entries]
  entries.sort((a, b) => orderOf(a.id) - orderOf(b.id))
  const global: BuiltinPluginView[] = entries.map((entry) => {
    const meta = GLOBAL_PLUGINS[entry.id]
    return {
      id: entry.id,
      name: meta?.name ?? entry.id,
      description: meta?.description ?? '内置运行时组合条目。',
      group: 'global',
      fullName: entry.id,
      source: '内置内核',
      provides: [...entry.provides],
      requires: [...entry.requires],
      modes: runningModes(modesOf(() => true), true),
    }
  })

  return {
    profile: input.composition.profile,
    modes: MODES,
    plugins: [...session, ...global],
  }
}

/** 按 Agent 预设声明计算“哪些预设配置了它”。 */
function modesOf(configuredIn: (preset: typeof BUILTIN_AGENT_PRESETS[number]) => boolean): Record<string, BuiltinPluginModeState> {
  const modes: Record<string, BuiltinPluginModeState> = {}
  for (const preset of BUILTIN_AGENT_PRESETS) {
    modes[preset.id] = { configured: configuredIn(preset), running: false }
  }
  return modes
}

function runningModes(modes: Record<string, BuiltinPluginModeState>, mounted: boolean): Record<string, BuiltinPluginModeState> {
  const out: Record<string, BuiltinPluginModeState> = {}
  for (const [id, state] of Object.entries(modes)) {
    out[id] = { configured: state.configured, running: mounted && state.configured }
  }
  return out
}

function orderOf(id: string): number {
  const index = GLOBAL_ORDER.indexOf(id)
  return index < 0 ? GLOBAL_ORDER.length : index
}

function sourceOf(modes: Readonly<Record<string, BuiltinPluginModeState>>): string {
  const labels: string[] = []
  for (const preset of BUILTIN_AGENT_PRESETS) {
    if (modes[preset.id]?.configured === true) labels.push(preset.name.replace('（默认）', ''))
  }
  return labels.length === 0 ? '内置' : labels.join('、')
}
