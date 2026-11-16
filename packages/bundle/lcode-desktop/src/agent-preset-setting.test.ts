import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAgentPresetSetting, registerSessionPresets } from './agent-preset-setting.ts'

let home = ''
afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('LocalAgentPresetSetting', () => {
  it('默认标准模式；重复选择保持默认且不写盘', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-agent-preset-'))
    const service = createLocalAgentPresetSetting({ home, now: () => 123 })
    expect(service.snapshot()).toEqual({ preset: 'standard', source: 'default' })
    expect(await service.set('standard')).toMatchObject({ preset: 'standard', source: 'default' })
    expect(createLocalAgentPresetSetting({ home }).get()).toBe('standard')
  })

  /*
   * 创造模式已开放（docs/30 §6）：它需要的"怎么造插件"规范由 `lcode-plugin-creator`
   * 技能承载，`run_code` 也一直在 desktop-default profile 里。之前只是被白名单挡住。
   */
  it('创造模式可选，且切换后落盘', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-agent-preset-'))
    const service = createLocalAgentPresetSetting({ home })
    await expect(service.set('creator')).resolves.toMatchObject({ preset: 'creator', source: 'user' })
    expect(service.get()).toBe('creator')
    // 新实例从盘上读回同样的值，而不是每次都回落到默认
    expect(createLocalAgentPresetSetting({ home }).get()).toBe('creator')
  })

  it('损坏或未知的落盘值回落到标准模式', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-agent-preset-'))
    writeFileSync(join(home, 'agent-preset.json'), JSON.stringify({ version: 1, preset: 'nonsense', changedAt: 1 }), 'utf8')
    expect(createLocalAgentPresetSetting({ home }).snapshot()).toEqual({ preset: 'standard', source: 'default' })
    writeFileSync(join(home, 'agent-preset.json'), '{坏', 'utf8')
    expect(createLocalAgentPresetSetting({ home }).get()).toBe('standard')
  })

  it('切换会通知订阅者', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-agent-preset-'))
    const service = createLocalAgentPresetSetting({ home })
    const seen: string[] = []
    const off = service.watch((preset) => seen.push(preset))
    await service.set('standard')
    expect(seen).toEqual([])
    off()
  })
})

/*
 * 会话级预设（docs/30 §6）。
 *
 * 语义分工：设置页那个是"新会话默认值"（可改），会话事件这个是"**这个**会话用哪套工具"（不可变）。
 * 分开的理由是模式决定工具集——中途切换会让同一会话里 run_code 时有时无，
 * 模型看到工具消失会反复重试。
 */
describe('SessionPresets', () => {
  function fakeSessions(): {
    readonly getSession: (id: string) => { events(): unknown[]; append(e: unknown): void }
    readonly eventsOf: (id: string) => unknown[]
  } {
    const store = new Map<string, unknown[]>()
    for (const id of ['s1', 's2']) store.set(id, [])
    return {
      getSession(id) {
        const list = store.get(id)
        if (list === undefined) throw new Error('会话不存在')
        return {
          events: () => list,
          append: (event: unknown) => {
            list.push(event)
          },
        }
      },
      eventsOf: (id) => store.get(id) ?? [],
    }
  }

  it('没有记录时按 standard（老会话在引入事件之前就存在）', () => {
    const sessions = fakeSessions()
    const { service } = registerSessionPresets({
      ctx: { get: () => ({ tools: () => () => {}, context: () => () => {} }) } as never,
      getSession: sessions.getSession as never,
    })
    expect(service.presetOf('s1')).toBe('standard')
  })

  it('写入后读回同一个值', () => {
    const sessions = fakeSessions()
    const { service } = registerSessionPresets({
      ctx: { get: () => ({ tools: () => () => {}, context: () => () => {} }) } as never,
      getSession: sessions.getSession as never,
    })
    service.setPreset('s1', 'creator', 'user')
    expect(service.presetOf('s1')).toBe('creator')
  })

  it('**不可变**：重复写入被忽略，不会出现两条互相矛盾的预设', () => {
    const sessions = fakeSessions()
    const { service } = registerSessionPresets({
      ctx: { get: () => ({ tools: () => () => {}, context: () => () => {} }) } as never,
      getSession: sessions.getSession as never,
    })
    service.setPreset('s1', 'creator', 'user')
    service.setPreset('s1', 'standard', 'user')
    expect(service.presetOf('s1')).toBe('creator')
    expect(sessions.eventsOf('s1')).toHaveLength(1)
  })

  it('会话之间互不影响', () => {
    const sessions = fakeSessions()
    const { service } = registerSessionPresets({
      ctx: { get: () => ({ tools: () => () => {}, context: () => () => {} }) } as never,
      getSession: sessions.getSession as never,
    })
    service.setPreset('s1', 'creator', 'user')
    service.setPreset('s2', 'standard', 'default')
    expect(service.presetOf('s1')).toBe('creator')
    expect(service.presetOf('s2')).toBe('standard')
  })
})
