import { describe, expect, it } from 'vitest'
import { InMemoryAgentStore } from '@lcode/agent'
import type { AgentHandle } from '@lcode/agent'
import { InMemoryAgentDefaultModelService } from '@lcode/agent-default-model'
import { createContext } from '@lcode/context'
import { InMemoryLlmRegistry } from '@lcode/llm'
import type { LlmAdapter } from '@lcode/llm'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import { InMemorySessionStore, deriveMessages } from '@lcode/session'
import type { SessionService } from '@lcode/session'
import { createSystemPromptService } from '@lcode/system-prompt'
import { InMemoryToolRegistry } from '@lcode/tools'
import type { ToolDefinition } from '@lcode/tools'
import { asAgentId, asSessionId } from '@lcode/util'
import { createAgentLoop } from './agent-loop.ts'
import type { CapturedRequest } from './agent-loop.ts'

// ─────────── 夹具 ───────────

const echoTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  name: 'echo',
  description: '回显输入文本',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  execute: (call) => ({ echoed: call.parsed.text }),
}

const toolScript: ReplayScript = {
  provider: 'replay',
  chunks: [
    { type: 'tool-call-delta', callId: 'call-1', name: 'echo', argsDelta: '{"text":' },
    { type: 'tool-call-delta', callId: 'call-1', name: 'echo', argsDelta: '"hi"}' },
    {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: { text: 'hi' } }],
      },
    },
  ],
}

const textScript = (text: string): ReplayScript => ({
  provider: 'replay',
  chunks: [
    { type: 'text-delta', text },
    {
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      usage: { input: 5, output: 7, total: 12 },
    },
  ],
})

const failingTool: ToolDefinition<{ text: string }, never> = {
  name: 'boom',
  description: '总是失败的工具',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '任意' } },
    required: ['text'],
  },
  execute: () => {
    throw new Error('工具内部爆炸')
  },
}

interface Harness {
  readonly session: SessionService
  readonly prompts: ReturnType<typeof createSystemPromptService>
  readonly models: InMemoryAgentDefaultModelService
  readonly adapter: LlmAdapter
  readonly registry: InMemoryToolRegistry
  readonly ctx: ReturnType<typeof createContext>
  readonly getSession: (id: string) => SessionService
}

async function makeHarness(
  scripts: ReplayScript | readonly ReplayScript[],
  opts: { adapter?: LlmAdapter; configureModel?: boolean } = {},
): Promise<Harness & { loop: ReturnType<typeof createAgentLoop> }> {
  const ctx = createContext()
  const sessions = new Map<string, SessionService>()
  const session = new InMemorySessionStore(asSessionId('s1'))
  sessions.set('s1', session)
  const getSession = (id: string): SessionService => {
    const found = sessions.get(id)
    if (found === undefined) throw new Error(`session not found: ${id}`)
    return found
  }
  const registry = new InMemoryToolRegistry(ctx)
  const prompts = createSystemPromptService(registry)
  prompts.section('base', '你是 Lcode。')
  const models = new InMemoryAgentDefaultModelService()
  if (opts.configureModel !== false) await models.set({ provider: 'replay', model: 'replay-model' })
  const adapter = opts.adapter ?? new ReplayLlmAdapter(scripts)
  const llm = new InMemoryLlmRegistry()
  llm.register(adapter)
  ctx.set('agents', new InMemoryAgentStore(ctx, getSession))
  ctx.set('tools', registry)
  ctx.set('systemPrompt', prompts)
  ctx.set('agentDefaultModel', models)
  ctx.set('llm', llm)
  const loop = createAgentLoop({ ctx, getSession })
  return { ctx, session, loop, adapter, prompts, models, registry, getSession }
}

/** I1 捕获装饰器：记录每次请求的 atSeq / system / messages（docs/15 §2.1 的形状） */
function captureDecorator(inner: LlmAdapter, sink: CapturedRequest[], session: SessionService): LlmAdapter {
  return {
    providerInfo: () => inner.providerInfo(),
    listModels: (signal) => inner.listModels(signal),
    resolveModel: (sel) => inner.resolveModel(sel),
    prepareCall: (sel, opts) => inner.prepareCall(sel, opts),
    providerRetryPolicy: () => inner.providerRetryPolicy(),
    stream: (call, signal) => {
      const body = call.request.body as { system: string; messages: readonly unknown[] }
      sink.push({ atSeq: session.length, system: body.system, messages: body.messages })
      return inner.stream(call, signal)
    },
  }
}

const typesOf = (events: readonly { type: string }[]): string[] => events.map((e) => e.type)

// ─────────── 用例 ───────────

