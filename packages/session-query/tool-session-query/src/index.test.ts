import { describe, expect, it } from 'vitest'
import { createSessionSearchTool, type SessionSearchHit } from './index.ts'

const hits: readonly SessionSearchHit[] = [
  { session_id: 'self', title: '当前会话', updated_at: 1, role: 'assistant', summary: '当前会话里的内容' },
  { session_id: 'other-1', title: '上次排查缓存', updated_at: 1700000000000, role: 'assistant', summary: '缓存命中率低是因为时间戳每步都在变' },
  { session_id: 'other-2', title: '另一个会话', updated_at: 1700000000000, role: 'user', summary: 'x'.repeat(500) },
]

function toolWith(overrides: { readonly hits?: readonly SessionSearchHit[]; readonly fail?: boolean } = {}) {
  return createSessionSearchTool({
    search: async () => {
      if (overrides.fail === true) throw new Error('boom')
      return overrides.hits ?? hits
    },
  })
}

describe('tool-session-query', () => {
  it('排除调用者自身的会话（它的历史已在上下文里）', async () => {
    const tool = toolWith()
    const result = (await tool.execute(
      { callId: 'c1', parsed: { query: '缓存' }, raw: {} } as never,
      { signal: new AbortController().signal, scope: { sessionId: 'self' } } as never,
    )) as { ok: true; value: { matches: { session: string }[] } }
    expect(result.ok).toBe(true)
    expect(result.value.matches.map((m) => m.session)).toEqual(['other-1', 'other-2'])
  })

  it('长片段被截断，避免一条命中吃掉大段上下文', async () => {
    const tool = toolWith()
    const result = (await tool.execute(
      { callId: 'c1', parsed: { query: 'x' }, raw: {} } as never,
      { signal: new AbortController().signal, scope: { sessionId: 'self' } } as never,
    )) as { ok: true; value: { matches: { snippet: string }[] } }
    const long = result.value.matches.find((m) => m.snippet.includes('…'))
    expect(long).toBeDefined()
    expect(long?.snippet.length).toBeLessThan(400)
  })

  it('limit 被夹在 1~20 之间', async () => {
    const captured: number[] = []
    const tool = createSessionSearchTool({
      search: async (input) => {
        captured.push(input.limit ?? -1)
        return hits
      },
    })
    await tool.execute({ callId: 'c1', parsed: { query: 'a', limit: 999 }, raw: {} } as never, { signal: new AbortController().signal, scope: {} } as never)
    await tool.execute({ callId: 'c2', parsed: { query: 'a', limit: 0 }, raw: {} } as never, { signal: new AbortController().signal, scope: {} } as never)
    // 传入的是 limit*2（多取以免排除自身后不够），上限 40
    expect(captured[0]).toBe(40)
    expect(captured[1]).toBe(2)
  })

  it('空 query 直接拒绝，不触发检索', async () => {
    let called = false
    const tool = createSessionSearchTool({
      search: async () => {
        called = true
        return []
      },
    })
    const result = (await tool.execute(
      { callId: 'c1', parsed: { query: '   ' }, raw: {} } as never,
      { signal: new AbortController().signal, scope: {} } as never,
    )) as { ok: false }
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('没有命中时给出改写提示，而不是空数组让模型瞎猜', async () => {
    const tool = toolWith({ hits: [] })
    const result = (await tool.execute(
      { callId: 'c1', parsed: { query: 'zzz' }, raw: {} } as never,
      { signal: new AbortController().signal, scope: {} } as never,
    )) as { ok: true; value: { matches: unknown[]; hint?: string } }
    expect(result.value.matches).toEqual([])
    expect(result.value.hint).toContain('关键词')
  })
})
