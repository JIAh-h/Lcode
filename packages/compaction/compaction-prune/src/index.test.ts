import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { createCompactionPrune, registerCompactionPrune } from './index.ts'

function toolResult(store: InMemorySessionStore, text: string): number {
  return store.append({
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'call-1', content: text, isError: false } },
  }).seq
}

describe('compaction-prune', () => {
  it('只追加 replace，原始工具输出保留在事实日志中', () => {
    const store = new InMemorySessionStore(asSessionId('prune-test'))
    const sourceSeq = toolResult(store, 'a'.repeat(200))
    const result = createCompactionPrune(80).prune({ session: store, sourceEventSeq: sourceSeq, toolName: 'shell' })

    expect(result.status).toBe('pruned')
    expect(store.events()).toHaveLength(2)
    expect(store.events()[0]).toMatchObject({ type: 'tool/result', data: { message: { content: 'a'.repeat(200) } } })
    expect(store.events()[1]).toMatchObject({ type: 'tool/result', sourceEventSeqs: [0], surfaceOp: { op: 'replace', start: 0, end: 1 } })
    expect(store.deriveMessages()[0]).toMatchObject({ content: expect.stringContaining('characters omitted') })
  })

  it('read 输出和短输出永远不被处理', async () => {
    const ctx = createContext()
    const unregister = registerCompactionPrune({ ctx, thresholdChars: 20 })
    const store = new InMemorySessionStore(asSessionId('read-skip'))
    const sourceSeq = toolResult(store, 'a'.repeat(100))
    const appended = store.events()[0]!
    if (appended.type !== 'tool/result') throw new Error('expected tool/result event')
    await ctx.emit('agent/tool-result-appended', {
      agentId: 'a1', sessionId: 'read-skip', session: store, sourceEventSeq: sourceSeq,
      tool: { callId: 'call-1', name: 'read' }, message: appended.data.message as never,
    })
    expect(store.events()).toHaveLength(1)
    unregister()
  })
})
