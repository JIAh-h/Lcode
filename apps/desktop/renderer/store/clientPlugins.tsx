import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * 渲染层插件宿主（docs/30 §9）。
 *
 * ## 为什么需要这一半
 *
 * 插件原先只有 host 那一半：工具、提示词、事件监听。它跑在独立的 utility
 * process 里，**拿不到渲染层**——于是"换皮肤""加面板""改界面"这类需求
 * 插件体系一个都做不了，只能去改应用源码。DSH 有 host + client 两半，
 * 这里补上 client 那一半。
 *
 * ## 加载方式：Blob URL 动态 import
 *
 * 主进程把 client 入口的**源码**通过 IPC 送过来（`lcode:plugins.clientBundles`），
 * 这里用 `URL.createObjectURL(new Blob([...]))` 造一个可 import 的模块。
 *
 * 为什么不直接 `import(绝对路径)`：渲染进程开发态是 `http://localhost:5173`、
 * 生产态是 `file://`，而插件在 `~/.lcode/plugins/` 下——两种协议下 import
 * 那个绝对路径都会被拦（跨源 / 不在允许范围）。Blob URL 由页面自身创建，
 * 不受这条限制，路径与协议差异全部消化在主进程。
 *
 * ## 契约：插件导出「渲染函数」
 *
 * ```js
 * export function render({ slot, api }) {
 *   if (slot === 'theme') {
 *     api.setCssVars({ '--bg-canvas': '#1a1a20' })
 *     return null
 *   }
 *   return api.h('div', 'hello', { class: 'my-panel' })
 * }
 * ```
 *
 * 用渲染函数 + `api.h()` 而不是让插件写 JSX：插件代码是**外部来源**，
 * 我们不给它 React 实例，也不让它访问组件树。它能做的只有调用下面
 * 明确提供的那几个 API —— 边界清楚、可审计。
 */

/** 插件能用的界面插槽（与 manifest 的 `PluginSlotId` 一一对应）。 */
export type ClientSlotId = 'theme' | 'sidebar.bottom' | 'conversation.top' | 'settings.section'

const KNOWN_SLOTS: readonly ClientSlotId[] = ['theme', 'sidebar.bottom', 'conversation.top', 'settings.section']

export interface NodeResult {
  readonly type: 'node'
  readonly tag: string
  readonly content?: string | NodeResult | undefined
  readonly props?: Readonly<Record<string, string>> | undefined
}

export type RenderResult = NodeResult | null

/** 渲染函数拿到的上下文；**这是插件与宿主唯一的接口面**。 */
export interface RenderInput {
  readonly slot: ClientSlotId
  readonly api: ClientApi
}

export interface ClientApi {
  /**
   * 覆盖 CSS 变量（换色的主路径）。
   *
   * 只允许 `--*` 自定义属性：改具体属性（如 `background`）会绕过设计令牌体系，
   * 让主题失去一致性。
   */
  setCssVars(vars: Readonly<Record<string, string>>): void
  /** 清掉设过的变量（回到主题原样） */
  clearCssVars(): void
  /**
   * 设置全局背景媒体：**图片或视频**。传 `null` 清除。
   *
   * 视频走 `<video>` 元素（静音循环自动播放），图片走 CSS background。
   * 支持本地文件：`file:///C:/.../bg.mp4` 可以，因为皮肤文件在用户本机。
   */
  setBackgroundMedia(input: BackgroundMediaInput | null): void
  /** 旧接口：只设图片背景（保留兼容；新插件请用 `setBackgroundMedia`） */
  setBackgroundImage(input: { readonly url: string; readonly size?: string; readonly opacity?: number } | null): void
  /** 创建节点描述；插件不直接产出 React 元素 */
  h(tag: string, content?: string | NodeResult, props?: Readonly<Record<string, string>>): NodeResult
  /** 请求重渲染这个插槽（异步数据到达后调） */
  refresh(): void
}

export interface ClientPlugin {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly slots: readonly ClientSlotId[]
  readonly render: (input: RenderInput) => RenderResult
}

/* ─────────── 全局样式副作用（可精确回滚） ─────────── */

/** 记录"本插件改之前的值"，卸载时按它回滚 */
const appliedVars = new Map<string, string>()

function isAllowedVarName(name: string): boolean {
  return /^--[A-Za-z0-9_-]+$/.test(name)
}

