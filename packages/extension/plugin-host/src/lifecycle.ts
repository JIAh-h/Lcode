import type { Context } from '@lcode/context'
import type { PluginManifest } from '@lcode/plugin-manifest'
import type { PluginCapabilityCatalog } from '@lcode/plugin-sdk'

/**
 * 没有 host 的插件（纯客户端）的能力账本。
 *
 * 它们不申请任何宿主能力（渲染层能做的事由 `api` 决定，与 permissions 无关），
 * 但 `PluginInspection` 的形状要求这一项存在。
 */
const EMPTY_CAPABILITIES: PluginCapabilityCatalog = {
  fs: { read: [], write: [] },
  network: [],
  spawn: [],
  env: [],
}
import type { SystemPromptService } from '@lcode/system-prompt'
import type { ToolDefinition, ToolInputSchema, ToolRegistry } from '@lcode/tools'
import { ERROR_CODES, LcodeErrorImpl, isJsonValue, type Disposer, type JsonValue } from '@lcode/util'
import type { PluginHostClient } from './index.ts'
import type { PluginRouteRegistry } from './routes.ts'

export type PluginLifecycleState = 'activating' | 'active' | 'rolling-back' | 'deactivating'

export interface PluginLifecycleTarget {
  readonly manifest: PluginManifest
  /** Absolute path inside the registry's verified, immutable snapshot. */
  readonly entryPath: string
}

export interface PluginHostStarterInput {
  readonly target: PluginLifecycleTarget
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>
}

export type PluginHostStarter = (input: PluginHostStarterInput) => Promise<PluginHostClient>

export interface PluginLifecycleManagerOptions {
  readonly context: Context
  /**
   * tools / systemPrompt **延迟解析**。
   *
   * 之前是直接收实例：顶层创建 manager 时这两个服务还没挂（tooling bundle
   * 在 composeRuntimeProfile 里更晚才 mount），`ctx.get('tools')` 直接抛
   * service not registered。改成 getter 后，解析推迟到第一次 activate——
   * 那时组合已完成，服务必然在。
   */
  readonly tools: () => ToolRegistry
  readonly systemPrompt: () => SystemPromptService
  /**
   * 插件 HTTP 路由表（docs/30 §9.7）。省略 = 不开放路由能力。
   *
   * 插件通过 `ctx.registerRoute(path, handler)` 注册，宿主在
   * `lcode-plugin://<id>/<path>` 协议处理里分发。这样平台只需开放**入口**，
   * 具体资源（视频/流式/鉴权）由插件自己伺候——与 DSH 的 `ctx.webServer` 同理。
   */
  readonly routes?: PluginRouteRegistry | undefined
  readonly startHost: PluginHostStarter
}

export interface PluginInstallationStore {
  activationSource(input: { readonly id: string; readonly version: string }): Promise<PluginLifecycleTarget>
  setEnabled(input: { readonly id: string; readonly version: string; readonly enabled: boolean }): Promise<void>
  uninstall(input: { readonly id: string; readonly version: string }): Promise<void>
}

export interface ActivePlugin {
  readonly id: string
  readonly version: string
  readonly state: PluginLifecycleState
}

export interface PluginInspection extends ActivePlugin {
  readonly contributes: Readonly<{
    tools: readonly string[]
    services: readonly string[]
    promptSections: readonly string[]
  }>
  readonly capabilities: PluginCapabilityCatalog
}

/** Read-only catalog. It intentionally contains no entry path, handles, credentials, or arbitrary service lookup. */
export interface PluginInspectService {
  inspect(): readonly PluginInspection[]
}

interface LifecycleRecord {
  readonly key: string
  readonly target: PluginLifecycleTarget
  state: PluginLifecycleState
  readonly disposers: Disposer[]
  stopRequested: boolean
  host?: PluginHostClient
  settled: Promise<ActivePlugin>
}

/**
 * Core-owned plugin lifecycle transaction. Plugin code can request a declared
 * registration through RPC, but every resulting resource is owned here and is
 * removed in reverse order on every exit path.
 */
export class PluginLifecycleManager {
  #records = new Map<string, LifecycleRecord>()

  constructor(private readonly options: PluginLifecycleManagerOptions) {}

