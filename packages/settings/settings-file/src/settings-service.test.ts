import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSettingsService } from './settings-service.ts'
import type { FieldDescriptor } from './types.ts'

/**
 * T4.2 验收（docs/24 §5 阶段 4 + doc 18 §2）：
 * - 六层优先级 `L1 > L2 > L3 > L4 > L5 > L6`，**逐字段合并**（D-2）
 * - 同 key 在 L2 与 L4 各有一份 → 返回 L2 值且 `source = 'L2'`
 * - L4 以 `settings.json` 为真相（可 grep、可导出），`settings_kv` 是投影
 * - `describe()` / `get()` **永不返回凭据值**（只给 `credentialRef` 引用名）
 */

let home = ''
let service: LocalSettingsService

const MODEL_FIELDS: FieldDescriptor[] = [
  { namespace: 'model', key: 'default.provider', type: 'enum', enumValues: ['deepseek', 'openai'] },
  { namespace: 'model', key: 'default.model', type: 'string', default: 'deepseek-chat' },
  { namespace: 'model', key: 'default.maxTokens', type: 'number', default: 4096 },
  { namespace: 'model', key: 'default.baseUrl', type: 'string' },
  { namespace: 'model', key: 'default.models', type: 'array' },
  {
    namespace: 'model',
    key: 'auth.apiKey',
    type: 'string',
    credentialRef: 'DEEPSEEK_API_KEY',
    sensitive: true,
  },
]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-settings-'))
  service = new LocalSettingsService({ home })
  service.registerNamespace(MODEL_FIELDS)
  service.open()
})