export function applyCssVars(vars: Readonly<Record<string, string>>): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) {
    if (!isAllowedVarName(name) || typeof value !== 'string') continue
    /*
     * 值里不能有能闭合声明块的字符：`--x: red; } body { …` 这种要挡掉。
     * 虽然我们只设到 `documentElement.style`（不拼样式表），但多一道校验成本极低。
     */
    if (/[;{}]/.test(value)) continue
    if (!appliedVars.has(name)) appliedVars.set(name, root.style.getPropertyValue(name))
    root.style.setProperty(name, value)
  }
}

export function clearCssVars(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [name, previous] of appliedVars) {
    if (previous === '') root.style.removeProperty(name)
    else root.style.setProperty(name, previous)
  }
  appliedVars.clear()
}

let backgroundNode: HTMLDivElement | undefined
let backgroundVideo: HTMLVideoElement | undefined

/** 背景媒体：图片走 CSS，视频走 `<video>`（CSS 的 background 只吃静态图） */
export interface BackgroundMediaInput {
  readonly url: string
  /** 不传时按扩展名推断 */
  readonly kind?: 'image' | 'video' | undefined
  readonly size?: string | undefined
  readonly opacity?: number | undefined
  /** 视频专用：静音循环自动播放（默认全开，皮肤需要它） */
  readonly muted?: boolean | undefined
  readonly loop?: boolean | undefined
  readonly autoplay?: boolean | undefined
}

/**
 * 放行的背景媒体来源。
 *
 * `lcode-plugin://` 是**首选**：它把读文件的权限收在"插件自己的目录 + 媒体扩展名"
 * 里（见主进程的协议处理）。`file://` 也放行，因为用户可能想在设计稿里引用
 * 已有位置的素材；但注意它只能用于**用户自己指定**的路径，插件不应拿它去探测文件。
 */
const MEDIA_URL_ALLOWED = /^(https:\/\/|data:(image|video)\/|blob:|file:\/\/|lcode-plugin:\/\/)/

/** 从扩展名推断媒体类型；判不出来按图片处理 */
function kindOf(input: BackgroundMediaInput): 'image' | 'video' {
  if (input.kind !== undefined) return input.kind
  return /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(input.url) ? 'video' : 'image'
}

/**
 * 设置全局背景媒体（图片**或视频**）。
 *
 * ## 为什么要有这条通道
 *
 * 原先只有 `setBackgroundImage`：只接受 https / data:image，且用 CSS
 * `background-image` 实现——**视频根本没法用**（CSS 背景只吃静态图）。
 * 实测用户想用 mp4 做皮肤时，模型只能回答"改 Lcode 源码"，那是产品能力缺失，
 * 不该让用户去改 AI 的源码。
 *
 * ## 安全边界
 *
 * 放行 `https:` / `data:image|video` / `blob:` / `file://`。
 * `file://` 是**必要的**：皮肤文件就在用户本机，不放行就无法本地换肤。
 * 仍拒绝 `javascript:` 等协议；元素设 `pointer-events:none`，不会成为点击劫持载体。
 *
 * 非法 URL **抛错**而不是静默 return——静默丢弃会让插件以为成功、
 * 用户看到"什么都没变"，极难排查（旧实现正是如此）。
 */
