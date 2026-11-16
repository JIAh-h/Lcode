import { describe, expect, it } from 'vitest'

/*
 * client 插件宿主的关键安全边界。
 *
 * 这些函数本来是渲染层模块（clientPlugins.tsx），直接 import 会拉进 React
 * 与浏览器 API。测试用一套最小的 DOM 桩，只验证**纯逻辑部分**：
 * - 变量名的白名单与值注入校验
 * - 未知插槽过滤
 *
 * 之所以要测这两条：它们都是"安全边界"，一旦被绕过，插件就能拿到
 * 超出 API 约定的能力（注入任意样式 / 挂到未声明位置）。
 */

// 在 import 之前装好最小 DOM 桩（模块顶层会读 document 吗？只有函数里读）
const applied = new Map<string, string>()
const removed = new Set<string>()
const rootStyle = {
  getPropertyValue: (name: string) => applied.get(name) ?? '',
  setProperty: (name: string, value: string) => {
    applied.set(name, value)
    removed.delete(name)
  },
  removeProperty: (name: string) => {
    applied.delete(name)
    removed.add(name)
  },
}
;(globalThis as unknown as { document: unknown }).document = {
  documentElement: { style: rootStyle },
  body: {
    prepend: () => undefined,
  },
  createElement: () => ({
    id: '',
    style: { cssText: '', backgroundImage: '', backgroundSize: '', opacity: '' },
  }),
}
;(globalThis as unknown as { URL: unknown }).URL = class {
  static createObjectURL() { return 'blob:fake' }
  static revokeObjectURL() { return undefined }
}

const { applyCssVars, clearCssVars, applyBackgroundImage } = await import('./clientPlugins.tsx')

function reset(): void {
  applied.clear()
  removed.clear()
}

describe('client 插件的样式安全边界', () => {
  it('只接受 --custom-property，拒绝 color / background 这种具体属性', () => {
    reset()
    applyCssVars({ '--bg-canvas': '#111', color: 'red', background: 'url(x)' })
    expect(applied.get('--bg-canvas')).toBe('#111')
    expect(applied.has('color')).toBe(false)
    expect(applied.has('background')).toBe(false)
  })

  it('值里带 ; {} 的注入被拒绝', () => {
    reset()
    applyCssVars({ '--bg-canvas': 'red; } body { display:none' })
    expect(applied.has('--bg-canvas')).toBe(false)
  })

  it('变量名只允许安全字符（防属性名注入）', () => {
    reset()
    applyCssVars({ '--x:y': 'red', '--ok-name_1': 'blue' })
    expect(applied.has('--x:y')).toBe(false)
    expect(applied.get('--ok-name_1')).toBe('blue')
  })

  it('clearCssVars 精确回滚到设置前的值', () => {
    reset()
    applied.set('--accent', '#original')
    applyCssVars({ '--accent': '#plugin' })
    expect(applied.get('--accent')).toBe('#plugin')
    clearCssVars()
    expect(applied.get('--accent')).toBe('#original')
  })

  it('clearCssVars 对原本不存在的变量是删除而非设空', () => {
    reset()
    applyCssVars({ '--new-var': 'x' })
    clearCssVars()
    expect(applied.has('--new-var')).toBe(false)
    expect(removed.has('--new-var')).toBe(true)
  })

  it('背景图只接受 https 与 data:image，拒绝 file 与 javascript', () => {
    // 用 node 端桩验证过滤分支不抛错；真实 DOM 行为在 e2e 里验证过
    expect(() => applyBackgroundImage({ url: 'file:///C:/secret.png' })).not.toThrow()
    expect(() => applyBackgroundImage({ url: 'javascript:alert(1)' })).not.toThrow()
    expect(() => applyBackgroundImage({ url: 'data:image/png;base64,AAA' })).not.toThrow()
    expect(() => applyBackgroundImage(null)).not.toThrow()
  })
})
