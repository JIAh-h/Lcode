import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDesktopModelFeature } from './model-feature.ts'
import type { DesktopModelFeature } from './model-feature.ts'

/**
 * 桌面模型装配的验收（docs/24 T4.1 的装配层；批次④）。
 *
 * 这一层是**唯一**把 `model-api`（边界层）与三个实现包接起来的地方，所以它要保证的是
 * **"缝"**上的事：
 * - 设置里加的自定义供应商，**重启后还在**（启动时从 settings 同步进 `ctx.llm`）
 * - 保存/删除后**立即生效**，不用重启
 * - 凭据值**不进 settings**，只留引用名（I7）
 * - 改端点后**下一个请求**就走新地址（不缓存初值）
 */

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-deskt-model-'))
})

afterEach(() => {
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

/** 一支假的 fetch：按 URL 决定返回什么，并记录每次调用（用来断言凭据与端点） */
function fakeFetch(handler?: (url: string, init?: RequestInit) => Response): {
  fetch: typeof globalThis.fetch
  calls: { url: string; auth: string | undefined; body: unknown }[]
} {
  const calls: { url: string; auth: string | undefined; body: unknown }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      auth: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return handler === undefined
      ? new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 })
      : handler(url, init)
  }) as typeof globalThis.fetch
  return { fetch: fn, calls }
}

async function feature(handler?: (url: string, init?: RequestInit) => Response): Promise<{
  feature: DesktopModelFeature
  calls: { url: string; auth: string | undefined; body: unknown }[]
}> {
  const { fetch, calls } = fakeFetch(handler)
  return { feature: await createDesktopModelFeature({ home, fetch }), calls }
}

const CUSTOM = {
  name: 'custom-gw',
  label: '公司网关',
  base_url: 'https://gw.corp.example.com/v1',
  api_key_ref: 'CUSTOM_GW_API_KEY',
}

describe('装配：保存 → 立即生效 → 重启仍在', () => {
  it('新装配的实例没有任何自定义供应商', async () => {
    const { feature: f } = await feature()
    expect(f.providers()).toEqual([])
    expect(await f.listCustom()).toEqual([])
    f.dispose()
  })

  it('saveCustom 后适配器**立刻**可用（不用重启）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    expect(f.providers()).toEqual(['custom-gw'])
    f.dispose()
  })

  it('**重启后仍在**：新建实例会从 settings 把供应商同步进 ctx.llm', async () => {
    const first = await feature()
    await first.feature.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    first.feature.dispose()

    const second = await feature()
    expect(second.feature.providers()).toEqual(['custom-gw'])
    second.feature.dispose()
  })

  it('删掉后适配器被摘掉（否则"删了还能用"）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    await f.removeCustom({ name: 'custom-gw' })
    expect(f.providers()).toEqual([])
    // 重启也没有
    f.dispose()
    const again = await feature()
    expect(again.feature.providers()).toEqual([])
    again.feature.dispose()
  })
})

describe('装配：I7 —— 凭据值不进 settings', () => {
  it('值落在 credentials，settings.json 里只有引用名', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-live-super-secret' })
    f.dispose()

    const settings = readFileSync(join(home, 'settings.json'), 'utf8')
    expect(settings).toContain('CUSTOM_GW_API_KEY') // 引用名
    expect(settings).not.toContain('sk-live-super-secret') // 值**不在**
  })

  it('保存的模型配置本身也不含值字段', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-x' })
    const list = await f.listCustom()
    expect(JSON.stringify(list)).not.toContain('sk-x')
    f.dispose()
  })
})

describe('装配：改端点后下一个请求就走新地址', () => {
  it('overrides 每次现读设置，不缓存初值', async () => {
    const { feature: f, calls } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })

    // 先发一个请求，确认走老地址
    await f.api.probe({ provider: 'custom-gw' })
    expect(calls[0]!.url).toBe('https://gw.corp.example.com/v1/models')

    // 用户在设置页改了地址
    await f.saveCustom({ ...CUSTOM, base_url: 'https://new.example.com/v1', api_key: 'sk-secret' })

    // 下一个请求就该走新地址（不需要重启、不需要重新注册）
    await f.api.probe({ provider: 'custom-gw' })
    expect(calls[calls.length - 1]!.url).toBe('https://new.example.com/v1/models')
    f.dispose()
  })

  it('凭据值从凭据存储现取（轮换 key 下一个请求就生效，D22）', async () => {
    const { feature: f, calls } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-first' })
    await f.api.probe({ provider: 'custom-gw' })
    expect(calls[0]!.auth).toBe('Bearer sk-first')

    await f.saveCustom({ ...CUSTOM, api_key: 'sk-second' })
    await f.api.probe({ provider: 'custom-gw' })
    expect(calls[calls.length - 1]!.auth).toBe('Bearer sk-second')
    f.dispose()
  })
})

