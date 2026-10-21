import { InMemoryAgentStore } from '@lcode/agent'
import { createContext } from '@lcode/context'
import { describe, expect, it } from 'vitest'
import { registerAutoCompactionPolicy } from './index.ts'

describe('compaction-policy', () => {
  it('没有显式摘要器时只记录候选，绝不隐式调用模型或压缩服务', async () => {
    const ctx = createContext()
    const session = { length: 12, events: () => [], deriveMessages: () => [] } as never
    ctx.set('agents', { get: () => ({ sessionId: 's1' }) } as unknown as InMemoryAgentStore)
    ctx.set('contextBudget', { inspect: () => ({ status: 'summary-candidate', measurement: { revision: 12, surfaceTokens: 9_000, systemTokens: 0, toolSchemaTokens: 0, total: 9_000, observedInputTokens: 0, observedOutputTokens: 0 } }) } as never)
    ctx.set('compaction', { compact: () => { throw new Error('must not compact') } } as never)
    const dispose = registerAutoCompactionPolicy({ ctx, sessionOf: () => session })
    await ctx.emit('agent/pre-step', { agentId: 'a1', turn: 1, nextStep: 1 })
    expect(ctx.get('autoCompaction').inspect('s1')).toMatchObject({ state: 'deferred-no-summarizer' })
    dispose()
  })

  it('显式摘要器只对同一 revision 尝试一次，并提交 threshold 事务', async () => {
    const ctx = createContext()
    const session = { length: 12, events: () => [], deriveMessages: () => [] } as never
    let compacted = 0
    ctx.set('agents', { get: () => ({ sessionId: 's1' }) } as never)
    ctx.set('contextBudget', { inspect: () => ({ status: 'summary-candidate', measurement: { revision: 12, surfaceTokens: 9_000, systemTokens: 0, toolSchemaTokens: 0, total: 9_000, observedInputTokens: 0, observedOutputTokens: 0 } }) } as never)
    ctx.set('compaction', {
      compact: (input: { trigger?: string }) => {
        compacted++
        expect(input.trigger).toBe('threshold')
        return { status: 'compacted', originalChars: 100, summaryChars: 10, shadowedSeqs: [] }
      },
    } as never)
    const dispose = registerAutoCompactionPolicy({ ctx, sessionOf: () => session, summarize: () => 'short summary' })
    await ctx.emit('agent/pre-step', { agentId: 'a1', turn: 1, nextStep: 1 })
    await ctx.emit('agent/pre-step', { agentId: 'a1', turn: 1, nextStep: 2 })
    expect(compacted).toBe(1)
    expect(ctx.get('autoCompaction').inspect('s1')).toMatchObject({ state: 'attempted', result: { status: 'compacted' } })
    dispose()
  })
})
