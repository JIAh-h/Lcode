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

  it('无收益、工具边界和未闭合事务均 fail-closed', () => {
    const noBenefit = session()
    expect(createLocalCompactionSummary().compact({ session: noBenefit, summary: 'x'.repeat(1_000), start: 0, end: 2 }).status).toBe('not-beneficial')

    const active = session()
    active.append({ type: 'compaction/start', data: { compactionId: 'active', trigger: 'manual' } })
    expect(createLocalCompactionSummary().compact({ session: active, summary: 'short', start: 0, end: 2 }).status).toBe('active-transaction')
  })
})
