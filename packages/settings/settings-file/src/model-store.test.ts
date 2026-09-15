import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CustomModelStore } from './model-store.ts'
import { MODEL_FIELD_DESCRIPTORS, providerSettingKeys } from './namespace.ts'
import { LocalSettingsService } from './settings-service.ts'

/**
 * 自定义模型配置的写路径（18 §2 / §8.2；批次④）。
 *
 * 盯两件事：
 * - **能真的存下来**（写进 `settings.json`，可 grep、可导出）
 * - **凭据值不落进 settings**（I7 / 宪法第二条）——settings 里只有引用名
 */

let home = ''
let service: LocalSettingsService
let store: CustomModelStore

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-modelstore-'))
  service = new LocalSettingsService({ home })
  service.registerNamespace(MODEL_FIELD_DESCRIPTORS)
  service.open()
  store = new CustomModelStore({
    read: (key) => service.getByKey(key)?.value,
    write: (key, value) => service.setByKey(key, value),
  })
})

afterEach(() => {
  service.close()
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const sample = {
  name: 'custom-my-gw',
  label: '公司网关',
  base_url: 'https://gw.corp.example.com/v1',
  api_key_ref: 'CUSTOM_MY_GW_API_KEY',
}

/**
 * 直接改 `settings.json` 再重开——这才等价于"用户手改配置文件"。
 *
 * 为什么**不用** `setByKey` 去造这个场景：settings 在写入侧就会校验顶层类型
 * （`array` 期望），所以经 API 根本写不进非数组。手改文件绕过了那层校验，
 * 而 `CustomModelStore` 读到的就是未经校验的东西——这正是它必须做形状收窄的原因。
 */
function handEditRaw(providers: unknown): void {
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ model: { [providerSettingKeys.list]: providers } }, null, 2) + '\n',
  )
  service.close()
  service = new LocalSettingsService({ home })
  service.registerNamespace(MODEL_FIELD_DESCRIPTORS)
  service.open()
  store = new CustomModelStore({
    read: (k) => service.getByKey(k)?.value,
    write: (k, v) => service.setByKey(k, v),
  })
}

describe('自定义模型：增删查', () => {
  it('空清单返回 []，不抛错', async () => {
    expect(await store.list()).toEqual([])
  })

  it('upsert 后能读回来，且落进 settings.json（L4 真相）', async () => {
    await store.upsert(sample)
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject(sample)

    const onDisk = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as {
      model?: Record<string, unknown>
    }
    expect(JSON.stringify(onDisk)).toContain('custom-my-gw')
    expect(JSON.stringify(onDisk)).toContain('https://gw.corp.example.com/v1')
  })

  it('同名 upsert 是更新而不是新增（幂等）', async () => {
    await store.upsert(sample)
    await store.upsert({ ...sample, label: '改过的名字' })
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.label).toBe('改过的名字')
  })

  it('删除；对不存在的删是幂等的', async () => {
    await store.upsert(sample)
    expect(await store.remove('custom-my-gw')).toEqual({ removed: true })
    expect(await store.list()).toEqual([])
    expect(await store.remove('custom-my-gw')).toEqual({ removed: false })
  })

  it('多家互不干扰（18 §2「各家的配置独立」）', async () => {
    await store.upsert(sample)
    await store.upsert({ name: 'local-ollama', label: '本地', base_url: 'http://localhost:11434/v1', api_key_ref: '' })
    const list = await store.list()
    expect(list.map((c) => c.name).sort()).toEqual(['custom-my-gw', 'local-ollama'])
  })
})