  list(): readonly ActivePlugin[] {
    return [...this.#records.values()].map(toActivePlugin)
  }

  inspect(): readonly PluginInspection[] {
    return [...this.#records.values()]
      /*
       * `host !== undefined` 曾经是这里的硬条件——但**纯客户端插件根本没有 host**
       * （只有渲染层入口，没有工具/提示段/事件订阅）。于是它们虽然被标成
       * active，却永远不出现在 inspect() 里，设置页那行就一直显示"未启动"，
       * 点"启动"还会提示"已启动"——两处说法互相矛盾（实测踩过）。
       *
       * 现在：只要记录处于 active 就算激活；没有 host 时 capabilities 用空集。
       */
      .filter((record) => record.state === 'active')
      .map((record) => ({
        ...toActivePlugin(record),
        contributes: {
          tools: [...(record.target.manifest.contributes.tools ?? [])],
          services: [...(record.target.manifest.contributes.services ?? [])],
          promptSections: [...(record.target.manifest.contributes.promptSections ?? [])],
        },
        capabilities: record.host?.capabilities ?? EMPTY_CAPABILITIES,
      }))
      .sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`))
  }

  activate(target: PluginLifecycleTarget): Promise<ActivePlugin> {
    const key = pluginKey(target)
    const existing = this.#records.get(key)
    if (existing !== undefined) return existing.settled

    const record: LifecycleRecord = {
      key,
      target,
      state: 'activating',
      disposers: [],
      stopRequested: false,
      settled: undefined as unknown as Promise<ActivePlugin>,
    }
    record.settled = this.#activate(record)
    this.#records.set(key, record)
    return record.settled
  }

  async deactivate(target: Pick<PluginLifecycleTarget, 'manifest'>): Promise<void> {
    await this.deactivateByKey(`${target.manifest.id}@${target.manifest.version}`)
  }

  /**
   * 登记一个**纯客户端插件**的激活状态（不启动 host）。
   *
   * 这类插件只在渲染层工作（主题、面板），host 的 `activate` 是空的，起程序
   * 只会白等一个必定超时的握手。但它们**仍然是已激活的插件**——设置页要显示
   * "运行中"、用户要能停用/卸载，所以必须在记录表里有一条。
   *
   * 之前这条记录压根不存在，于是 `inspect()` 永远看不到它：点"启动"提示
   * "已启动"，行内却仍是"未启动"（实测踩过）。
   */
  registerClientOnly(target: PluginLifecycleTarget): ActivePlugin {
    const key = pluginKey(target)
    const existing = this.#records.get(key)
    if (existing !== undefined) return toActivePlugin(existing)
    const record: LifecycleRecord = {
      key,
      target,
      state: 'active',
      disposers: [],
      stopRequested: false,
      settled: undefined as unknown as Promise<ActivePlugin>,
    }
    record.settled = Promise.resolve(toActivePlugin(record))
    this.#records.set(key, record)
    return toActivePlugin(record)
  }

  async deactivateByKey(key: string): Promise<void> {
    const record = this.#records.get(key)
    if (record === undefined) return
    record.stopRequested = true
    try {
      await record.settled
    } catch {
      // Activation failure already rolled all resources back below.
    }
    if (this.#records.get(key) !== record || record.state !== 'active') return
    record.state = 'deactivating'
    await this.#release(record)
    this.#records.delete(key)
  }

  async uninstall(target: Pick<PluginLifecycleTarget, 'manifest'>, removeInstalled: () => Promise<void>): Promise<void> {
    await this.deactivate(target)
    await removeInstalled()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#records.values()].map(async (record) => await this.deactivate(record.target)))
  }

  async #activate(record: LifecycleRecord): Promise<ActivePlugin> {
    try {
      const host = await this.options.startHost({
        target: record.target,
        onRequest: async (method, params) => await this.#handleRegistration(record, method, params),
      })
      record.host = host
      if (record.stopRequested) {
        record.state = 'rolling-back'
        await this.#release(record)
        this.#records.delete(record.key)
        throw activationFailed('Plugin activation was cancelled by deactivation')
      }
      record.state = 'active'
      return toActivePlugin(record)
    } catch (error) {
      record.state = 'rolling-back'
      await this.#release(record)
      this.#records.delete(record.key)
      if (error instanceof LcodeErrorImpl) throw error
      throw activationFailed('Plugin activation failed', error)
    }
  }

  async #handleRegistration(record: LifecycleRecord, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ctx/registerTool':
        return this.#registerTool(record, params)
      case 'ctx/registerPromptSection':
        return this.#registerPromptSection(record, params)
      case 'ctx/registerListener':
        return this.#registerListener(record, params)
      case 'ctx/registerRoute':
        return this.#registerRoute(record, params)
      default:
        throw undeclared(`Plugin requested unsupported context operation: ${method}`)
    }
  }

  #registerTool(record: LifecycleRecord, params: unknown): null {
    if (!isToolSpec(params)) throw activationFailed('Plugin submitted an invalid tool definition')
    if (!(record.target.manifest.contributes.tools ?? []).includes(params.name)) {
      throw undeclared(`Tool ${params.name} is not declared in the plugin manifest`)
    }
    const tool: ToolDefinition<unknown, JsonValue> = {
      name: params.name,
      description: params.description,
      inputSchema: params.inputSchema,
      execute: async (call) => {
        const host = record.host
        if (host === undefined || host.state !== 'running') throw unavailable('Plugin tool host is unavailable')
        const result = await host.request<unknown>('plugin/tool.execute', {
          name: params.name,
          args: call.parsed,
          callId: call.callId,
        })
        if (!isJsonValue(result)) throw activationFailed(`Plugin tool ${params.name} returned a non-JSON value`)
        return result
      },
    }
    this.#track(record, this.options.tools().register(tool))
    return null
  }

  #registerPromptSection(record: LifecycleRecord, params: unknown): null {
    if (!isPromptSection(params)) throw activationFailed('Plugin submitted an invalid prompt section')
    if (!(record.target.manifest.contributes.promptSections ?? []).includes(params.id)) {
      throw undeclared(`Prompt section ${params.id} is not declared in the plugin manifest`)
    }
    this.#track(record, this.options.systemPrompt().section(params.id, params.content, params.order === undefined ? undefined : { order: params.order }))
    return null
  }

  #registerListener(record: LifecycleRecord, params: unknown): null {
    if (!isListener(params)) throw activationFailed('Plugin submitted an invalid event listener')
    if (!(record.target.manifest.activation?.events ?? []).includes(params.event)) {
      throw undeclared(`Event ${params.event} is not declared in the plugin manifest`)
    }
    this.#track(record, this.options.context.events.on(params.event, async (payload) => {
      const host = record.host
      if (host === undefined || host.state !== 'running') return
      try {
        await host.request('plugin/event', { listenerId: params.listenerId, payload })
      } catch {
        // A plugin listener must never break the core event pipeline.
      }
    }))
    return null
  }

  /**
   * 插件注册一条 HTTP 路由（docs/30 §9.7，对齐 DSH 的 `ctx.webServer`）。
   *
   * 平台只开放入口（`lcode-plugin://<id>/<path>`），具体资源怎么伺服由插件决定：
   * 视频、流式、鉴权、转码都行。这样平台不必为每种资源类型维护白名单。
   *
   * **handler 必须由宿主持有**：插件传进来的是函数（进程内模式），
   * 或者一个路由 id（子进程模式）。这里统一存"能把请求变成响应的东西"，
   * 具体分发在 `resolve` 时进行。
   */
  #registerRoute(record: LifecycleRecord, params: unknown): null {
    const routes = this.options.routes
    if (routes === undefined) throw undeclared('当前运行时未开放插件 HTTP 路由（ctx.webServer）')
    if (!isRouteSpec(params)) throw activationFailed('Plugin submitted an invalid route definition')
    /*
     * 声明核对：`contributes.routes` 里没写就不能注册。
     * 与工具/提示段同一套规则——"声明什么才能注册什么"。
     */
    if (!(record.target.manifest.contributes.routes ?? []).includes(params.path)) {
      throw undeclared(`Route ${params.path} is not declared in the plugin manifest`)
    }
    const handler = async (request: Request): Promise<Response> => {
      const host = record.host
      if (host === undefined || host.state !== 'running') {
        return new Response('plugin host is not running', { status: 503 })
      }
      /*
       * 单实例宿主：路径之外的东西都序列化后交给插件。
       * 请求体不转（视频是 GET/Range，不需要 body），避免把二进制塞进 RPC。
       */
      const result = await host.request<unknown>('plugin/route', {
        path: params.path,
        method: request.method,
        url: request.url,
        headers: [...request.headers.entries()],
      })
      if (!isRouteResponse(result)) {
        return new Response('plugin route returned an invalid response', { status: 502 })
      }
      return new Response(result.body === null ? null : result.body, {
        status: result.status,
        headers: result.headers ?? {},
      })
    }
    this.#track(record, routes.register({ pluginId: record.target.manifest.id, path: params.path, handler }))
    return null
  }

  #track(record: LifecycleRecord, disposer: Disposer): void {
    if (record.state === 'activating' || record.state === 'active') {
      record.disposers.push(disposer)
      return
    }
    disposer()
  }

  async #release(record: LifecycleRecord): Promise<void> {
    for (let index = record.disposers.length - 1; index >= 0; index--) {
      try {
        record.disposers[index]!()
      } catch {
        // Continue releasing the remaining resources; lifecycle cleanup is best effort per disposer.
      }
    }
    record.disposers.length = 0
    if (record.host !== undefined) await record.host.close()
  }
}