afterEach(() => {
  service.close()
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const settingsFile = (): string => join(home, 'settings.json')

describe('六层优先级（doc 18 §2.1）', () => {
  it('L6：没有更浅的层时回落到 schema 默认值', () => {
    expect(service.get({ namespace: 'model', key: 'default.model' })).toEqual({
      value: 'deepseek-chat',
      source: 'L6',
    })
  })

  it('L5：适配器基座（内存）覆盖 L6', () => {
    service.registerAdapterBase('model', 'default.baseUrl', 'https://api.deepseek.com')
    expect(service.get({ namespace: 'model', key: 'default.baseUrl' })).toEqual({
      value: 'https://api.deepseek.com',
      source: 'L5',
    })
  })

  it('L4：用户设置覆盖 L5', async () => {
    service.registerAdapterBase('model', 'default.baseUrl', 'https://api.deepseek.com')
    await service.update({ namespace: 'model', key: 'default.baseUrl', value: 'http://127.0.0.1:8080/v1' })
    expect(service.get({ namespace: 'model', key: 'default.baseUrl' })).toEqual({
      value: 'http://127.0.0.1:8080/v1',
      source: 'L4',
    })
  })

  it('L3：工作区预设覆盖 L4（只在给了 workspace 时生效）', async () => {
    await service.update({ namespace: 'model', key: 'default.model', value: 'user-model' })
    await service.update({
      namespace: 'model',
      key: 'default.model',
      value: 'workspace-model',
      scope: 'workspace',
      workspace: '/repo/web',
    })
    expect(service.get({ namespace: 'model', key: 'default.model' })).toMatchObject({ value: 'user-model', source: 'L4' })
    expect(service.get({ namespace: 'model', key: 'default.model', workspace: '/repo/web' })).toMatchObject({
      value: 'workspace-model',
      source: 'L3',
    })
    // 另一个工作区不受影响
    expect(service.get({ namespace: 'model', key: 'default.model', workspace: '/repo/other' })).toMatchObject({
      source: 'L4',
    })
  })

  it('**同 key 在 L2 与 L4 各有一份 → 返回 L2 值且 source = L2**（T4.2 验收判据）', async () => {
    await service.update({ namespace: 'model', key: 'default.model', value: 'user-model' })
    await service.update({
      namespace: 'model',
      key: 'default.model',
      value: 'session-model',
      scope: 'session',
      sessionId: 'S1',
    })
    expect(service.get({ namespace: 'model', key: 'default.model', sessionId: 'S1' })).toEqual({
      value: 'session-model',
      source: 'L2',
    })
    expect(service.get({ namespace: 'model', key: 'default.model', sessionId: 'S2' })).toMatchObject({ source: 'L4' })
  })

  it('L1：单次覆盖最高，且不进任何持久层', () => {
    service.registerAdapterBase('model', 'default.model', 'base-model')
    service.setOverride('model', 'default.model', 'cli-model')
    expect(service.get({ namespace: 'model', key: 'default.model' })).toEqual({ value: 'cli-model', source: 'L1' })
    expect(existsSync(settingsFile())).toBe(false)
    service.clearOverrides('model')
    expect(service.get({ namespace: 'model', key: 'default.model' })).toMatchObject({ source: 'L5' })
  })

  it('D-2 逐字段合并：L4 只改 baseUrl，不会把 L5 的 models 清单抹掉', async () => {
    service.registerAdapterBase('model', 'default.models', ['m1', 'm2'])
    service.registerAdapterBase('model', 'default.baseUrl', 'https://api.deepseek.com')
    await service.update({ namespace: 'model', key: 'default.baseUrl', value: 'http://127.0.0.1:8080' })

    const merged = service.get({ namespace: 'model' })
    expect(merged.value).toMatchObject({
      default: { baseUrl: 'http://127.0.0.1:8080', models: ['m1', 'm2'] },
    })
    // 合并结果的 source 取"最浅贡献层"
    expect(merged.source).toBe('L4')
  })
})

describe('持久化：L4 以 settings.json 为真相，settings_kv 是投影', () => {
  it('update 写 L4 → settings.json 可 grep + settings_kv 有行', async () => {
    await service.update({ namespace: 'model', key: 'default.maxTokens', value: 8192 })
    const text = readFileSync(settingsFile(), 'utf8')
    expect(JSON.parse(text)).toEqual({ model: { default: { maxTokens: 8192 } } })

    const db = service['db']()
    const rows = db
      .prepare("SELECT namespace, key, value_json, source_layer, scope FROM settings_kv WHERE source_layer = 'L4'")
      .all() as Record<string, unknown>[]
    expect(rows).toEqual([
      { namespace: 'model', key: 'default.maxTokens', value_json: '8192', source_layer: 'L4', scope: 'user' },
    ])
  })

  it('重启后 L4 值仍在（文件 → 表的单向同步）', async () => {
    await service.update({ namespace: 'model', key: 'default.model', value: 'persisted' })
    service.close()

    const fresh = new LocalSettingsService({ home })
    fresh.registerNamespace(MODEL_FIELDS)
    fresh.open()
    try {
      expect(fresh.get({ namespace: 'model', key: 'default.model' })).toEqual({ value: 'persisted', source: 'L4' })
    } finally {
      fresh.close()
    }
  })

  it('L3/L2 只进 settings_kv，不进 settings.json', async () => {
    await service.update({
      namespace: 'model',
      key: 'default.model',
      value: 'ws-model',
      scope: 'workspace',
      workspace: '/repo/web',
    })
    expect(existsSync(settingsFile())).toBe(false)
    const rows = service['db']().prepare("SELECT source_layer, scope, scope_ref FROM settings_kv").all() as Record<string, unknown>[]
    expect(rows).toEqual([{ source_layer: 'L3', scope: 'workspace', scope_ref: '/repo/web' }])
  })

  it('写会话层缺 sessionId → EC-VALIDATION_FAILED（不静默写成全局）', async () => {
    await expect(
      service.update({ namespace: 'model', key: 'default.model', value: 'x', scope: 'session' }),
    ).rejects.toMatchObject({ code: 'EC-VALIDATION_FAILED' })
  })
})

describe('describe / 校验 / 脱敏', () => {
  it('describe 返回元信息与 L6 默认值，且含凭据**引用名**', () => {
    const list = service.describe('model')
    expect(list.map((d) => d.key)).toContain('default.model')
    const keyField = list.find((d) => d.key === 'auth.apiKey')!
    expect(keyField.credentialRef).toBe('DEEPSEEK_API_KEY')
    expect(keyField.sensitive).toBe(true)
  })

  it('describe 输出里不含任何凭据值（12 §7.3 / I7）', () => {
    const serialized = JSON.stringify(service.describe('model'))
    expect(serialized).not.toContain('sk-')
    // 只有引用名，没有 value 字段
    expect(serialized).not.toContain('"value"')
  })

  it('类型/枚举/未知项校验', async () => {
    await expect(
      service.update({ namespace: 'model', key: 'default.maxTokens', value: 'not-a-number' }),
    ).rejects.toMatchObject({ code: 'EC-VALIDATION_FAILED' })
    await expect(
      service.update({ namespace: 'model', key: 'default.provider', value: 'anthropic' }),
    ).rejects.toMatchObject({ code: 'EC-VALIDATION_FAILED' })
    await expect(service.update({ namespace: 'model', key: 'nope', value: 1 })).rejects.toMatchObject({
      code: 'EC-VALIDATION_FAILED',
    })
  })

  it('未知命名空间 → EC-NOT_FOUND（describe / get 一致）', () => {
    expect(() => service.describe('nope')).toThrowError(/未知的设置命名空间/)
    expect(() => service.get({ namespace: 'nope', key: 'a' })).toThrowError(/未知的设置命名空间/)
  })
})

describe('watch 与冻结接口适配', () => {
  it('watch 通知到命名空间内的变化', async () => {
    const seen: { key: string; source: string }[] = []
    const stop = service.watch('model', (change) => seen.push({ key: change.key, source: change.source }))
    await service.update({ namespace: 'model', key: 'default.model', value: 'a' })
    await service.update({
      namespace: 'model',
      key: 'default.model',
      value: 'b',
      scope: 'workspace',
      workspace: '/repo/web',
    })
    stop()
    await service.update({ namespace: 'model', key: 'default.model', value: 'c' })
    expect(seen).toEqual([
      { key: 'default.model', source: 'L4' },
      { key: 'default.model', source: 'L3' },
    ])
  })

  it('toSettingsService() 提供 ctx.settings 的冻结接口（dotted key）', async () => {
    const frozen = service.toSettingsService()
    expect(frozen.get('model.default.model')).toEqual({
      value: 'deepseek-chat',
      layer: 'schema-default',
      source: 'schema-default',
    })
    await frozen.set('model.default.maxTokens', 2048)
    const read = frozen.get('model.default.maxTokens')
    expect(read).toMatchObject({ value: 2048, layer: 'user', source: 'settings.json' })
    expect(frozen.get('model.nope.nope')).toBeUndefined()
  })
})
