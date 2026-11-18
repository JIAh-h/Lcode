import { pathToFileURL } from 'node:url'
import { capabilityCatalogFor, PLUGIN_RPC_PROTOCOL } from '@lcode/plugin-sdk'
import type { PluginCapabilityCatalog } from '@lcode/plugin-sdk'
import type { PluginManifest } from '@lcode/plugin-manifest'
import type { Disposer } from '@lcode/util'

/**
 * 进程内插件宿主（docs/30 §9.6，对齐 DSH 的加载方式）。
 *
 * ## 为什么不再用独立子进程
 *
 * 原设计是"每个插件一个 utility process + AppContainer"。实测在 Windows 上
 * 根本起不来：helper 把子进程降到 **Low 完整性级别**，而 Node 执行脚本时会对
 * 驱动器根做 `realpath("D:\\")` → `EPERM`。改 Job Object 能去掉 AppContainer，
 * 但完整性降级仍在，问题依旧（实测：26s 超时 → 4.3s 退出，仍失败）。
 *
 * DSH 的取舍：**插件就是宿主进程里的模块**（Cordis `apply(ctx)`），沙箱只约束
 * "模型执行的命令"（shell/bash）。官方沙箱文档原文：「Only a confined execution
 * reaches `ctx.sandbox`」。
 *
 * 插件安全不靠进程沙箱，而靠：
 * 1. 插件只能调用 `ctx` 明确提供的能力；
 * 2. manifest 声明什么才能注册什么（生命周期层逐项核对 `contributes`）；
 * 3. 文件/网络能力按 `permissions` 白名单判定。
 *
 * ## 代价与对策
 *
 * 插件与主进程同进程，未捕获异常会拖垮应用。所以 activate、每次工具执行、
 * 每个事件回调**都包了 try/catch**，异常转成错误返回，绝不让它冒到进程顶层。
 */

export interface InProcessPluginHost {
  readonly capabilities: PluginCapabilityCatalog
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  readonly state: 'starting' | 'running' | 'closed' | 'crashed'
  initialize(): Promise<void>
  request<T>(method: string, params?: unknown): Promise<T>
  close(): Promise<void>
}

export interface InProcessHostOptions {
  readonly manifest: PluginManifest
  /** 已校验快照内的入口绝对路径 */
  readonly entryPath: string
  readonly workspace: Readonly<{ root: string; trusted: boolean }>
  /** 与进程外宿主共用同一套 RPC 语义：插件的每个注册都到这里 */
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>
}

type ToolExecute = (args: unknown, call: Readonly<{ callId: string }>) => unknown | Promise<unknown>

/** 插件侧上下文：形状与 utility-runner 的 createContext 一致 */
interface PluginContext {
  readonly capabilities: PluginCapabilityCatalog
  request<T>(method: string, params?: unknown): Promise<T>
  registerTool(spec: PluginToolSpecShape, execute: ToolExecute): Promise<void>
  registerPromptSection(id: string, content: string, order?: number): Promise<void>
  on(event: string, handler: (payload: unknown) => void | Promise<void>): Promise<void>
  /**
   * 注册一条 HTTP 路由（docs/30 §9.7）：平台只给入口，资源由插件自己伺服。
   *
   * 返回的响应只接受 `{ status, body, headers }`，body 必须是字符串——
   * 要发二进制就自己 base64 或用平台的静态资源入口，不要指望这里透传 Buffer。
   */
  registerRoute(path: string, handler: (request: RouteRequest) => RouteResponse | Promise<RouteResponse>): Promise<void>
}

/** 插件路由收到的请求（已裁剪成可 JSON 传的形状） */
export interface RouteRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export interface RouteResponse {
  readonly status: number
  readonly body: string | null
  readonly headers?: Readonly<Record<string, string>> | undefined
}

