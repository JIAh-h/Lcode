import { describe, expect, it } from 'vitest'
import type { Context } from '@lcode/context'
import type { InternalBundleEntry, RuntimeProfile } from '@lcode/runtime-composition'
import { applyBundleFilter, filterProfile, readDisabledBundles, DISABLED_PLUGINS_KEY } from './filter.ts'

function entry(id: string, provides: string[] = []): InternalBundleEntry {
  return { id, provides, mount: () => () => {} }
}

const profile: RuntimeProfile = {
  id: 'test',
  bundles: [entry('a', ['A']), entry('b', ['B']), entry('c', ['C'])],
}

function ctxWith(value: unknown): Context {
  return {
    has: (key: string) => key === 'settings',
    get: () => ({ get: () => (value === undefined ? undefined : { value, layer: 'user', source: 'test' }) }),
  } as unknown as Context
}

describe('bundle 过滤（配置驱动的内置能力开关）', () => {
  it('没配置时原样返回，且返回同一个 profile 对象（零开销）', () => {
    const result = filterProfile(profile, [])
    expect(result.removed).toEqual([])
    expect(result.profile).toBe(profile)
  })

  it('按 id 移除条目，不改原对象', () => {
    const result = filterProfile(profile, ['b'])
    expect(result.profile.bundles.map((item) => item.id)).toEqual(['a', 'c'])
    expect(result.removed).toEqual(['b'])
    // 原 profile 不变
    expect(profile.bundles.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('禁用不存在的 id 是空操作', () => {
    const result = filterProfile(profile, ['not-there'])
    expect(result.removed).toEqual([])
    expect(result.profile.bundles).toHaveLength(3)
  })

  it('可以一次禁用多个', () => {
    const result = filterProfile(profile, ['a', 'c'])
    expect(result.profile.bundles.map((item) => item.id)).toEqual(['b'])
    expect(result.removed).toEqual(['a', 'c'])
  })

  it('从 Context 读 plugins.disabled 配置', () => {
    expect(readDisabledBundles(ctxWith(['b', 'c']))).toEqual(['b', 'c'])
  })

  it('配置缺失 / 格式不对 → 当作没禁用（向后兼容）', () => {
    expect(readDisabledBundles(ctxWith(undefined))).toEqual([])
    expect(readDisabledBundles(ctxWith('b'))).toEqual([])
    expect(readDisabledBundles(ctxWith([1, null, ''] as unknown))).toEqual([])
  })

  it('设置服务不存在时不抛错', () => {
    const ctx = { has: () => false } as unknown as Context
    expect(readDisabledBundles(ctx)).toEqual([])
  })

  it('applyBundleFilter 支持注入读取函数（纯测试用法）', () => {
    const result = applyBundleFilter(ctxWith([]), profile, { readDisabled: () => ['a'] })
    expect(result.profile.bundles.map((item) => item.id)).toEqual(['b', 'c'])
  })

  it('配置键名固定，便于文档与设置页对齐', () => {
    expect(DISABLED_PLUGINS_KEY).toBe('plugins.disabled')
  })
})