export function applyBackgroundMedia(input: BackgroundMediaInput | null): void {
  if (typeof document === 'undefined') return
  if (backgroundNode === undefined) {
    const node = document.createElement('div')
    node.id = 'lcode-plugin-background'
    /*
     * 固定铺满、**不接收指针事件**：皮肤不该挡住任何交互。
     * z-index 0 + 页面内容本身有更高的层叠上下文，所以它落在最底下。
     */
    node.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:0',
      'pointer-events:none',
      'background-position:center',
      'background-repeat:no-repeat',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'overflow:hidden',
    ].join(';')
    document.body.prepend(node)
    backgroundNode = node
  }
  // 切换媒体时先清掉上一种，避免图片和视频叠在一起
  const clearBoth = (): void => {
    backgroundNode!.style.backgroundImage = ''
    backgroundVideo?.remove()
    backgroundVideo = undefined
  }
  if (input === null) {
    clearBoth()
    return
  }
  if (!MEDIA_URL_ALLOWED.test(input.url)) {
    throw new Error(
      `不支持的背景地址：${input.url.slice(0, 80)}。` +
        '推荐用 lcode-plugin://<插件id>/<包内路径>（读插件自己目录里的素材）；' +
        '也接受 https:// 、data:image/* 、data:video/* 、blob: 与 file:// 本地文件。',
    )
  }
  const escaped = input.url.replaceAll('"', '%22')
  const opacity = String(Math.min(Math.max(input.opacity ?? 1, 0), 1))
  clearBoth()
  backgroundNode.style.opacity = opacity
  if (kindOf(input) === 'video') {
    const video = document.createElement('video')
    video.src = input.url
    video.muted = input.muted ?? true
    video.loop = input.loop ?? true
    video.autoplay = input.autoplay ?? true
    video.playsInline = true
    video.setAttribute('aria-hidden', 'true')
    video.style.cssText = [`object-fit:${input.size ?? 'cover'}`, 'width:100%', 'height:100%', 'pointer-events:none'].join(';')
    // 自动播放被策略拦下时不抛：静默失败好过打断激活，但留一条可查日志
    void video.play().catch(() => {
      console.warn('[client-plugin] 背景视频自动播放被拦截（通常是浏览器自动播放策略）')
    })
    backgroundNode.appendChild(video)
    backgroundVideo = video
    return
  }
  backgroundNode.style.backgroundImage = `url("${escaped}")`
  backgroundNode.style.backgroundSize = input.size ?? 'cover'
}

/**
 * 兼容旧接口：只设图片背景。
 *
 * 保留是为了不破坏已在用 `setBackgroundImage` 的插件；
 * 新插件应当用 `setBackgroundMedia`（支持视频）。
 */
export function applyBackgroundImage(
  input: { readonly url: string; readonly size?: string; readonly opacity?: number } | null,
): void {
  applyBackgroundMedia(input === null ? null : { ...input, kind: 'image' })
}

/* ─────────── 加载 ─────────── */

interface BundleRow {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly slots: readonly string[]
  readonly source: string
  /** manifest `configSchema` 对应的用户配置；没有配置时为空对象 */
  readonly config?: unknown
}

/**
 * 把一个插件的源码装成模块。
 *
 * 失败返回 `undefined` 而不抛：一个插件坏掉不该让整个界面白屏。
 */
async function instantiate(row: BundleRow): Promise<ClientPlugin | undefined> {
  const holder = globalThis as unknown as { __lcodePluginConfig?: unknown }
  /*
   * 配置注入：插件在 `render` / 顶层读 `globalThis.__lcodePluginConfig`。
   *
   * 为什么走全局而不是传参：插件模块的**顶层代码**在求值时就可能要用配置
   * （比如先算一套配色再导出 render），那时还没法给它传参。挂全局是唯一
   * 能在求值前生效的通道。每个插件求值前覆盖、求值后立即删除。
   */
  holder.__lcodePluginConfig = row.config ?? {}
  let module: { render?: unknown } | undefined
  try {
    /*
     * **两条加载路径**：Blob URL 优先，失败再退到 `data:` URL。
     *
     * Electron 里 Blob 继承文档 origin（开发态是 http://localhost:5173，
     * 生产态是 file:// 的 opaque origin），某些组合下会被拦。`data:` 不继承
     * origin，能绕过那类限制；代价是模块内部相对 import 不可用——
     * 插件被要求打成单文件，正好不受影响。
     */
    for (const label of ['blob', 'data'] as const) {
      let candidate: string | undefined
      try {
        candidate = label === 'blob'
          ? URL.createObjectURL(new Blob([row.source], { type: 'text/javascript' }))
          : `data:text/javascript;charset=utf-8,${encodeURIComponent(row.source)}`
        const loaded = (await import(/* @vite-ignore */ candidate)) as { render?: unknown }
        if (typeof loaded.render === 'function') {
          module = loaded
          break
        }
        console.warn(`[client-plugin] ${row.id} 用 ${label} 加载成功但没有 render 导出`)
      } catch (error) {
        console.warn(`[client-plugin] ${row.id} 用 ${label} 加载失败：${String(error)}`)
      } finally {
        // Blob URL 会占内存，用完立刻释放
        if (label === 'blob' && candidate !== undefined) URL.revokeObjectURL(candidate)
      }
    }
  } finally {
    delete holder.__lcodePluginConfig
  }
  try {
    if (module === undefined) return undefined
    const slots = row.slots.filter((slot): slot is ClientSlotId => (KNOWN_SLOTS as readonly string[]).includes(slot))
    if (slots.length === 0) return undefined
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      slots,
      render: module.render as ClientPlugin['render'],
    }
  } catch (error) {
    console.warn(`[client-plugin] ${row.id} 装配失败：${String(error)}`)
    return undefined
  }
}

