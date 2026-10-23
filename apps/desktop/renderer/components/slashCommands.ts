export interface SlashCommandDef {
  readonly name: string
  /** 参数提示（不含命令名），没有参数则为空串 */
  readonly args: string
  /** 原始文案 key，渲染时再过 t()，避免模块加载时锁死语言 */
  readonly description: string
  /** 只有打开会话后才能用 */
  readonly sessionOnly: boolean
}

/** 第一批通用命令：全部映射到已有的本地能力，不新增模型协议。 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: 'help', args: '', description: '查看所有斜杠命令', sessionOnly: false },
  { name: 'model', args: '[模型名]', description: '切换默认模型（只影响下一轮）', sessionOnly: false },
  { name: 'compact', args: '', description: '预览并压缩较早的上下文', sessionOnly: true },
  { name: 'context', args: '', description: '查看当前上下文用量与来源', sessionOnly: true },
  { name: 'new', args: '', description: '开始一个新对话', sessionOnly: false },
  { name: 'plan', args: '', description: '切换计划模式（先探索再执行）', sessionOnly: true },
  { name: 'skills', args: '', description: '打开技能选择面板', sessionOnly: false },
  { name: 'settings', args: '', description: '打开设置', sessionOnly: false },
  { name: 'export', args: '', description: '导出当前会话包', sessionOnly: true },
  { name: 'retry', args: '', description: '重试最后一轮（无工具副作用时）', sessionOnly: true },
]

/**
 * 只在输入**第一行**是斜杠命令形状时返回解析结果。
 * 不允许名字里再出现 `/`，避免把 `/usr/bin` 这类路径误当命令。
 */
export function parseSlashInput(value: string): { readonly name: string; readonly args: string } | null {
  if (!value.startsWith('/') || value.includes('\n')) return null
  const match = /^\/([a-zA-Z-]*)(?:\s+(.*))?$/.exec(value)
  if (match === null) return null
  return { name: (match[1] ?? '').toLowerCase(), args: match[2] ?? '' }
}

/** 命令名前缀匹配；用户已经输入完整命令并带参数时只保留该命令。 */
export function matchSlashCommands(name: string, args: string): readonly SlashCommandDef[] {
  if (name === '') return SLASH_COMMANDS
  const exact = SLASH_COMMANDS.find((command) => command.name === name)
  if (exact !== undefined && args !== '') return [exact]
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(name))
}
