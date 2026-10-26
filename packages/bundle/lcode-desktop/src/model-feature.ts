import { InMemoryAgentDefaultModelService } from '@lcode/agent-default-model'
import { createContext } from '@lcode/context'
import type { Context } from '@lcode/context'
import { LocalCredentialsService } from '@lcode/credentials-local'
import { InMemoryLlmRegistry } from '@lcode/llm'
import { OpenAiCompatibleAdapter } from '@lcode/llm-openai-compatible'
import { LocalModelApi, toProbeFailure } from '@lcode/model-api'
import type { CustomModelInfo, ProbeFailure } from '@lcode/model-api'
import { setNativePackageRoot } from '@lcode/session-persistence-sqlite'
import { LocalSettingsService, MODEL_FIELD_DESCRIPTORS, providerSettingKeys, WEB_SEARCH_FIELD_DESCRIPTORS } from '@lcode/settings-file'
import { CustomModelStore } from '@lcode/settings-file'
import { resolveLcodeHome } from '@lcode/util'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * 桌面集束的**模型配置**装配（doc 21 §2.7 + §2.13）。
 *
 * 装配分两层，共用一个 `ctx`：
 * - `createServices()`：把所有服务挂进 ctx（**不含**模型配置的读写）
 * - `createDesktopModelFeature()`：服务 + 模型配置（设置页用）
 *
 * 之所以拆开：`agent-runtime.ts` 需要的是**同一个 ctx** 上的服务（`ctx.llm` 等），
 * 而不是再建一套。两套 ctx 会让"设置页改的模型"与"引擎用的模型"变成两个世界。
 */

/** 桌面集束要解决的一个**打包期**问题（见下方注释） */
const requireFromHere = createRequire(import.meta.url)

/**
 * 定位 `@lcode/session-persistence-sqlite` 的包根（原生 `.node` 就在它的 `native/` 下）。
 *
 * 之所以要显式找：本集束被 esbuild **打包**进主进程的 `dist/main.js`，
 * 于是那个包的代码住在**宿主**文件里，它那套"向上找包根"的路径全部失效——
 * 而 `.node` 明明在 `node_modules/@lcode/session-persistence-sqlite/native/electron-<ABI>/`。
 *
 * 注意**不能** `require.resolve('<pkg>/package.json')`：那个包只导出 `.`，
 * 子路径会被 `ERR_PACKAGE_PATH_NOT_EXPORTED` 挡住（实测）。所以 resolve 入口再向上走。
 */