describe('自定义模型：I7 —— 凭据值不落进 settings', () => {
  it('存进去的只有引用名；值不在 settings.json 里', async () => {
    await store.upsert(sample)
    const raw = readFileSync(join(home, 'settings.json'), 'utf8')
    expect(raw).toContain('CUSTOM_MY_GW_API_KEY') // 引用名在
    expect(raw).not.toContain('sk-live-') // 值不在（本模块根本不接受值）
  })

  it('api_key_ref 为空串 = 不需要密钥（本地模型），是合法配置', async () => {
    const saved = await store.upsert({ name: 'ollama', label: 'Ollama', base_url: 'http://localhost:11434/v1', api_key_ref: '' })
    expect(saved.api_key_ref).toBe('')
  })
})

describe('自定义模型：校验（填错当场报，别等发请求才炸）', () => {
  it('id 非法 → EC-INVALID_PARAMS', async () => {
    await expect(store.upsert({ ...sample, name: '有中文的名字' })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
    await expect(store.upsert({ ...sample, name: '-leading-dash' })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
  })

  it('接口地址为空或缺协议头 → EC-INVALID_PARAMS', async () => {
    await expect(store.upsert({ ...sample, base_url: '' })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(store.upsert({ ...sample, base_url: 'api.example.com/v1' })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
  })

  it('地址末尾斜杠被归一（避免 //chat/completions）', async () => {
    const saved = await store.upsert({ ...sample, base_url: 'https://gw.example.com/v1///' })
    expect(saved.base_url).toBe('https://gw.example.com/v1')
  })

  it('label 省略时退回 id（弹窗允许只填模型名）', async () => {
    const saved = await store.upsert({ ...sample, label: '' })
    expect(saved.label).toBe('custom-my-gw')
  })
})

describe('自定义模型：模型 id 与显示名是两件事', () => {
  /**
   * 这一组盯的是一个实测踩过的 bug：设置页只有一个「模型名称」字段，它绑到了 `label`
   * （显示名）。于是引擎拿显示名当请求体里的 `model` 发出去，服务端一律 404——
   * 而界面上一切正常，因为列表里显示的确实就是用户填的那个名字。
   */
  it('显示名与模型 id 分别存下来，互不覆盖', async () => {
    await store.upsert({ ...sample, label: '主力模型', model: 'deepseek-chat' })
    const [saved] = await store.list()
    expect(saved!.label).toBe('主力模型')
    expect(saved!.model).toBe('deepseek-chat')
  })

  it('省略 model → 回落 label（"显示名就是模型名"是最常见的形态）', async () => {
    await store.upsert(sample) // sample 没有 model 字段
    const [saved] = await store.list()
    expect(saved!.model).toBe(sample.label)
  })

  it('**老配置**（没有 model 字段）读回来时回落 label，而不是被当成无效项丢掉', async () => {
    handEditRaw([{ name: 'legacy', label: '老配置', base_url: 'https://a.example.com/v1', api_key_ref: 'K' }])
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.model).toBe('老配置')
  })

  it('model 显式传空串 = 回落 label（空串与省略是同一件事）', async () => {
    await store.upsert({ ...sample, model: '' })
    const [saved] = await store.list()
    expect(saved!.model).toBe(sample.label)
  })
})

describe('自定义模型：坏数据不炸（settings.json 是用户可以手改的）', () => {
  it('清单里混入非对象 / 缺字段的项 → 跳过它们，保留合法的', async () => {
    handEditRaw([null, 'nonsense', { name: 'ok', base_url: 'https://a.example.com/v1' }, { name: 42 }])
    const list = await store.list()
    expect(list.map((c) => c.name)).toEqual(['ok'])
    // 缺 api_key_ref 的项按"不需要密钥"处理，而不是整条丢掉
    expect(list[0]!.api_key_ref).toBe('')
  })

  it('清单整个被改成非数组 → 返回 []，不抛错', async () => {
    handEditRaw('oops')
    expect(await store.list()).toEqual([])
  })

  it('手改坏的清单之后，upsert 能把它修回合法形状', async () => {
    handEditRaw({ 不是: '数组' })
    expect(await store.list()).toEqual([])
    await store.upsert(sample)
    expect((await store.list()).map((c) => c.name)).toEqual(['custom-my-gw'])
  })
})