/** 加载全部 client 插件；任何一个失败只影响它自己。 */
export async function loadClientPlugins(): Promise<readonly ClientPlugin[]> {
  const bridge = (globalThis as unknown as { lcode?: { clientPlugins?: () => Promise<unknown> } }).lcode
  if (bridge?.clientPlugins === undefined) {
    // 没有主进程桥（浏览器里打开 / preload 未加载）：静默跳过，不算错误
    return []
  }
  let rows: readonly BundleRow[]
  try {
    const value = await bridge.clientPlugins()
    rows = Array.isArray(value) ? (value as BundleRow[]) : []
  } catch (error) {
    console.warn(`[client-plugin] 读取插件清单失败：${String(error)}`)
    return []
  }
  const loaded: ClientPlugin[] = []
  for (const row of rows) {
    const plugin = await instantiate(row)
    if (plugin !== undefined) loaded.push(plugin)
  }
  return loaded
}

/* ─────────── 渲染 ─────────── */

/**
 * 把插件的 `NodeResult` 转成 React 节点。
 *
 * 只放行普通标签：`script`/`iframe`/`object`/`style` 等会让插件重新获得
 * 任意执行能力，正好绕开"插件只能调用宿主 API"这条边界。
 */
const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'form'])

function toReactNode(node: NodeResult, key: string): ReactNode {
  if (BLOCKED_TAGS.has(node.tag.toLowerCase())) return null
  const children = node.content === undefined
    ? undefined
    : typeof node.content === 'string'
      ? node.content
      : toReactNode(node.content, `${key}-c`)
  const props: Record<string, unknown> = { ...node.props, key }
  // `class` 是 HTML 习惯写法；React 要的是 className
  if (typeof props['class'] === 'string') {
    props['className'] = props['class']
    delete props['class']
  }
  return createElement(node.tag, props, children)
}

/** 给插件用的节点构造器 */
function makeNodeApi(): ClientApi['h'] {
  return (tag, content, props) => ({
    type: 'node',
    tag,
    ...(content === undefined ? {} : { content }),
    ...(props === undefined ? {} : { props }),
  })
}

/**
 * 插槽宿主：渲染所有声明了该插槽的插件。
 *
 * `refresh()` 触发的是**本组件**重渲染。插件的 render 每次都会重新执行，
 * 所以插件不应在 render 里存状态——需要跨次保留的东西放它自己的模块作用域。
 */
export function PluginSlot({ plugins, slot }: { plugins: readonly ClientPlugin[]; slot: ClientSlotId }): ReactNode {
  const [, setTick] = useState(0)
  const failedRef = useRef(new Set<string>())

  /* 卸载时回滚全局样式，避免"关了插件但颜色还在" */
  useEffect(() => () => {
    clearCssVars()
    applyBackgroundMedia(null)
  }, [])

  const owners = useMemo(() => plugins.filter((plugin) => plugin.slots.includes(slot)), [plugins, slot])

  const nodes: ReactNode[] = []
  for (const plugin of owners) {
    // 已经在渲染里抛过错的插件不再重试：否则每次重渲染都刷一条同样的警告
    if (failedRef.current.has(plugin.id)) continue
    const api: ClientApi = {
      setCssVars: (vars) => {
        applyCssVars(vars)
      },
      clearCssVars: () => {
        clearCssVars()
      },
      setBackgroundMedia: (input) => {
        applyBackgroundMedia(input)
      },
      setBackgroundImage: (input) => {
        applyBackgroundImage(input)
      },
      h: makeNodeApi(),
      refresh: () => {
        setTick((value) => value + 1)
      },
    }
    try {
      const result = plugin.render({ slot, api })
      if (result !== null) nodes.push(toReactNode(result, `${plugin.id}-${slot}`))
    } catch (error) {
      failedRef.current.add(plugin.id)
      console.warn(`[client-plugin] ${plugin.id} 在插槽 ${slot} 渲染失败：${String(error)}`)
      // 重渲染一次让"这个插件已失败"生效（下次就不会再试）；放到微任务避免渲染期间 setState
      queueMicrotask(() => {
        setTick((value) => value + 1)
      })
    }
  }

  if (nodes.length === 0) return null
  return <>{nodes}</>
}
