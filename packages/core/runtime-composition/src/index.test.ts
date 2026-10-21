import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { composeRuntimeProfile, RuntimeCompositionError, type RuntimeProfile } from './index.ts'

describe('runtime composition', () => {
  it('按依赖顺序挂载，并生成不含运行时句柄的快照', async () => {
    const ctx = createContext()
    const seen: string[] = []
    const profile: RuntimeProfile = {
      id: 'test',
      bundles: [
        {
          id: 'consumer',
          requires: ['base'],
          provides: ['consumer'],
          mount(current) {
            seen.push(`consumer:${current.has('base')}`)
            const remove = current.set('consumer' as never, { ok: true } as never)
            return () => { seen.push('dispose:consumer'); remove() }
          },
        },
        {
          id: 'base',
          provides: ['base'],
          mount(current) {
            seen.push('base')
            const remove = current.set('base' as never, { ok: true } as never)
            return () => { seen.push('dispose:base'); remove() }
          },
        },
      ],
    }

    const composition = await composeRuntimeProfile(ctx, profile)
    expect(seen).toEqual(['base', 'consumer:true'])
    expect(composition.snapshot).toEqual({
      profile: 'test',
      entries: [
        { id: 'base', provides: ['base'], adopts: [], requires: [] },
        { id: 'consumer', provides: ['consumer'], adopts: [], requires: ['base'] },
      ],
    })
    await composition.dispose()
    await composition.dispose()
    expect(seen).toEqual(['base', 'consumer:true', 'dispose:consumer', 'dispose:base'])
  })

  it('在 mount 前拒绝缺失或重复 provider', async () => {
    const ctx = createContext()
    await expect(composeRuntimeProfile(ctx, {
      id: 'missing',
      bundles: [{ id: 'consumer', requires: ['missing'], provides: [], mount: () => () => {} }],
    })).rejects.toMatchObject({ code: 'EC_COMPOSITION_MISSING' } satisfies Partial<RuntimeCompositionError>)

    await expect(composeRuntimeProfile(ctx, {
      id: 'duplicate',
      bundles: [
        { id: 'one', provides: ['same'], mount: () => () => {} },
        { id: 'two', provides: ['same'], mount: () => () => {} },
      ],
    })).rejects.toMatchObject({ code: 'EC_COMPOSITION_DUPLICATE' } satisfies Partial<RuntimeCompositionError>)
  })

  it('在 provider 未实际注册或后续 mount 失败时逆序回滚', async () => {
    const ctx = createContext()
    const disposed: string[] = []
    await expect(composeRuntimeProfile(ctx, {
      id: 'rollback',
      bundles: [
        {
          id: 'base',
          provides: ['base'],
          mount(current) {
            const remove = current.set('base' as never, true as never)
            return () => { disposed.push('base'); remove() }
          },
        },
        {
          id: 'bad',
          requires: ['base'],
          provides: ['bad'],
          mount: () => { throw new Error('boom') },
        },
      ],
    })).rejects.toThrow('boom')
    expect(disposed).toEqual(['base'])
    expect(ctx.has('base')).toBe(false)

    await expect(composeRuntimeProfile(createContext(), {
      id: 'lying-provider',
      bundles: [{ id: 'bad', provides: ['never'], mount: () => () => {} }],
    })).rejects.toMatchObject({ code: 'EC_COMPOSITION_PROVIDER' } satisfies Partial<RuntimeCompositionError>)
  })

  it('允许可信 entry 接管装配前已存在的宿主服务，但不能覆盖或伪造它', async () => {
    const ctx = createContext()
    const unregister = ctx.set('base' as never, { host: true } as never)
    const composition = await composeRuntimeProfile(ctx, {
      id: 'host-adoption',
      bundles: [{
        id: 'model-local',
        adopts: ['base'],
        provides: [],
        requires: ['base'],
        mount: (current) => {
          expect(current.get('base' as never)).toEqual({ host: true })
          return () => {}
        },
      }],
    })
    expect(composition.snapshot.entries).toEqual([
      { id: 'model-local', provides: [], adopts: ['base'], requires: ['base'] },
    ])
    await composition.dispose()
    expect(ctx.get('base' as never)).toEqual({ host: true })
    unregister()

    await expect(composeRuntimeProfile(createContext(), {
      id: 'missing-adoption',
      bundles: [{ id: 'model-local', adopts: ['base'], provides: [], mount: () => () => {} }],
    })).rejects.toMatchObject({ code: 'EC_COMPOSITION_MISSING' } satisfies Partial<RuntimeCompositionError>)
  })
})