function resolveSqlitePackageRoot(): string | undefined {
  let entry: string
  try {
    entry = requireFromHere.resolve('@lcode/session-persistence-sqlite')
  } catch {
    return undefined
  }
  let dir = dirname(entry)
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
        if (parsed.name === '@lcode/session-persistence-sqlite') return dir
      } catch {
        // 读不动就继续向上
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 让原生模块能在**打包后**找到自己的 `.node`（幂等；多次调用无副作用） */
export function ensureNativePackageRoot(): void {
  const root = resolveSqlitePackageRoot()
  if (root !== undefined) setNativePackageRoot(root)
}

export interface DesktopServices {
  readonly ctx: Context
  readonly home: string
  readonly settings: LocalSettingsService
  readonly credentials: LocalCredentialsService
  /** 读一个设置项（**未经校验**：settings 对 array/object 不做深层校验，调用方自行收窄） */
  readonly readSetting: (key: string) => unknown
  readonly dispose: () => void
}

export interface CreateServicesOptions {
  readonly home?: string | undefined
}

/**
 * 建出桌面运行时**共用的那套 ctx 与服务**。
 *
 * 目前挂进去的：`ctx.llm`（适配器注册表）、`ctx.agentDefaultModel`（默认模型）。
 * 引擎需要的 `ctx.agents` / `ctx.tools` / `ctx.systemPrompt` / `ctx.agentLoop`
 * 由 `createAgentRuntime()` 挂（它需要 sessions 句柄，属于运行时那一层）。
 */
export function createServices(options: CreateServicesOptions = {}): DesktopServices {
  ensureNativePackageRoot()
  const home = options.home ?? resolveLcodeHome()

  const ctx = createContext()
  const llm = new InMemoryLlmRegistry()
  ctx.set('llm', llm)

  const settings = new LocalSettingsService({ home })
  // 必须先注册命名空间：`settings.update()` 对未注册的 key 会抛"未知设置项"
  settings.registerNamespace(MODEL_FIELD_DESCRIPTORS)
  settings.registerNamespace(WEB_SEARCH_FIELD_DESCRIPTORS)
  settings.open()

  const credentials = new LocalCredentialsService({ home })
  const readSetting = (key: string): unknown => settings.getByKey(key)?.value

  // ── 默认模型：内存服务 + settings 持久化 ──
  //
  // `InMemoryAgentDefaultModelService` 只活在进程里，而"默认模型"是**用户设置**：
  // 重启后必须还在（否则弹窗里选了、下次打开又是空，是"配置没生效"的典型形态）。
  // 把它接到 settings 的 `model.default.*` 放在装配层做——不该让
  // `agent-default-model` 这个骨架包反过来依赖 settings。
  const defaultModel = new InMemoryAgentDefaultModelService()
  const savedProvider = readSetting(`model.${providerSettingKeys.defaultProvider}`)
  const savedModel = readSetting(`model.${providerSettingKeys.defaultModel}`)
  if (typeof savedProvider === 'string' && savedProvider !== '' && typeof savedModel === 'string' && savedModel !== '') {
    void defaultModel.set({ provider: savedProvider, model: savedModel })
  }
  const setDefaultPersisted = async (selection: { provider: string; model: string }): Promise<void> => {
    await defaultModel.set(selection)
    try {
      await settings.setByKey(`model.${providerSettingKeys.defaultProvider}`, selection.provider)
      await settings.setByKey(`model.${providerSettingKeys.defaultModel}`, selection.model)
    } catch (err) {
      console.warn('[lcode] 默认模型未能写入设置（本次会话内仍然生效）：', err)
    }
  }
  ctx.set('agentDefaultModel', {
    get: (scope) => defaultModel.get(scope),
    set: (selection, scope) =>
      scope === undefined
        ? setDefaultPersisted(selection as { provider: string; model: string })
        : defaultModel.set(selection, scope),
    watch: (fn) => defaultModel.watch(fn),
  })

  return {
    ctx,
    home,
    settings,
    credentials,
    readSetting,
    dispose: () => settings.close(),
  }
}

/**
 * 把一个自定义供应商注册进 `ctx.llm`（返回撤销器）。
 *
 * `overrides` **每次读设置**（不缓存初值）：用户在设置页改完端点，下一个请求就该走新地址
 * ——这与 D22「凭据每次重新解析，避免改了没生效无法自查」是同一个取向。
 */
export function registerProviderAdapter(
  services: DesktopServices,
  config: { readonly name: string; readonly label: string; readonly base_url: string; readonly api_key_ref: string },
  fetchImpl?: typeof globalThis.fetch,
): () => void {
  const { ctx, credentials, readSetting } = services
  const adapter = new OpenAiCompatibleAdapter({
    id: config.name,
    name: config.label,
    baseUrl: config.base_url,
    apiKeyRef: config.api_key_ref,
    credentials: credentials.asCredentialsService(),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    overrides: () => {
      const raw = readSetting(`model.${providerSettingKeys.list}`)
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as Record<string, unknown>
          if (record['name'] !== config.name) continue
          return {
            baseUrl: typeof record['base_url'] === 'string' ? record['base_url'] : config.base_url,
            apiKeyRef: typeof record['api_key_ref'] === 'string' ? record['api_key_ref'] : config.api_key_ref,
          }
        }
      }
      // 配置被删掉时回退到注册时那份（而不是变成空端点）
      return { baseUrl: config.base_url, apiKeyRef: config.api_key_ref }
    },
  })
  return ctx.get('llm').register(adapter)
}

export interface DesktopModelFeatureOptions extends CreateServicesOptions {
  /** 注入 fetch（测试用；生产用全局 fetch） */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** 复用已建好的服务（`createAgentRuntime` 与设置页必须共享同一个 ctx） */
  readonly services?: DesktopServices | undefined
}

export interface DiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
}

export type DiscoverResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[] }
  | { readonly ok: false; readonly failure: ProbeFailure }

