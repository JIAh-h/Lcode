import type { SkillService } from '@lcode/skill'
import type { ToolDefinition, ToolRegistry } from '@lcode/tools'
import type { Disposer } from '@lcode/util'

/** Read-only skill tools. Optional skill scripts remain ordinary policy-guarded shell work. */
export function registerSkillTools(skills: SkillService, tools: ToolRegistry): Disposer {
  const list: ToolDefinition<Record<string, never>, readonly { id: string; name: string; description: string; source: string }[]> = { name: 'skill_list', description: '列出可按需加载的技能名称、描述和来源。', card: 'read', inputSchema: { type: 'object', properties: {} }, execute: async () => await skills.catalog() }
  const load: ToolDefinition<{ id: string }, { instructions: string; path: string } | { found: false }> = { name: 'skill_load', description: '按技能 ID 读取 SKILL.md 正文；不会执行其中的脚本。', card: 'read', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '技能 ID' } }, required: ['id'] }, execute: async (call) => (await skills.load(call.parsed.id)) ?? { found: false } }
  const removeList = tools.register(list); const removeLoad = tools.register(load)
  return () => { removeLoad(); removeList() }
}
