import { describe, expect, it } from 'vitest'
import type { Context } from '@lcode/context'
import { createContext } from '@lcode/context'
import { composeRuntimeProfile, filterProfile, RuntimeCompositionError, type InternalBundleEntry, type RuntimeProfile } from './index.ts'

/**
 * 过滤 + 装配的组合测试。
 *
 * 关键断言：禁用一个能力后，依赖它的条目必须在**装配期**失败，
 * 而不是带着半套能力启动——后者更难排查（用户会以为功能坏了，
 * 其实是被禁用的连锁反应）。`composeRuntimeProfile` 已有的 requires
 * 检查应该天然覆盖这一点，这里验证它确实覆盖。
 */
/*
 * mount 必须**真的**把 provides 注册进 ctx，否则 composeRuntimeProfile 会在
 * mount 后校验失败（EC_COMPOSITION_PROVIDER）——这正是装配器的正确行为，
 * 测试桩要照做才能测到我们想测的那层。
 */
function providing(id: string, provides: string[], requires: string[] = []): InternalBundleEntry {
  return {
    id,
    provides,
    ...(requires.length > 0 ? { requires } : {}),
    mount: (ctx) => {
      const disposers = provides.map((key) => ctx.set(key as Parameters<typeof ctx.set>[0], { id } as never))
      return () => disposers.forEach((dispose) => dispose())
    },
  }
}

function makeProfile(): RuntimeProfile {
  return {
    id: 'test',
    bundles: [providing('base', ['baseSvc']), providing('dependent', ['dependentSvc'], ['baseSvc'])],
  }
}

describe('禁用内置能力后的装配行为', () => {
  it('不禁用时正常装配', async () => {
    const ctx: Context = createContext()
    const result = await composeRuntimeProfile(ctx, makeProfile())
    expect(result.snapshot.entries.map((item) => item.id)).toEqual(['base', 'dependent'])
    await result.dispose()
  })

  it('禁用被依赖的能力 → 装配期报缺依赖，而不是静默启动', async () => {
    const ctx: Context = createContext()
    const { profile } = filterProfile(makeProfile(), ['base'])
    let error: unknown
    try {
      await composeRuntimeProfile(ctx, profile)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RuntimeCompositionError)
    expect((error as RuntimeCompositionError).code).toBe('EC_COMPOSITION_MISSING')
    expect(String((error as Error).message)).toContain('baseSvc')
  })

  it('无依赖的条目被禁用后，其余仍正常装配', async () => {
    const ctx: Context = createContext()
    const p: RuntimeProfile = {
      id: 'test',
      bundles: [providing('a', ['A']), providing('b', ['B'])],
    }
    const { profile } = filterProfile(p, ['a'])
    const result = await composeRuntimeProfile(ctx, profile)
    expect(result.snapshot.entries.map((item) => item.id)).toEqual(['b'])
    await result.dispose()
  })
})