/** Persisted installation intent wrapped around the in-memory lifecycle transaction. */
export class InstalledPluginLifecycleService {
  constructor(
    private readonly lifecycle: PluginLifecycleManager,
    private readonly installations: PluginInstallationStore,
  ) {}

  async activate(input: { readonly id: string; readonly version: string }): Promise<ActivePlugin> {
    const target = await this.installations.activationSource(input)
    /*
     * **client-only 插件不需要 host 进程**（docs/30 §9.3）：
     * contributes 里只有 client（渲染层入口），host 的 activate 是空的——
     * 为它起 utility host 只会白等一个注定超时的握手（沙箱下 electron.exe
     * 无法在 AppContainer 里跑，实测每次 26 秒）。
     *
     * 判据：contributes.tools / promptSections / services 全空。
     * 有任何一项 host 贡献才真正启动 host。
     */
    const contributes = target.manifest.contributes
    const hostNeeded = (contributes.tools?.length ?? 0) > 0
      || (contributes.promptSections?.length ?? 0) > 0
      || (contributes.services?.length ?? 0) > 0
    if (!hostNeeded) {
      /* 纯客户端插件：登记激活状态即可（渲染层由 clientPlugins 加载），不起 host */
      const active = this.lifecycle.registerClientOnly(target)
      await this.installations.setEnabled({ ...input, enabled: true })
      return active
    }
    const active = await this.lifecycle.activate(target)
    try {
      await this.installations.setEnabled({ ...input, enabled: true })
      return active
    } catch (error) {
      await this.lifecycle.deactivate(target)
      throw error
    }
  }

