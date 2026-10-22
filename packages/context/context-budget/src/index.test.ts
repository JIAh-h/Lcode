import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { estimateTokens, measure } from './index.ts'

const tools = [{ name: 'read', description: 'read file', inputSchema: { type: 'object', properties: {} } }] as const

describe('context-budget', () => {
  it('把当前表面、system、工具 schema 与已返回 usage 分开计量', () => {
    const session = new InMemorySessionStore(asSessionId('budget'))
    session.append({ type: 'user/message', data: { role: 'user', content: '请检查项目。' } })
    session.append({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已检查。' }] }, usage: { input: 21, output: 8 } } })
    const snapshot = measure({ session, system: 'stable system', tools: [...tools] })
    expect(snapshot).toMatchObject({ revision: 2, observedInputTokens: 21, observedOutputTokens: 8, providerTotal: 29, providerDeltaTokens: 0 })
    expect(snapshot.total).toBe(snapshot.surfaceTokens + snapshot.systemTokens + snapshot.toolSchemaTokens)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('usage 之后新增的消息按估算补进实测基线', () => {
    const session = new InMemorySessionStore(asSessionId('budget-delta'))
    session.append({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] }, usage: { input: 100, output: 10 } } })
    session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '新的提问' }] } })
    const snapshot = measure({ session, system: 's', tools: [] })
    expect(snapshot.providerTotal).toBe(110 + (snapshot.providerDeltaTokens ?? 0))
    expect(snapshot.providerDeltaTokens).toBeGreaterThan(0)
  })

  it('压缩会改写表面，旧 usage 基线随即作废', () => {
    const session = new InMemorySessionStore(asSessionId('budget-compacted'))
    session.append({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] }, usage: { input: 100, output: 10 } } })
    session.append({ type: 'compaction/start', data: { compactionId: 'c1', trigger: 'manual' } })
    session.append({ type: 'compaction/end', data: { compactionId: 'c1', outcome: 'completed' } })
    expect(measure({ session, system: 's', tools: [] }).providerTotal).toBeUndefined()
  })

  it('没有 usage 或输入为 0 时不做实测声明', () => {
    const session = new InMemorySessionStore(asSessionId('budget-no-usage'))
    session.append({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } } })
    expect(measure({ session, system: 's', tools: [] }).providerTotal).toBeUndefined()
  })

  it('CJK 按字计，ASCII 按约 3.5 字符/token 估算', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcd')).toBe(2)
  })
})
