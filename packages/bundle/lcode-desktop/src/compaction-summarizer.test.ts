import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemoryAgentDefaultModelService } from '@lcode/agent-default-model'
import { InMemoryLlmRegistry } from '@lcode/llm'
import type { LlmAdapter } from '@lcode/llm'
import { InMemorySessionStore, deriveVisibleSurfaceItems } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { chooseCompactionRange, createModelCompactionSummarizer, renderTranscript } from './compaction-summarizer.ts'

function sessionWithHistory(): InMemorySessionStore {
  const session = new InMemorySessionStore(asSessionId('summarizer'))
  session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `旧目标：${'改代码'.repeat(700)}` }] } })
  session.append({
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已经改完 a.ts。' }] } },
  })
  session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '保留的新问题。' }] } })
  return session
}

describe('模型摘要器', () => {
  it('只切在用户提问之前，并保留最近上下文', () => {
    const session = sessionWithHistory()
    const plan = chooseCompactionRange(session, { keepRecentChars: 1 })
    expect(plan).toMatchObject({ start: 0, end: 2, keptItems: 1 })
    expect(plan?.prefixChars).toBeGreaterThan(1_500)

    // 只有一条提问：前面没有可压的东西
    const single = new InMemorySessionStore(asSessionId('single'))
    single.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_000) }] } })
    expect(chooseCompactionRange(single)).toBeUndefined()
  })

  it('摘要请求带 system 指令、不带工具，且只包含被压缩的前缀', async () => {
    const calls: { request: { body: unknown } }[] = []
    const adapter: LlmAdapter = {
      providerInfo: () => ({ id: 'fake', name: 'fake', capabilities: { streaming: true, reasoning: false, toolCalls: false } }),
      listModels: async () => [],
      resolveModel: async (selection) => ({ provider: 'fake', model: selection.model }),
      prepareCall: async (selection) => ({
        provider: 'fake',
        model: selection.model,
        ...(selection.params === undefined ? {} : { params: selection.params }),
        request: { endpoint: 'fake://', headers: {}, body: {} },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false },
      }),
      stream: async function* (call) {
        calls.push(call as unknown as { request: { body: unknown } })
        yield { type: 'text-delta', text: '旧轮摘要。' }
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '旧轮摘要。' }] } }
      },
      providerRetryPolicy: () => ({ maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false }),
    }

    const ctx = createContext()
    const llm = new InMemoryLlmRegistry()
    llm.register(adapter)
    ctx.set('llm', llm)
    const models = new InMemoryAgentDefaultModelService()
    await models.set({ provider: 'fake', model: 'small' })
    ctx.set('agentDefaultModel', models)

    const session = sessionWithHistory()
    const summarizer = createModelCompactionSummarizer({ ctx, keepRecentChars: 1 })
    await expect(summarizer({ sessionId: 'summarizer', session })).resolves.toBe('旧轮摘要。')

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('应当发出一次摘要请求')
    const body = call.request.body as { system: string; messages: readonly unknown[]; tools: readonly unknown[] }
    expect(body.system).toContain('上下文压缩器')
    expect(body.tools).toEqual([])
    const transcript = JSON.stringify(body.messages)
    expect(transcript).toContain('旧目标')
    expect(transcript).not.toContain('保留的新问题')
  })

  it('transcript 保留工具调用的形状，并对超长单条截断', () => {
    const session = new InMemorySessionStore(asSessionId('tool-transcript'))
    session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '读文件' }] } })
    session.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }] } },
    })
    session.append({
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'c1', content: 'Y'.repeat(5_000), isError: false } },
    })
    session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
    const plan = chooseCompactionRange(session, { keepRecentChars: 1 })
    if (plan === undefined) throw new Error('应当选出可压缩范围')
    const items = deriveVisibleSurfaceItems(session.events()).slice(0, plan.end)
    const transcript = renderTranscript(items)
    expect(transcript).toContain('[tool call read]')
    expect(transcript).toContain('tool-result')
    // 单条超长结果被截到 2000 字符以内
    expect(transcript.length).toBeLessThan(4_500)
  })
})