  async deactivate(input: { readonly id: string; readonly version: string }): Promise<void> {
    await this.lifecycle.deactivateByKey(`${input.id}@${input.version}`)
    await this.installations.setEnabled({ ...input, enabled: false })
  }

  async uninstall(input: { readonly id: string; readonly version: string }): Promise<void> {
    await this.deactivate(input)
    await this.installations.uninstall(input)
  }

  inspect(): readonly PluginInspection[] { return this.lifecycle.inspect() }
}

declare module '@lcode/context' {
  interface Services {
    plugins: PluginInspectService
  }
}

function pluginKey(target: PluginLifecycleTarget): string {
  return `${target.manifest.id}@${target.manifest.version}`
}

function toActivePlugin(record: LifecycleRecord): ActivePlugin {
  return { id: record.target.manifest.id, version: record.target.manifest.version, state: record.state }
}

function isToolSpec(value: unknown): value is { name: string; description: string; inputSchema: ToolInputSchema } {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.description !== 'string') return false
  const schema = value.inputSchema
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) return false
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) return false
  return Object.values(schema.properties).every((property) => isRecord(property) && typeof property.type === 'string')
}

function isPromptSection(value: unknown): value is { id: string; content: string; order?: number } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.content === 'string' && (value.order === undefined || typeof value.order === 'number')
}

function isListener(value: unknown): value is { event: string; listenerId: string } {
  return isRecord(value) && typeof value.event === 'string' && typeof value.listenerId === 'string'
}

function isRouteSpec(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === 'string' && value.path.startsWith('/')
}

/** 插件返回的路由响应：只接受这三种字段，避免插件塞任意结构 */
function isRouteResponse(value: unknown): value is { status: number; body: string | null; headers?: Record<string, string> } {
  if (!isRecord(value)) return false
  if (typeof value.status !== 'number' || !Number.isInteger(value.status)) return false
  if (value.body !== null && typeof value.body !== 'string') return false
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) return false
    if (!Object.values(value.headers).every((item) => typeof item === 'string')) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function activationFailed(message: string, cause?: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EX_ACTIVATION_FAILED, message, userMessage: '这个扩展启动失败，已回滚本次加载。', retryable: false, ...(cause === undefined ? {} : { cause }) })
}

function undeclared(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EX_UNDECLARED_PERMISSION, message, userMessage: '这个扩展请求了未声明的能力，已拒绝。', retryable: false })
}

function unavailable(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EX_HOST_UNAVAILABLE, message, userMessage: '扩展进程已停止，当前功能不可用。', retryable: false })
}
