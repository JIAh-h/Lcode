/**
 * 内置 Agent 预设：**声明**每个模式包含哪些会话插件。
 *
 * 只读、可审计：会话插件是否启用由这里的数据决定，不在 UI 里开关。
 * 新增内置工具时，同时把它的插件 id 加进对应预设；未声明的工具只在
 * 标准模式下视为可用（运行时动态注册的工具不进更窄的预设）。
 *
 * 目前两档：
 * - 标准：日常编程所需的读写、搜索、命令、终端、子代理与技能；
 * - 创造：在标准能力上增加 `run_code`，用于批量调用工具、编写/组合技能与插件源码。
 *
 * 权限（只读 / 工作区内修改 / 完全访问）是独立的一条轴，不在这里声明。
 */
export interface BuiltinAgentPreset {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 该预设包含的会话插件 id（见 builtin-plugins.ts 的 SESSION_PLUGINS） */
  readonly plugins: readonly string[]
}

const STANDARD_PLUGINS = [
  'persona',
  'agent-instructions',
  'time-context',
  'tool-fs-read',
  'tool-fs-write',
  'tool-fs-search',
  'tool-shell',
  'tool-terminal',
  'tool-subagent',
  'tool-skill',
  'tool-web',
] as const

export const BUILTIN_AGENT_PRESETS: readonly BuiltinAgentPreset[] = [
  {
    id: 'standard',
    name: '标准模式（默认）',
    description: '读写与命令工具全开，按当前权限预设执行。',
    plugins: [...STANDARD_PLUGINS],
  },
  {
    id: 'creator',
    name: '创造模式',
    description: '在标准能力上增加代码运行器，便于编写/组合工具、技能与插件源码。',
    plugins: [...STANDARD_PLUGINS, 'tool-code'],
  },
]
