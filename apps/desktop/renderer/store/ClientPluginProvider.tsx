import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { loadClientPlugins, type ClientPlugin } from './clientPlugins.tsx'

/**
 * client 插件的加载状态（docs/30 §9）。
 *
 * 单独抽一个 Provider 而不是在每个插槽里各自加载：插件的动态 import
 * 只该发生一次。多个插槽共享同一份结果，避免同一模块被求值多次
 * （那会让插件的模块级状态出现多份副本）。
 */

interface ClientPluginState {
  readonly plugins: readonly ClientPlugin[]
  /** 加载完成（无论成功与否）；界面据此决定是否显示"正在加载插件"占位 */
  readonly ready: boolean
}

const EMPTY: ClientPluginState = { plugins: [], ready: false }

const ClientPluginContext = createContext<ClientPluginState>(EMPTY)

export function ClientPluginProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<ClientPluginState>(EMPTY)

  useEffect(() => {
    let alive = true
    void loadClientPlugins().then((plugins) => {
      if (!alive) return
      setState({ plugins, ready: true })
      /*
       * 同时写一个 DOM 属性：主题插件不改结构、只改颜色，"装没装上"在界面上
       * 是看不出来的，排查时只能翻控制台。`html[data-lcode-plugins]` 让它可查。
       */
      document.documentElement.dataset['lcodePlugins'] = plugins.map((plugin) => plugin.id).join(',')
      if (plugins.length > 0) {
        console.info(`[client-plugin] 已加载 ${plugins.length} 个界面插件：${plugins.map((plugin) => plugin.id).join(', ')}`)
      }
      /*
       * 同时**回传主进程**一份结果：渲染进程的 console 不总会转发到 dev 终端，
       * 排查"插件到底加载了没"时看不到任何线索。主进程的 stderr 一定可见。
       */
      const bridge = (globalThis as unknown as {
        lcode?: { clientPluginsReport?: (input: unknown) => Promise<unknown> }
      }).lcode
      void bridge?.clientPluginsReport?.({
        loaded: plugins.map((plugin) => plugin.id),
        slots: plugins.map((plugin) => ({ id: plugin.id, slots: plugin.slots })),
      })?.catch(() => undefined)
    })
    return () => {
      alive = false
    }
  }, [])

  return <ClientPluginContext.Provider value={state}>{children}</ClientPluginContext.Provider>
}

export function useClientPlugins(): readonly ClientPlugin[] {
  return useContext(ClientPluginContext).plugins
}
