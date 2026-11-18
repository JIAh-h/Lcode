import { describe, expect, it } from 'vitest'
import { createPluginRouteRegistry } from './routes.ts'

const ok = (): Response => new Response('ok')

describe('插件 HTTP 路由表（docs/30 §9.7）', () => {
  it('注册后能按路径解析', () => {
    const routes = createPluginRouteRegistry()
    routes.register({ pluginId: 'acme.skin', path: '/background.mp4', handler: ok })
    const hit = routes.resolve('acme.skin', '/background.mp4')
    expect(hit).toBeDefined()
    expect(hit?.rest).toBe('')
  })

  it('支持子路径：`/wallpaper` 能接住 `/wallpaper/a/b`', () => {
    const routes = createPluginRouteRegistry()
    routes.register({ pluginId: 'a.b', path: '/wallpaper', handler: ok })
    const hit = routes.resolve('a.b', '/wallpaper/2024/x.mp4')
    expect(hit?.rest).toBe('2024/x.mp4')
  })

  it('最长前缀优先：同时注册粗/细粒度时选更具体的', () => {
    const routes = createPluginRouteRegistry()
    const coarse = (): Response => new Response('coarse')
    const fine = (): Response => new Response('fine')
    routes.register({ pluginId: 'a.b', path: '/media', handler: coarse })
    routes.register({ pluginId: 'a.b', path: '/media/thumb', handler: fine })
    expect(routes.resolve('a.b', '/media/thumb/1.png')?.handler).toBe(fine)
    expect(routes.resolve('a.b', '/media/full/1.png')?.handler).toBe(coarse)
  })

  it('插件之间隔离：A 的路由不会被 B 命中', () => {
    const routes = createPluginRouteRegistry()
    routes.register({ pluginId: 'a.one', path: '/x', handler: ok })
    expect(routes.resolve('b.two', '/x')).toBeUndefined()
  })

  it('撤销器与 clear 都能移除路由', () => {
    const routes = createPluginRouteRegistry()
    const dispose = routes.register({ pluginId: 'a.b', path: '/x', handler: ok })
    dispose()
    expect(routes.resolve('a.b', '/x')).toBeUndefined()

    routes.register({ pluginId: 'a.b', path: '/y', handler: ok })
    routes.clear('a.b')
    expect(routes.resolve('a.b', '/y')).toBeUndefined()
  })

  it('同路径重复注册视为覆盖（热重载会再 activate 一次）', () => {
    const routes = createPluginRouteRegistry()
    const first = (): Response => new Response('1')
    const second = (): Response => new Response('2')
    routes.register({ pluginId: 'a.b', path: '/x', handler: first })
    routes.register({ pluginId: 'a.b', path: '/x', handler: second })
    expect(routes.resolve('a.b', '/x')?.handler).toBe(second)
    expect(routes.list().filter((entry) => entry.path === '/x')).toHaveLength(1)
  })

  /*
   * 路径校验：`..` 与协议相对写法（`//host`）必须拒绝，
   * 否则插件能注册一条会吃掉别人路径的路由。
   */
  it.each(['', 'x', '//evil.com/a', '/a/../b', '/./a', '../x'])('拒绝非法路径：%j', (path) => {
    const routes = createPluginRouteRegistry()
    expect(() => routes.register({ pluginId: 'a.b', path, handler: ok })).toThrow()
  })

  it('必须带插件 id', () => {
    const routes = createPluginRouteRegistry()
    expect(() => routes.register({ pluginId: '', path: '/x', handler: ok })).toThrow()
  })
})
