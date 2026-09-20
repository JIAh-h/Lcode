import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalPermissionPresets } from './permission-presets.ts'

let home = ''

afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('LocalPermissionPresets', () => {
  it('默认值可解释，用户切换原子落盘并在重启后保留审计', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-permissions-'))
    const service = createLocalPermissionPresets({ home, now: () => 456 })
    expect(service.snapshot()).toEqual({ preset: '标准', source: 'default' })

    await service.set('只读')
    expect(service.snapshot()).toEqual({ preset: '只读', source: 'user', changedAt: 456 })
    expect(service.audit()).toEqual([{ from: '标准', to: '只读', changedAt: 456 }])
    expect(readFileSync(join(home, 'permission-preset.json'), 'utf8')).not.toContain('api_key')

    const reopened = createLocalPermissionPresets({ home })
    expect(reopened.snapshot()).toEqual({ preset: '只读', source: 'user', changedAt: 456 })
    expect(reopened.audit()).toEqual([{ from: '标准', to: '只读', changedAt: 456 }])
  })
})
