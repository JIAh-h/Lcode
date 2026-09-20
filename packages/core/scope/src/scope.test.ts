import { describe, expect, it } from 'vitest'
import { createScopedLayers, collectScopeChain, ScopedLayersImpl } from './scope.ts'

describe('ScopedLayers', () => {
  it('按全局、父作用域、子作用域叠加，并支持精确撤销', () => {
    const parent = { parent: undefined } as unknown as string
    const child = { parent } as unknown as string
    const layers = createScopedLayers<{ color: string; size: number }>()
    const removeGlobal = layers.layer(undefined, { color: 'global', size: 1 })
    layers.layer(parent, { color: 'parent' })
    const removeChild = layers.layer(child, { color: 'child' })

    expect(layers.get(child)).toEqual({ color: 'child', size: 1 })
    removeChild()
    expect(layers.get(child)).toEqual({ color: 'parent', size: 1 })
    removeGlobal()
    expect(layers.get(child)).toEqual({ color: 'parent' })
  })

  it('空层返回 undefined，重复撤销安全，作用域环不会死循环', () => {
    const layers = new ScopedLayersImpl<{ value: string }>()
    expect(layers.get(undefined)).toBeUndefined()
    const loop = {} as { parent?: unknown } as unknown as string
    ;(loop as unknown as { parent: string }).parent = loop
    const remove = layers.layer(loop, { value: 'x' })
    expect(collectScopeChain(loop)).toHaveLength(2)
    expect(layers.get(loop)).toEqual({ value: 'x' })
    remove()
    remove()
    expect(layers.get(loop)).toBeUndefined()
  })
})