describe('装配：探测（测试连接）走真实的六类归因', () => {
  it('连得上时返回 ok 与模型清单', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    const result = await f.api.probe({ provider: 'custom-gw' })
    expect(result).toMatchObject({ ok: true })
    f.dispose()
  })

  it('401 → credential-rejected（不是笼统的"失败"）', async () => {
    const { feature: f } = await feature(() => new Response('{}', { status: 401 }))
    await f.saveCustom({ ...CUSTOM, api_key: 'bad-key' })
    const result = await f.api.probe({ provider: 'custom-gw' })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'credential-rejected' } })
    f.dispose()
  })

  it('连不上 → endpoint-unreachable', async () => {
    const { feature: f } = await feature(() => {
      throw new Error('ECONNREFUSED')
    })
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    const result = await f.api.probe({ provider: 'custom-gw' })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'endpoint-unreachable' } })
    f.dispose()
  })

  it('没填 API Key → not-configured（绑定到凭据缺失，而不是网络错）', async () => {
    const { feature: f } = await feature()
    // 存配置但不存凭据值：引用了 CUSTOM_GW_API_KEY，但那个引用解析不出来
    await f.saveCustom({ ...CUSTOM })
    const result = await f.api.probe({ provider: 'custom-gw' })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'not-configured' } })
    f.dispose()
  })

  it('未注册的供应商 → EL-NO_ADAPTER（不是崩溃）', async () => {
    const { feature: f } = await feature()
    const result = await f.api.probe({ provider: 'nope' })
    expect(result).toMatchObject({ ok: false, failure: { code: 'EL-NO_ADAPTER' } })
    f.dispose()
  })
})

describe('装配：hasCredential（只回布尔，值不进 UI）', () => {
  it('存过凭据 → true；没存过 → false', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    expect(await f.hasCredential('CUSTOM_GW_API_KEY')).toBe(true)
    expect(await f.hasCredential('NOT_THERE')).toBe(false)
    expect(await f.hasCredential('')).toBe(false)
    f.dispose()
  })

  it('只存配置不存密钥 → false（本地模型那种情形）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM })
    expect(await f.hasCredential('CUSTOM_GW_API_KEY')).toBe(false)
    f.dispose()
  })

  it('删掉模型会把凭据一起删（默认行为）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    await f.removeCustom({ name: 'custom-gw' })
    expect(await f.hasCredential('CUSTOM_GW_API_KEY')).toBe(false)
    f.dispose()
  })
})

describe('装配：默认模型', () => {
  it('setDefault / getDefault 往返', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    await f.api.setDefault({ selection: { provider: 'custom-gw', model: 'gpt-4o' } })
    expect(await f.api.getDefault()).toMatchObject({ provider: 'custom-gw', model: 'gpt-4o' })
    f.dispose()
  })

  it('**重启后仍在**（默认模型是用户设置，不能只活在内存里）', async () => {
    const first = await feature()
    await first.feature.saveCustom({ ...CUSTOM, api_key: 'sk-secret' })
    await first.feature.api.setDefault({ selection: { provider: 'custom-gw', model: 'gpt-4o' } })
    first.feature.dispose()

    // 重启：新实例
    const second = await feature()
    expect(await second.feature.api.getDefault()).toMatchObject({ provider: 'custom-gw', model: 'gpt-4o' })
    second.feature.dispose()

    // 而且落进了 settings.json（可 grep、可导出）
    const raw = readFileSync(join(home, 'settings.json'), 'utf8')
    expect(raw).toContain('custom-gw')
    expect(raw).toContain('gpt-4o')
  })
})

describe('装配：模型 id 贯通（显示名 ≠ 服务端模型名）', () => {
  /**
   * 这一组盯的是一条**静默**的断链：设置页只有一个「模型名称」字段绑到了显示名，
   * 于是"服务端模型 id"从来没被存下来过。引擎拿显示名当请求体里的 `model` 发出去，
   * 服务端一律 404——而界面上完全看不出哪里不对。
   */
  it('listCustom 带出 model 字段（渲染层据此填默认模型）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, label: '主力模型', model: 'deepseek-chat' })
    const [info] = await f.listCustom()
    expect(info!.label).toBe('主力模型')
    expect(info!.model).toBe('deepseek-chat')
    f.dispose()
  })

  it('saveCustom 省略 model → 回落 label（老 UI / "名字就是模型名"）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM })
    expect((await f.listCustom())[0]!.model).toBe('公司网关')
    f.dispose()
  })

  it('**存下来的默认选择，引擎能解析到**（不再报 EL-NO_MODEL_CONFIGURED）', async () => {
    const { feature: f } = await feature()
    await f.saveCustom({ ...CUSTOM, label: '主力模型', model: 'deepseek-chat' })
    await f.api.setDefault({ selection: { provider: 'custom-gw', model: 'deepseek-chat' } })

    // 引擎读的就是 ctx.agentDefaultModel —— 它必须有值，否则 agent.send 直接拒绝
    const selection = f.ctx.get('agentDefaultModel').get()
    expect(selection).toMatchObject({ provider: 'custom-gw', model: 'deepseek-chat' })

    // 而且这个 provider 真的有适配器（否则会是 EL-NO_ADAPTER）
    expect(f.ctx.get('llm').get('custom-gw')).toBeDefined()
    f.dispose()
  })

  it('**启动时修好"有供应商但没有默认"的历史状态**（老配置自动对齐）', async () => {
    // 造出那个真实发生过的手改形态：settings.json 里只有 providers、没有 default.*
    const seed = await feature()
    await seed.feature.saveCustom({ ...CUSTOM, label: '主力模型', model: 'deepseek-chat' })
    seed.feature.dispose()
    const onDisk = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    const modelSection = onDisk['model'] as Record<string, unknown>
    delete modelSection['default']
    writeFileSync(join(home, 'settings.json'), JSON.stringify(onDisk, null, 2) + '\n')

    // 重启：新实例应当把默认补上，而不是留着一个"看着配好了、其实没默认"的状态
    const restarted = await feature()
    expect(await restarted.feature.api.getDefault()).toMatchObject({
      provider: 'custom-gw',
      model: 'deepseek-chat',
    })
    restarted.feature.dispose()
  })
})