export interface DesktopModelFeature {
  readonly api: LocalModelApi
  readonly ctx: Context
  readonly services: DesktopServices
  providers(): readonly string[]
  /**
   * 用**未保存**的端点与密钥探测 `/models`（设置页「测试连接」）。
   *
   * 不写 settings、不写凭据、不注册适配器：测试连接只回答"这个 URL + Key 能不能列出模型"。
   * 成功返回模型列表，供「模型名称」下拉筛选；失败返回六类归因。
   */
  discover(input: {
    readonly base_url: string
    readonly api_key?: string
    /** 编辑模式留空 Key 时用已保存的凭据引用（值只在主进程解析） */
    readonly credential_ref?: string
  }): Promise<DiscoverResult>
  /**
   * 用**未保存**的端点与密钥查单个模型的窗口上限。
   *
   * 「模型名称」下拉里选中一个模型后要用它（列表往往不带窗口字段，详情才带）。
   * 永不抛错：拿不到返回空对象。
   */
  limitsUnsaved(input: {
    readonly base_url: string
    readonly model: string
    readonly api_key?: string
    readonly credential_ref?: string
  }): Promise<{ readonly context_window?: number; readonly max_output_tokens?: number }>
  saveCustom(input: Parameters<LocalModelApi['saveCustom']>[0]): Promise<{
    readonly saved: true
    readonly provider: string
    readonly api_key_ref: string
  }>
  removeCustom(input: {
    readonly name: string
    readonly delete_credential?: boolean
  }): Promise<{ readonly removed: boolean }>
  listCustom(): Promise<readonly CustomModelInfo[]>
  hasCredential(ref: string): Promise<boolean>
  /** 把 settings 里的自定义供应商同步进 `ctx.llm`（启动时 + 每次保存/删除后） */
  syncProviders(): Promise<readonly string[]>
  dispose(): void
}

/**
 * 模型配置装配。
 *
 * **异步**的原因只有一个：`CustomModelStore.list()` 要读 settings。
 * 启动时把"上次存过的自定义供应商"全部注册进 `ctx.llm`——否则用户在设置里加的模型
 * 重启后就消失了，那是"配置没生效"里最难自查的一种。
 */
