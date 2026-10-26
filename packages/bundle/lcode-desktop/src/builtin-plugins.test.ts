import { describe, expect, it } from 'vitest'
import { buildBuiltinPluginCatalog } from './builtin-plugins.ts'
import { BUILTIN_AGENT_PRESETS } from './builtin-presets.ts'

const composition = {
  profile: 'desktop-default',
  entries: [
    { id: 'sessions-local', provides: ['sessions'], adopts: [], requires: [] },
    { id: 'tooling-local', provides: ['tools', 'systemPrompt'], adopts: [], requires: ['sessions'] },
    { id: 'custom-provider', provides: ['custom'], adopts: [], requires: [] },
  ],
}

const tools = [
  { name: 'read', description: 'Read a file' },
  { name: 'write', description: 'Write a file' },
  { name: 'edit', description: 'Edit a file' },
  { name: 'glob', description: 'Glob files' },
  { name: 'grep', description: 'Grep files' },
  { name: 'shell', description: 'Run a shell command' },
  { name: 'submit_plan', description: 'Submit a plan' },
  { name: 'request_plan_change', description: 'Request a plan change' },
  { name: 'run_code', description: 'Run JavaScript in the code runtime' },
  { name: 'demo/thirdparty', description: 'Third-party plugin tool\nsecond line' },
]

describe('buildBuiltinPluginCatalog', () => {
  const catalog = buildBuiltinPluginCatalog({ composition, tools, platform: 'win32' })
  const byId = (id: string) => catalog.plugins.find((plugin) => plugin.id === id)

  it('全局插件来自组合快照，未知条目保留原始 id', () => {
    const globals = catalog.plugins.filter((plugin) => plugin.group === 'global')
    expect(globals.map((plugin) => plugin.id)).toEqual(['sessions-local', 'tooling-local', 'custom-provider'])
    expect(byId('tooling-local')).toMatchObject({
      name: '工具系统',
      source: '内置内核',
      provides: ['tools', 'systemPrompt'],
      requires: ['sessions'],
      modes: { standard: { configured: true, running: true }, creator: { configured: true, running: true } },
    })
    expect(byId('custom-provider')).toMatchObject({ name: 'custom-provider', description: '内置运行时组合条目。' })
  })

  it('常驻会话能力在两档预设里都运行；计划工具不属于任何预设', () => {
    expect(byId('persona')?.modes).toEqual({
      standard: { configured: true, running: true },
      creator: { configured: true, running: true },
    })
    expect(byId('plan-guard')?.modes).toEqual({
      standard: { configured: false, running: false },
      creator: { configured: false, running: false },
    })
    expect(byId('plan-tools')?.modes).toEqual({
      standard: { configured: false, running: false },
      creator: { configured: false, running: false },
    })
  })

  it('标准与创造：写工具都在；run_code 只在创造模式', () => {
    expect(byId('tool-fs-read')?.modes).toEqual({
      standard: { configured: true, running: true },
      creator: { configured: true, running: true },
    })
    expect(byId('tool-fs-write')?.modes).toEqual({
      standard: { configured: true, running: true },
      creator: { configured: true, running: true },
    })
    expect(byId('tool-code')).toMatchObject({
      name: '代码运行工具',
      modes: {
        standard: { configured: false, running: false },
        creator: { configured: true, running: true },
      },
    })
  })

  it('未注册声明的插件不出现；未知工具以只读状态兜底', () => {
    expect(byId('tool-skill')).toBeUndefined()
    expect(byId('tool-terminal')).toBeUndefined()
    expect(byId('tool-demo/thirdparty')).toMatchObject({
      name: '工具 demo/thirdparty',
      description: 'Third-party plugin tool',
      fullName: '运行时注册',
      modes: {
        standard: { configured: true, running: true },
        creator: { configured: false, running: false },
      },
    })
  })

  it('Windows 上 Shell 插件显示为 PowerShell', () => {
    expect(byId('tool-shell')?.name).toBe('PowerShell 命令工具')
    const other = buildBuiltinPluginCatalog({ composition, tools, platform: 'darwin' })
    expect(other.plugins.find((plugin) => plugin.id === 'tool-shell')?.name).toBe('Shell 命令工具')
  })

  it('模式列表与来源标签', () => {
    expect(catalog.modes.map((mode) => mode.id)).toEqual(['standard', 'creator'])
    expect(byId('tool-fs-read')?.source).toBe('标准模式、创造模式')
    expect(byId('tool-fs-write')?.source).toBe('标准模式、创造模式')
    expect(byId('tool-code')?.source).toBe('创造模式')
    expect(byId('plan-tools')?.source).toBe('内置')
  })

  it('Agent 预设声明的插件 id 都能在目录里找到', () => {
    const fullTools = ['read', 'write', 'edit', 'glob', 'grep', 'shell', 'terminal', 'delegate', 'skill_list', 'skill_load', 'run_code', 'web_fetch', 'web_search', 'submit_plan', 'request_plan_change']
      .map((name) => ({ name, description: name }))
    const full = buildBuiltinPluginCatalog({ composition, tools: fullTools, platform: 'win32' })
    const ids = new Set(full.plugins.filter((plugin) => plugin.group === 'session').map((plugin) => plugin.id))
    for (const preset of BUILTIN_AGENT_PRESETS) {
      expect(new Set(preset.plugins).size).toBe(preset.plugins.length)
      for (const id of preset.plugins) expect(ids.has(id)).toBe(true)
    }
  })
})
