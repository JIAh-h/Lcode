import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { createCompactionPrune } from './index.ts'

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

  /*
   * read 输出与短输出永不处理。
   *
   * prune 已改为**按需调用**（docs/09 §3.2.5）：不再监听每结果事件主动触发，
   * 因为每结果替换会改写下一步请求的历史，让提供方前缀缓存从那个位置起失效。
   * 所以这里直接调 service.prune 断言行为，而不是 emit 事件。
   */
  it('read 输出和短输出永远不被处理', () => {
    const store = new InMemorySessionStore(asSessionId('read-skip'))
    const readSeq = store.append({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'read-1', content: 'a'.repeat(100), isError: false } },
    }).seq
    const shortSeq = store.append({
      type: 'tool/result',
      data: { turn: 1, step: 2, message: { role: 'user', toolCallId: 'grep-1', content: '短结果', isError: false } },
    }).seq
    const prune = createCompactionPrune(20)
    expect(prune.prune({ session: store, sourceEventSeq: readSeq, toolName: 'read' }).status).toBe('not-applicable')
    expect(prune.prune({ session: store, sourceEventSeq: shortSeq, toolName: 'grep' }).status).toBe('not-applicable')
    expect(store.events()).toHaveLength(2)
  })
})