interface PluginToolSpecShape {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly card?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createInProcessPluginHost(options: InProcessHostOptions): InProcessPluginHost {
  const capabilities = capabilityCatalogFor(options.manifest.permissions)
  let state: InProcessPluginHost['state'] = 'starting'
  let resolveExit!: (value: { readonly code: number | null; readonly signal: string | null }) => void
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
    resolveExit = resolve
  })

  /** 工具名 → 插件交出的执行函数（隐藏层：由本项目持有，不暴露给生命周期层） */
  const toolExecutes = new Map<string, ToolExecute>()
  /** 监听器 id → 回调；key 用 `listenerId`（生命周期层分配） */
  const listeners = new Map<string, (payload: unknown) => void | Promise<void>>()
  /** 事件名 → listenerId，供 plugin/event 反查 */
  const listenerIds = new Map<string, string>()
  /** 路由路径 → 插件交出的处理函数（由 plugin/route 调用，见 §9.7） */
  const routeHandlers = new Map<string, (request: RouteRequest) => RouteResponse | Promise<RouteResponse>>()
  let activationDispose: Disposer | undefined

  const context: PluginContext = {
    capabilities,
    async request<T>(method: string, params?: unknown): Promise<T> {
      return (await options.onRequest(method, params)) as T
    },
    async registerTool(spec, execute) {
      // 登记到本层，再由生命周期层登记进工具表（它随后会回调 plugin/tool.execute）
      toolExecutes.set(spec.name, execute)
      await options.onRequest('ctx/registerTool', spec)
    },
    async registerPromptSection(id, content, order) {
      await options.onRequest('ctx/registerPromptSection', {
        id,
        content,
        ...(order === undefined ? {} : { order }),
      })
    },
    async on(event, handler) {
      /*
       * 生命周期层分配的 listenerId 形如 `plugin:<event>`；
       * 这里按事件名存，`plugin/event` 时按 listenerId 反查。
       */
      const listenerId = `plugin:${event}`
      listeners.set(listenerId, handler)
      listenerIds.set(event, listenerId)
      await options.onRequest('ctx/registerListener', { event, listenerId })
    },
    async registerRoute(path, handler) {
      routeHandlers.set(path, handler)
      await options.onRequest('ctx/registerRoute', { path })
    },
  }

  return {
    capabilities,
    exited,
    get state() {
      return state
    },
    async initialize() {
      let module: { activate?: unknown }
      try {
        module = (await import(pathToFileURL(options.entryPath).href)) as { activate?: unknown }
      } catch (error) {
        state = 'crashed'
        resolveExit({ code: 1, signal: null })
        throw new Error(`无法加载插件入口：${messageOf(error)}`)
      }
      if (typeof module.activate !== 'function') {
        state = 'crashed'
        resolveExit({ code: 1, signal: null })
        throw new Error('plugin entry must export activate(context)')
      }
      try {
        const dispose = await (module.activate as (ctx: PluginContext) => unknown)(context)
        if (dispose !== undefined && typeof dispose !== 'function') {
          throw new Error('plugin activate() must return a disposer when it returns a value')
        }
        activationDispose = dispose as Disposer | undefined
        state = 'running'
      } catch (error) {
        state = 'crashed'
        resolveExit({ code: 1, signal: null })
        throw error
      }
    },
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (state !== 'running') throw new Error('plugin host is not running')
      /* 与 utility-runner 的 requestFromCore 一一对应 */
      if (method === 'plugin/tool.execute') {
        const { name, args, callId } = (params ?? {}) as { name?: unknown; args?: unknown; callId?: unknown }
        const execute = typeof name === 'string' ? toolExecutes.get(name) : undefined
        if (execute === undefined) throw new Error(`unknown plugin tool: ${String(name)}`)
        /*
         * **包 try/catch**：插件实现里的异常不能冒到主进程顶层。
         * 转成 Error 抛给生命周期层，它会把这次工具调用记成失败——与进程外
         * 宿主的行为一致（那边是 RPC 返回 error）。
         */
        try {
          return (await execute(args, { callId: typeof callId === 'string' ? callId : '' })) as T
        } catch (error) {
          throw new Error(`plugin tool ${String(name)} failed: ${messageOf(error)}`)
        }
      }
      if (method === 'plugin/event') {
        const { listenerId, payload } = (params ?? {}) as { listenerId?: unknown; payload?: unknown }
        const handler = typeof listenerId === 'string' ? listeners.get(listenerId) : undefined
        if (handler === undefined) return null as T
        try {
          await handler(payload)
        } catch {
          // 监听器失败不打断核心事件管线（与进程外宿主一致：那边也是 catch 后忽略）
        }
        return null as T
      }
      if (method === 'plugin/route') {
        const { path, method: httpMethod, url, headers } = (params ?? {}) as {
          path?: unknown
          method?: unknown
          url?: unknown
          headers?: unknown
        }
        const handler = typeof path === 'string' ? routeHandlers.get(path) : undefined
        if (handler === undefined) return null as T
        /*
         * 把请求裁成可 JSON 的形状交给插件：`Headers` 实例过不了序列化边界，
         * 这里转成普通对象。插件拿到的就是一份数据，不能反向操作宿主对象。
         */
        const headerRecord: Record<string, string> = {}
        if (Array.isArray(headers)) {
          for (const pair of headers) {
            if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
              headerRecord[pair[0]] = pair[1]
            }
          }
        }
        try {
          const response = await handler({
            method: typeof httpMethod === 'string' ? httpMethod : 'GET',
            url: typeof url === 'string' ? url : '',
            headers: headerRecord,
          })
          return response as T
        } catch (error) {
          // 路由处理抛错：回 500 而不是让协议层静默失败，插件作者能看到原因
          return { status: 500, body: `plugin route failed: ${messageOf(error)}`, headers: { 'content-type': 'text/plain; charset=utf-8' } } as T
        }
      }
      throw new Error(`unsupported core method: ${method}`)
    },
    async close() {
      if (state === 'closed') return
      try {
        await activationDispose?.()
      } catch {
        // dispose 失败不该阻止清理
      } finally {
        toolExecutes.clear()
        listeners.clear()
        listenerIds.clear()
        routeHandlers.clear()
        activationDispose = undefined
        state = 'closed'
        resolveExit({ code: 0, signal: null })
      }
    },
  }
}

/** 供测试断言：协议常量与本文件一致 */
export const IN_PROCESS_PROTOCOL = PLUGIN_RPC_PROTOCOL