export async function createDesktopModelFeature(
  options: DesktopModelFeatureOptions = {},
): Promise<DesktopModelFeature> {
  const services = options.services ?? createServices(options)
  const ownsServices = options.services === undefined
  const { ctx, credentials, readSetting } = services

  const store = new CustomModelStore({
    read: readSetting,
    write: (key, value) => services.settings.setByKey(key, value),
  })

  const disposers = new Map<string, () => void>()

  async function syncProviders(): Promise<readonly string[]> {
    const saved = await store.list()
    const wanted = new Set(saved.map((c) => c.name))
    // 删掉的要摘掉适配器，否则"删了还能用"
    for (const [name, dispose] of [...disposers.entries()]) {
      if (!wanted.has(name)) {
        dispose()
        disposers.delete(name)
      }
    }
    for (const config of saved) {
      disposers.get(config.name)?.()
      disposers.set(config.name, registerProviderAdapter(services, config, options.fetch))
    }
    return [...disposers.keys()]
  }

  await syncProviders()

  const api = new LocalModelApi({
    ctx,
    customModels: store,
    credentials: {
      write: (key, value) => credentials.write(key, value),
      delete: (key) => credentials.delete(key),
    },
  })

  /*
   * **修好"配了模型但没有默认"的历史状态**。
   *
   * 背景：默认模型以前从来没被写入过（保存时没有调 `setDefault`），所以老用户的
   * `settings.json` 里只有 `providers`、没有 `default.*`。而界面上模型菜单**看起来**
   * 是选好的（渲染层镜像拿清单第一项兜底显示），于是"看着能用、一发消息就说没配模型"。
   *
   * 这里在启动时把它对齐：没有默认、但有已配置的供应商 → 用第一个。
   * 这是**修数据**而不是**猜偏好**：清单非空时"用第一个"本来就是界面已经在显示的答案，
   * 这里只是让它变成真的。用户真去改过选择之后，这段就再也不会触发。
   */
  if ((await api.getDefault()) === undefined) {
    const first = (await store.list())[0]
    if (first !== undefined) {
      await api.setDefault({ selection: { provider: first.name, model: first.model } })
    }
  }

  /*
   * 默认选择里的 model id 必须跟随供应商配置。
   *
   * 输入区只让用户选"供应商"，显示的是配置的 label，而真正发给服务端的是
   * default.model。用户改过某个供应商的模型 id 后，旧默认值会静默残留：
   * 界面写着 -1017，请求却仍发 -flash（实测导致图片能力表现不一致）。
   * 启动时以配置里的 `model` 为准对齐一次；没有单独的"按供应商再选子模型"入口。
   */
  const currentDefault = await api.getDefault()
  if (currentDefault !== undefined) {
    const config = (await store.list()).find((entry) => entry.name === currentDefault.provider)
    if (config !== undefined && config.model !== currentDefault.model) {
      await api.setDefault({ selection: { provider: config.name, model: config.model } })
    }
  }

  /*
   * 老配置没有 `context_window_max`：后台补齐，不阻塞启动。
   *
   * 窗口上限是编辑体验/预算的输入，不是启动依赖；拿不到就留空，设置页仍会回落 128K。
   * 只在缺失时补，避免每次启动都打供应商接口。
   */
  void (async () => {
    const saved = await store.list()
    let changed = false
    for (const config of saved) {
      const limits = await api.modelLimits({ provider: config.name, model: config.model })
      if (limits.contextWindow === undefined) continue
      // 已经不低于供应商上报值就不再写；低于（例如旧值只是部署默认 env）则刷新上去
      if (config.context_window_max !== undefined && config.context_window_max >= limits.contextWindow) continue
      await api.saveCustom({
        name: config.name,
        label: config.label,
        model: config.model,
        base_url: config.base_url,
        api_key_ref: config.api_key_ref,
        ...(config.models === undefined ? {} : { models: config.models }),
        // 用户显式设的窗口原样保留：供应商报的是部署默认值，不能反过来压小用户的选择
        ...(config.context_window_in === undefined ? {} : { context_window_in: config.context_window_in }),
        context_window_max: limits.contextWindow,
      })
      changed = true
    }
    if (changed) await syncProviders()
  })().catch(() => undefined)

  /**
   * 「测试连接 / 未保存配置查上限」用的临时适配器。
   * 只在本次调用内存在：不写 settings、不写凭据、不进 `ctx.llm` 注册表。
   */
  const buildTempAdapter = async (
    baseUrl: string,
    typedKey: string,
    credentialRef?: string,
  ): Promise<OpenAiCompatibleAdapter> => {
    const key = typedKey.trim()
    const savedKey = key === '' && credentialRef !== undefined && credentialRef !== ''
      ? (await credentials.resolve(credentialRef))?.value ?? ''
      : ''
    const apiKey = key === '' ? savedKey : key
    return new OpenAiCompatibleAdapter({
      id: 'model-discover',
      name: 'model-discover',
      baseUrl,
      apiKeyRef: apiKey === '' ? '' : 'MODEL_DISCOVER_KEY',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      credentials: {
        resolve: async (ref) =>
          ref === 'MODEL_DISCOVER_KEY' && apiKey !== ''
            ? { refName: ref, value: apiKey, source: 'env' }
            : undefined,
        describeSource: async () => undefined,
      },
    })
  }

  return {
    api,
    ctx,
    services,
    providers: () => [...disposers.keys()],
    async discover(input) {
      const baseUrl = input.base_url.trim()
      const adapter = await buildTempAdapter(baseUrl, input.api_key ?? '', input.credential_ref)
      try {
        const models = await adapter.listModels(AbortSignal.timeout(10_000))
        return {
          ok: true as const,
          models: models.map((model) => ({
            id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          })),
        }
      } catch (err) {
        return { ok: false as const, failure: toProbeFailure(err) }
      }
    },
    async limitsUnsaved(input) {
      const model = input.model.trim()
      if (model === '') return {}
      const adapter = await buildTempAdapter(input.base_url.trim(), input.api_key ?? '', input.credential_ref)
      const describe = adapter.describeModel?.bind(adapter)
      if (describe !== undefined) {
        try {
          const detail = await describe({ provider: 'model-discover', model }, { signal: AbortSignal.timeout(10_000) })
          if (detail.contextWindow !== undefined || detail.maxOutputTokens !== undefined) {
            return {
              ...(detail.contextWindow === undefined ? {} : { context_window: detail.contextWindow }),
              ...(detail.maxOutputTokens === undefined ? {} : { max_output_tokens: detail.maxOutputTokens }),
            }
          }
        } catch {
          // 详情不是协议标准：回落到列表
        }
      }
      try {
        const models = await adapter.listModels(AbortSignal.timeout(10_000))
        const found = models.find((candidate) => candidate.id === model)
        return found?.contextWindow === undefined ? {} : { context_window: found.contextWindow }
      } catch {
        return {}
      }
    },
    async saveCustom(input) {
      const result = await api.saveCustom(input)
      // 立刻注册：不这样的话用户"保存成功"却要重启才能用，是最难自查的一类问题
      await syncProviders()
      return result
    },
    async removeCustom(input) {
      const result = await api.removeCustom(input)
      await syncProviders()
      return result
    },
    listCustom: () => api.listCustom(),
    async hasCredential(ref) {
      if (ref === '') return false
      // 注意：**环境变量里的凭据也会让它回 false**（D22 的 ④ 层），
      // 所以 UI 只能当作"我们这边存过没有"的提示，不能拿它断言"这家一定不可用"。
      const refs = await credentials.listRefs()
      return refs.some((info) => info.ref === ref && info.present)
    },
    syncProviders,
    dispose() {
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      if (ownsServices) services.dispose()
    },
  }
}
