import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { createLocalCompactionSummary } from '@lcode/compaction-summary'

function session() {
  const store = new InMemorySessionStore(asSessionId('compaction-test'))
  store.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'First long message with details.' }] } })
  store.append({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Second long answer with more details.' }] } } })
  store.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Keep this newest request.' }] } })
  return store
}

describe('P7-02 local compaction', () => {
  it('以持久事务追加 replace，保留原始事件和完整遮蔽血缘', () => {
    const store = session()
    const result = createLocalCompactionSummary().compact({ session: store, summary: 'Earlier discussion summary.', start: 0, end: 2 })
    expect(result).toMatchObject({ status: 'compacted', shadowedSeqs: [0, 1] })
    const events = store.events()
    expect(events.map((event) => event.type)).toEqual([
      'user/message', 'assistant/message', 'user/message',
      'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
    ])
    const replacement = events.at(-2)
    expect(replacement).toMatchObject({
      compactionId: result.compactionId,
      shadowedSeqs: [0, 1],
      sourceEventSeqs: [0, 1],
      surfaceOp: { op: 'replace', start: 0, end: 2 },
    })
    expect(store.deriveMessages().map((message) => JSON.stringify(message))).toEqual([
      expect.stringContaining('Earlier discussion summary.'),
      expect.stringContaining('Keep this newest request.'),
    ])
  })

  it('第二次压缩按当前可见表面定位，不会重用被遮蔽的原始事件', () => {
    const store = session()
    const compact = createLocalCompactionSummary()
    expect(compact.compact({ session: store, summary: 'Earlier summary.', start: 0, end: 2 }).status).toBe('compacted')
    expect(compact.compact({ session: store, summary: 'All work so far.', start: 0, end: 2 }).status).toBe('compacted')
    expect(store.deriveMessages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[Conversation summary]\nAll work so far.' }] },
    ])
  })

  it('完整的工具调用事务可以压缩，拆散配对仍然拒绝', () => {
    const store = new InMemorySessionStore(asSessionId('tool-compaction'))
    store.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '旧目标：先读文件。' }] } })
    store.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }] } },
    })
    store.append({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } })
    store.append({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'c1', content: 'file content', isError: false } },
    })
    store.append({
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '读完了。' }] } },
    })
    store.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '保留的新问题。' }] } })

    const compact = createLocalCompactionSummary()
    // 表面：user / assistant(tool_use) / tool result / assistant / user
    // 旧实现只要见到 tool result 就拒绝，导致真实会话几乎永远没有可压区间
    expect(compact.compact({ session: store, summary: '旧轮已读 a.ts。', start: 0, end: 4 })).toMatchObject({ status: 'compacted' })
    expect(store.deriveMessages().map((message) => JSON.stringify(message))).toEqual([
      expect.stringContaining('旧轮已读 a.ts。'),
      expect.stringContaining('保留的新问题。'),
    ])

    const split = session()
    split.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c9', name: 'read', input: {} }] } },
    })
    split.append({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{}' } })
    split.append({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'c9', content: 'x', isError: false } },
    })
    // 起点落在 tool result 上：调用在区间外、结果在区间内
    expect(createLocalCompactionSummary().compact({ session: split, summary: '拆散', start: 3, end: 4 }).status).toBe('tool-boundary')
  })

  it('无收益、未闭合事务均 fail-closed', () => {
    const noBenefit = session()
    expect(createLocalCompactionSummary().compact({ session: noBenefit, summary: 'x'.repeat(1_000), start: 0, end: 2 }).status).toBe('not-beneficial')

    const active = session()
    active.append({ type: 'compaction/start', data: { compactionId: 'active', trigger: 'manual' } })
    expect(createLocalCompactionSummary().compact({ session: active, summary: 'short', start: 0, end: 2 }).status).toBe('active-transaction')
  })
})
