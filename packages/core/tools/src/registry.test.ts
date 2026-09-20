import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { InMemoryToolRegistry } from './registry.ts'
import type { ToolCall, ToolDefinition } from './types.ts'

const schema = { type: 'object' as const, properties: { value: { type: 'string' } }, required: ['value'] }
const call = (name: string, args = '{"value":"ok"}'): ToolCall => ({ callId: 'c1', name, arguments: args })
const opts = { signal: new AbortController().signal }

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'echo',
    description: 'echo',
    inputSchema: schema,
    execute: ({ parsed }) => parsed,
    ...overrides,
  }
}

describe('InMemoryToolRegistry', () => {
  it('注册、schema、收窄和撤销', () => {
    const registry = new InMemoryToolRegistry(createContext())
    const remove = registry.register(tool())
    expect(registry.schemas()).toHaveLength(1)
    expect(() => registry.register(tool())).toThrow()
    const removeRestrict = registry.restrict([])
    expect(registry.schemas()).toEqual([])
    removeRestrict()
    expect(registry.schemas()).toHaveLength(1)
    remove()
    expect(registry.schemas()).toEqual([])
  })

  it('将未知工具、不可见工具、坏 JSON 和坏参数转成结果', async () => {
    const registry = new InMemoryToolRegistry(createContext())
    registry.register(tool())
    for (const [request, code] of [
      [call('missing'), ERROR_CODES.ET_UNKNOWN_TOOL],
      [call('echo', '{'), ERROR_CODES.ET_INVALID_ARGS],
      [call('echo', 'x'.repeat(100)), ERROR_CODES.ET_INVALID_ARGS],
      [call('echo', '[]'), ERROR_CODES.ET_INVALID_ARGS],
      [call('echo', '{}'), ERROR_CODES.ET_INVALID_ARGS],
    ] as const) {
      await expect(registry.execute(request, opts)).resolves.toMatchObject({ ok: false, error: { code } })
    }
    const remove = registry.restrict([])
    await expect(registry.execute(call('echo'), opts)).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.ET_UNKNOWN_TOOL } })
    remove()
  })

  it('执行审批、守卫和成功事件链', async () => {
    const ctx = createContext()
    const registry = new InMemoryToolRegistry(ctx)
    const events: string[] = []
    ctx.on('tools/execute', () => {
      events.push('execute')
    })
    ctx.on('tools/post-execute', () => {
      events.push('post')
    })
    registry.register(
      tool({
        describeAction: () => ({ summary: 'echo' }),
        execute: async ({ parsed }) => ({ result: parsed }),
      }),
    )
    ctx.on('tools/pre-execute', (payload) => {
      expect(payload.intent?.summary).toBe('echo')
    })
    const removeGuard = registry.guard(async (): Promise<'abstain'> => 'abstain')
    await expect(registry.execute(call('echo'), opts)).resolves.toMatchObject({ ok: true, value: { result: { value: 'ok' } } })
    expect(events).toEqual(['execute', 'post'])
    removeGuard()
    await expect(registry.execute(call('echo'), opts)).resolves.toMatchObject({ ok: true })
  })

  it('将卡片类型与纯展示元数据写入结果快照', async () => {
    const registry = new InMemoryToolRegistry(createContext())
    registry.register(
      tool({
        card: 'read',
        presentationMeta: (_args, value) => ({ path: (value as { value: string }).value }),
        execute: () => ({ value: 'src/a.ts' }),
      }),
    )
    expect(registry.card?.('echo')).toBe('read')
    await expect(registry.execute(call('echo'), opts)).resolves.toMatchObject({
      ok: true,
      meta: { card: 'read', path: 'src/a.ts' },
    })
  })

  it('展示元数据失败时不影响工具成功，且能封装非对象展示值', async () => {
    const throwing = new InMemoryToolRegistry(createContext())
    throwing.register(
      tool({
        card: 'read',
        presentationMeta: () => {
          throw new Error('展示投影失败')
        },
      }),
    )
    await expect(throwing.execute(call('echo'), opts)).resolves.toMatchObject({
      ok: true,
      meta: { card: 'read' },
    })

    const invalid = new InMemoryToolRegistry(createContext())
    invalid.register(tool({ card: 'read', presentationMeta: () => undefined as never }))
    await expect(invalid.execute(call('echo'), opts)).resolves.toMatchObject({
      ok: true,
      meta: { card: 'read' },
    })

    const primitive = new InMemoryToolRegistry(createContext())
    primitive.register(tool({ presentationMeta: () => '简短摘要' }))
    await expect(primitive.execute(call('echo'), opts)).resolves.toMatchObject({
      ok: true,
      meta: { card: 'generic', value: '简短摘要' },
    })

    const recordMeta = new InMemoryToolRegistry(createContext())
    recordMeta.register(tool({ presentationMeta: () => ({ path: 'src/a.ts' }) }))
    await expect(recordMeta.execute(call('echo'), opts)).resolves.toMatchObject({
      ok: true,
      meta: { path: 'src/a.ts' },
    })
  })

  it('拒绝审批或守卫，校验非法输出和执行异常', async () => {
    const ctx = createContext()
    const registry = new InMemoryToolRegistry(ctx)
    registry.register(tool({ describeAction: () => ({ summary: 'blocked' }) }))
    ctx.on('tools/pre-execute', (payload) => {
      payload.deny = 'approval denied'
    })
    await expect(registry.execute(call('echo'), opts)).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.ET_DENIED } })

    const guarded = new InMemoryToolRegistry(createContext())
    guarded.register(tool())
    guarded.guard(() => 'deny')
    await expect(guarded.execute(call('echo'), opts)).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.ET_DENIED } })

    const badOutput = new InMemoryToolRegistry(createContext())
    badOutput.register(tool({ execute: () => undefined as never }))
    await expect(badOutput.execute(call('echo'), opts)).resolves.toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.ET_INVALID_OUTPUT },
    })

    const lcode = new InMemoryToolRegistry(createContext())
    lcode.register(
      tool({
        execute: () => {
          throw new LcodeErrorImpl({ code: ERROR_CODES.ET_TIMEOUT, message: 'timeout', userMessage: 'timeout' })
        },
      }),
    )
    await expect(lcode.execute(call('echo'), opts)).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.ET_TIMEOUT } })

    const coded = new InMemoryToolRegistry(createContext())
    coded.register(
      tool({
        execute: () => {
          throw Object.assign(new Error('coded'), { code: ERROR_CODES.ET_ABORTED })
        },
      }),
    )
    await expect(coded.execute(call('echo'), opts)).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.ET_ABORTED } })

    const unknown = new InMemoryToolRegistry(createContext())
    unknown.register(
      tool({
        execute: () => {
          throw 'plain failure'
        },
      }),
    )
    await expect(unknown.execute(call('echo'), opts)).resolves.toMatchObject({ ok: false, error: { code: ERROR_CODES.ET_ERROR } })
  })
})
