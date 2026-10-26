import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAgentPresetSetting } from './agent-preset-setting.ts'

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

  it('创造模式尚未开放：拒绝设置，也不会写盘', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-agent-preset-'))
    const service = createLocalAgentPresetSetting({ home })
    await expect(service.set('creator')).rejects.toThrow('尚未开放')
    expect(service.get()).toBe('standard')
  })

  it('损坏或未知的落盘值回落到标准模式', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-agent-preset-'))
    writeFileSync(join(home, 'agent-preset.json'), JSON.stringify({ version: 1, preset: 'creator', changedAt: 1 }), 'utf8')
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