describe('批次③ · 无密钥跑通一次循环', () => {
  it('纯文本轮：完整事件序列 + turn/end(completed)', async () => {
    const h = await makeHarness(textScript('你好'))
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await handle.followup({ kind: 'text', text: '在吗' })

    expect(typesOf(h.session.events())).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'request/header',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const last = h.session.events().at(-1)
    expect(last).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    const assistant = h.session.events().find((e) => e.type === 'assistant/message')
    expect(assistant).toMatchObject({
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } },
    })
    expect(handle.status).toBe('idle')
  })

  it('工具循环：两段脚本驱动，raw args 原样落盘，I3 配对完整', async () => {
    const h = await makeHarness([toolScript, textScript('完成：hi')])
    h.registry.register(echoTool)
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await handle.followup({ kind: 'text', text: '把 hi 回显一遍' })

    const types = typesOf(h.session.events())
    expect(types).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'request/header',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'tool/call',
      'tool/result',
      'step/start',
      'request/header',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    // D9：tool/call 的 arguments 是未解析的原始 JSON 串（两段 delta 的原样拼接）
    const call = h.session.events().find((e) => e.type === 'tool/call')
    expect(call).toMatchObject({ data: { turn: 1, step: 1, callId: 'call-1', name: 'echo', arguments: '{"text":"hi"}' } })
    const result = h.session.events().find((e) => e.type === 'tool/result')
    expect(result).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', toolCallId: 'call-1', content: '{"echoed":"hi"}', isError: false },
      },
    })
    // 第二次请求的快照原因：同 system / 同工具 / 同模型 → continuation
    const headers = h.session.events().filter((e) => e.type === 'request/header')
    expect(headers).toHaveLength(2)
    expect(headers[1]).toMatchObject({ data: { reason: 'continuation' } })
    // I3：无悬空 call
    const derived = deriveMessages(h.session.events())
    expect(derived).toHaveLength(4)
    expect(derived[1]).toMatchObject({ role: 'assistant' })
    expect(derived[2]).toMatchObject({ role: 'user', toolCallId: 'call-1' })
  })

  it('I1 · 模型可见即可重放：每次请求都能从日志前缀精确重建', async () => {
    const base = new ReplayLlmAdapter([toolScript, textScript('done')])
    const h0 = await makeHarness([])
    const sink: CapturedRequest[] = []
    const captured = captureDecorator(base, sink, h0.session)
    // 重建一个用捕获适配器的装配
    h0.ctx.set('llm', { register: () => () => {}, get: () => captured, list: () => ['replay'] })
    h0.registry.register(echoTool)
    const handle = await h0.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await handle.followup({ kind: 'text', text: '把 hi 回显一遍' })

    expect(sink.length).toBe(2)
    const expectedSystem = (await h0.prompts.assemble({ sessionId: 's1' })).system
    for (const req of sink) {
      const prefix = h0.session.events().slice(0, req.atSeq)
      // ① messages 结构深相等（从日志前缀派生）
      expect(req.messages).toEqual(deriveMessages(prefix))
      // ② system 逐字节一致
      expect(req.system).toBe(expectedSystem)
    }
  })

  it('取消（流中）：interrupted 消息 + turn/end(cancelled) 带血缘，二次取消幂等', async () => {
    const ref: { current?: AgentHandle } = {}
    const cancelAdapter: LlmAdapter = {
      providerInfo: () => ({ id: 'replay', name: 'replay', capabilities: { streaming: true, reasoning: true, toolCalls: true } }),
      listModels: async () => [{ id: 'replay-model' }],
      resolveModel: async (sel) => ({ provider: sel.provider, model: sel.model }),
      prepareCall: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
        request: { endpoint: 'replay://', headers: {}, body: {} },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false },
      }),
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', text: '部分' }
          void ref.current?.cancel('user')
          yield { type: 'text-delta', text: '取消后到达' }
        })(),
      providerRetryPolicy: () => ({ maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false }),
    }
    const h = await makeHarness([], { adapter: cancelAdapter })
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    ref.current = handle
    await handle.followup({ kind: 'text', text: '写一首诗' })

    // 取消后到达的 chunk 不入日志；取消前的内容以 interrupted 消息落盘
    const texts = h.session
      .events()
      .filter((e) => e.type === 'assistant/chunk')
      .map((e) => (e.data as { chunk: { text?: string } }).chunk.text)
    expect(texts).not.toContain('取消后到达')
    const interrupted = h.session
      .events()
      .find((e) => e.type === 'assistant/message' && (e.data as { interrupted?: boolean }).interrupted === true)
    expect(interrupted).toBeDefined()
    expect(interrupted).toMatchObject({ data: { message: { content: [{ type: 'text', text: '部分' }] } } })
    const turnEnd = h.session.events().find((e) => e.type === 'turn/end')
    expect(turnEnd).toMatchObject({ type: 'turn/end', data: { reason: 'cancelled' }, sourceEventSeqs: [0] })
    expect(handle.status).toBe('cancelled')
    // 二次取消幂等；取消后的 followup 被拒绝
    await expect(handle.cancel('user')).resolves.toBeUndefined()
    await expect(handle.followup({ kind: 'text', text: '再来' })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
  })

  it('工具失败不终结轮：失败变成 tool/result 交给模型（08 §4.4）', async () => {
    const h = await makeHarness([
      {
        provider: 'replay',
        chunks: [
          { type: 'tool-call-delta', callId: 'call-9', name: 'boom', argsDelta: '{"text":"x"}' },
          {
            type: 'done',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-9', name: 'boom', input: { text: 'x' } }],
            },
          },
        ],
      },
      textScript('已处理失败'),
    ])
    h.registry.register(failingTool)
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await handle.followup({ kind: 'text', text: '用 boom 工具' })

    const result = h.session.events().find((e) => e.type === 'tool/result')
    expect(result).toMatchObject({
      data: { message: { isError: true }, error: { code: 'ET-ERROR' } },
    })
    const last = h.session.events().at(-1)
    expect(last).toMatchObject({ type: 'turn/end', data: { reason: 'completed' } })
  })

  it('resume：新循环实例接上同一会话，轮号从日志续排', async () => {
    const h = await makeHarness([textScript('第一轮'), textScript('第二轮')])
    const handle1 = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await handle1.followup({ kind: 'text', text: '第一句' })
    // 新的循环实例（模拟进程重启后的恢复）
    const loop2 = createAgentLoop({ ctx: h.ctx, getSession: h.getSession })
    const handle2 = await loop2.resume({ sessionId: asSessionId('s1'), agentId: asAgentId('a1') })
    await handle2.followup({ kind: 'text', text: '第二句' })
    const turns = h.session.events().filter((e) => e.type === 'turn/start')
    expect(turns.map((t) => (t.data as { turn: number }).turn)).toEqual([1, 2])
  })

  it('followup 排队：两个输入顺序成轮（turn 1 → turn 2）', async () => {
    const h = await makeHarness([textScript('一'), textScript('二')])
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    const p1 = handle.followup({ kind: 'text', text: '第一句' })
    const p2 = handle.followup({ kind: 'text', text: '第二句' })
    await Promise.all([p1, p2])
    const turns = h.session.events().filter((e) => e.type === 'turn/start')
    expect(turns.map((t) => (t.data as { turn: number }).turn)).toEqual([1, 2])
    expect(h.session.events().filter((e) => e.type === 'turn/end')).toHaveLength(2)
  })

  it('未配置模型：EL-NO_MODEL_CONFIGURED，turn/end(error)，L3 不吞', async () => {
    const h = await makeHarness(textScript('x'), { configureModel: false })
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await expect(handle.followup({ kind: 'text', text: '在吗' })).rejects.toMatchObject({
      code: 'EL-NO_MODEL_CONFIGURED',
    })
    const turnEnd = h.session.events().find((e) => e.type === 'turn/end')
    expect(turnEnd).toMatchObject({ data: { reason: 'error' } })
  })

  it('无适配器：EL-NO_ADAPTER', async () => {
    const h = await makeHarness(textScript('x'))
    await h.models.set({ provider: 'ghost', model: 'whatever' })
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    await expect(handle.followup({ kind: 'text', text: '在吗' })).rejects.toMatchObject({ code: 'EL-NO_ADAPTER' })
  })

  it('steer：插话在下一个步边界进入模型可见历史', async () => {
    const h = await makeHarness([toolScript, textScript('收到补充')])
    h.registry.register(echoTool)
    const handle = await h.loop.create({ sessionId: asSessionId('s1'), id: asAgentId('a1') })
    // 第一个 chunk 落盘后插话一次（模拟运行中用户输入）
    let steered = false
    const dispose = h.session.onEvent((e) => {
      if (e.type === 'assistant/chunk' && !steered) {
        steered = true
        void handle.steer({ kind: 'text', text: '顺便补一句' }).catch(() => {})
      }
    })
    await handle.followup({ kind: 'text', text: '把 hi 回显一遍' })
    dispose()

    const events = h.session.events()
    const resultIdx = events.findIndex((e) => e.type === 'tool/result')
    expect(events[resultIdx + 1]).toMatchObject({ type: 'user/message', data: { content: '顺便补一句' } })
    expect(events[resultIdx + 2]).toMatchObject({ type: 'step/start', data: { step: 2 } })
    // 最后一次请求的派生消息包含插话
    const derived = deriveMessages(events)
    expect(derived.some((m) => m.role === 'user' && m.content === '顺便补一句')).toBe(true)
  })
})
