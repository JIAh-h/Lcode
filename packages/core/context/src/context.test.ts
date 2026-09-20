import { describe, expect, it, vi } from 'vitest'
import { Context, createContext } from './context.ts'
import { EventBus } from './events.ts'

describe('Context services and effects', () => {
  it('支持全局/作用域服务、覆盖和撤销', () => {
    const ctx = createContext()
    expect(() => ctx.get('missing-service' as never)).toThrow()
    expect(ctx.has('missing-service')).toBe(false)
    const scopedOnly = ctx.set('scoped-only' as never, { id: 'scoped' } as never, { scope: 'agent' })
    expect(ctx.has('scoped-only', 'other')).toBe(false)
    scopedOnly()
    const global = { id: 'global' }
    const scoped = { id: 'scoped' }
    const removeGlobal = ctx.set('test-service' as never, global as never)
    const removeScoped = ctx.set('test-service' as never, scoped as never, { scope: 'agent' })

    expect(ctx.has('test-service')).toBe(true)
    expect(ctx.get('test-service' as never)).toBe(global)
    expect(ctx.get('test-service' as never, 'agent' as never)).toBe(scoped)
    const replacement = { id: 'replacement' }
    const removeReplacement = ctx.set('test-service' as never, replacement as never, { scope: 'agent' })
    removeScoped()
    removeScoped()
    expect(ctx.get('test-service' as never, 'agent' as never)).toBe(replacement)
    removeReplacement()
    expect(ctx.get('test-service' as never, 'agent' as never)).toBe(global)
    removeGlobal()
    expect(ctx.has('test-service')).toBe(false)
    expect(() => ctx.get('test-service' as never)).toThrow()
  })

  it('转发事件模式并执行 effect', async () => {
    const ctx = new Context()
    const seen: unknown[] = []
    ctx.on('test-event' as never, (payload) => {
      seen.push(payload)
    })
    await ctx.emit('test-event' as never, { ok: true } as never)
    await ctx.emitParallel('test-event' as never, { parallel: true } as never)
    await expect(ctx.emitSerial('other-event' as never, 1 as never)).resolves.toBe(1)
    await expect(ctx.waterfall('other-event' as never, 'input' as never)).resolves.toBe('input')
    const disposer = ctx.effect((current) => {
      expect(current).toBe(ctx)
      return () => {
        seen.push('disposed')
      }
    }, 'scope' as never)
    disposer()
    expect(seen).toContain('disposed')
  })
})

describe('EventBus', () => {
  it('按顺序广播、按作用域过滤，并支持撤销', async () => {
    const bus = new EventBus()
    const seen: string[] = []
    const dispose = bus.on('event', () => {
      seen.push('global')
    })
    bus.on(
      'event',
      () => {
        seen.push('scoped')
      },
      'scope',
    )
    await bus.emit('event', null)
    await bus.emit('event', null, 'scope')
    dispose()
    await bus.emit('event', null)
    expect(seen).toEqual(['global', 'scoped', 'global', 'scoped', 'scoped'])
  })

  it('parallel 包含失败，serial 传递累积值，waterfall 支持短路与 noop', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    bus.on('parallel', async () => {
      calls.push('bad')
      throw new Error('expected')
    })
    bus.on('parallel', () => {
      calls.push('good')
    })
    await bus.emitParallel('parallel', null)
    expect(calls).toEqual(['bad', 'good'])

    bus.on('serial', ((value: number, index: number) => value + index + 1) as never)
    bus.on('serial', ((value: number, index: number) => value + index + 1) as never)
    await expect(bus.emitSerial<number, number>('serial', 0)).resolves.toBe(3)

    bus.on('waterfall', (async (value: unknown, next: () => Promise<unknown>) => `${value}:first:${await next()}`) as never)
    bus.on('waterfall', (value: unknown) => `${value}:second` as never)
    await expect(bus.waterfall('waterfall', 'x')).resolves.toBe('x:first:x:second')
    await expect(bus.waterfall('empty', 'fallback', undefined, async () => 'noop')).resolves.toBe('noop')
    vi.restoreAllMocks()
  })
})
