/**
 * 插件 HTTP 路由注册表（docs/30 §9.7，对齐 DSH 的 `ctx.webServer`）。
 *
 * ## 为什么平台不自己放行视频
 *
 * DSH 的 `/plugins/<pkg>/assets/` 只放行图片（`.svg/.png/.webp/.jpg/.jpeg`）。
 * 视频皮肤是怎么做的？插件**自己注册 HTTP 路由**：
 * `dsh-video-skin` 的 host 半边用带 Range 的路由提供 `/dsh-video-skin/background.mp4`。
 *
 * 也就是说平台只给**入口**，具体资源由插件自己伺候——这样平台不必为每种
 * 资源类型维护白名单，插件的自由度也更高（做流式、做鉴权、做转码都行）。
 *
 * ## 安全边界
 *
 * 插件只能注册**自己命名空间下**的路径（`/lcode-plugin/<id>/...` 之外的前缀被拒绝），
 * 且注册项随插件卸载自动撤销。这样两个插件不能抢同一条路由。
 */

/** 一条插件路由的处理函数：拿到请求，返回响应。 */
export type PluginRouteHandler = (request: Request) => Response | Promise<Response>

export interface PluginRouteEntry {
  readonly pluginId: string
  /** 规范化后的绝对路径前缀（不带结尾斜杠），如 `/wallpaper` */
  readonly path: string
  readonly handler: PluginRouteHandler
}

export interface PluginRouteRegistry {
  /** 注册一条路由，返回撤销器 */
  register(input: { readonly pluginId: string; readonly path: string; readonly handler: PluginRouteHandler }): () => void
  /** 按插件 id + 请求路径查找最长匹配的处理器 */
  resolve(pluginId: string, pathname: string): { readonly handler: PluginRouteHandler; readonly rest: string } | undefined
  /** 撤销某个插件的全部路由（卸载时用） */
  clear(pluginId: string): void
  /** 当前注册的路由（诊断用） */
  list(): readonly { readonly pluginId: string; readonly path: string }[]
}

/** 把插件给的路径规范成 `/a/b`；拒绝 `..`、空串与协议相对写法 */
function normalizeRoutePath(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  // 必须以单斜杠开头、不能是 `//host` 这种协议相对写法
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined
  const segments = trimmed.split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined
  return `/${segments.join('/')}`
}

export function createPluginRouteRegistry(): PluginRouteRegistry {
  const routes = new Map<string, PluginRouteEntry[]>()

  return {
    register({ pluginId, path, handler }) {
      const normalized = normalizeRoutePath(path)
      if (normalized === undefined) {
        throw new Error(`插件路由路径非法：${path}（必须以 / 开头，且不能包含 ..）`)
      }
      if (pluginId === '') throw new Error('插件路由必须带插件 id')
      const list = routes.get(pluginId) ?? []
      // 同路径重复注册视为覆盖（插件热重载时会再走一次 activate）
      const next = list.filter((entry) => entry.path !== normalized)
      next.push({ pluginId, path: normalized, handler })
      routes.set(pluginId, next)
      return () => {
        const current = routes.get(pluginId)
        if (current === undefined) return
        const remaining = current.filter((entry) => entry.path !== normalized)
        if (remaining.length === 0) routes.delete(pluginId)
        else routes.set(pluginId, remaining)
      }
    },
    resolve(pluginId, pathname) {
      const list = routes.get(pluginId)
      if (list === undefined) return undefined
      /*
       * 最长前缀匹配：`/wallpaper/a` 同时匹配 `/wallpaper` 与 `/wall`
       * 时应当用更具体的那条，否则插件没法同时注册粗粒度和细粒度路由。
       */
      const matches = list
        .filter((entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`))
        .sort((left, right) => right.path.length - left.path.length)
      const best = matches[0]
      if (best === undefined) return undefined
      const rest = pathname.slice(best.path.length).replace(/^\/+/, '')
      return { handler: best.handler, rest }
    },
    clear(pluginId) {
      routes.delete(pluginId)
    },
    list() {
      return [...routes.values()].flatMap((list) => list.map(({ pluginId, path }) => ({ pluginId, path })))
    },
  }
}
