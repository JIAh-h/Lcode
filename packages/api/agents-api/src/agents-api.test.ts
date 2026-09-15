import { describe, expect, it } from 'vitest'
import { InMemoryAgentStore } from '@lcode/agent'
import { createAgentLoop } from '@lcode/agent-loop'
import { InMemoryAgentDefaultModelService } from '@lcode/agent-default-model'
import { createContext } from '@lcode/context'
import { InMemoryLlmRegistry } from '@lcode/llm'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import { InMemorySessionStore, deriveMessages } from '@lcode/session'
import type { SessionService } from '@lcode/session'
import { createSystemPromptService } from '@lcode/system-prompt'
import { InMemoryToolRegistry } from '@lcode/tools'
import { ERROR_CODES, LcodeErrorImpl, asSessionId, nowEpochMs } from '@lcode/util'
import { LocalAgentsApi } from './agents-api.ts'
import type { AgentStatusEvent, AgentStatusStream } from './types.ts'

// ─────────── 夹具 ───────────

const textScript = (text: string): ReplayScript => ({
  provider: 'replay',
  chunks: [
    { type: 'text-delta', text },
    { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ],
})

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

async function makeApi(scripts: readonly ReplayScript[], opts: { configureModel?: boolean } = {}): Promise<{
  api: LocalAgentsApi
  session: SessionService
  models: InMemoryAgentDefaultModelService
}> {
  const ctx = createContext()
  const session = new InMemorySessionStore(asSessionId('s1'))
  const sessions = new Map<string, SessionService>([['s1', session]])
  const getSession = (id: string): SessionService => {
    const found = sessions.get(id)
    if (found === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ES_SESSION_NOT_FOUND,
        message: `session not found: ${id}`,
        userMessage: '找不到这个会话。',
        retryable: false,
      })
    }
    return found
  }
  const registry = new InMemoryToolRegistry(ctx)
  const prompts = createSystemPromptService(registry)
  prompts.section('base', '你是 Lcode。')
  const models = new InMemoryAgentDefaultModelService()
  if (opts.configureModel !== false) await models.set({ provider: 'replay', model: 'replay-model' })
  const llm = new InMemoryLlmRegistry()
  llm.register(new ReplayLlmAdapter(scripts))
  ctx.set('agents', new InMemoryAgentStore(ctx, getSession))
  ctx.set('tools', registry)
  ctx.set('systemPrompt', prompts)
  ctx.set('agentDefaultModel', models)
  ctx.set('llm', llm)
  ctx.set('agentLoop', createAgentLoop({ ctx, getSession }))
  const api = new LocalAgentsApi({ ctx, getSession })
  return { api, session, models }
}

/** 订阅 idle（须在动作前调用） */
function waitIdle(stream: AgentStatusStream): Promise<AgentStatusEvent> {
  return new Promise((resolve) => {
    const stop = stream.subscribe((event) => {
      if (event.status === 'idle') {
        stop()
        resolve(event)
      }
    })
  })
}

const CONTENT = [{ type: 'text' as const, text: '在吗' }]

// ─────────── 用例 ───────────

describe('agents.* · create / resume / get', () => {
  it('create：默认 agent id = 会话 id（D17）；get 按会话找到；未知会话回 null', async () => {
    const { api } = await makeApi([textScript('好')])
    const { agent_id } = await api.create({ session_id: 's1' })
    expect(agent_id).toBe('s1')
    await expect(api.get({ session_id: 's1' })).resolves.toEqual({ agent_id: 's1' })
    await expect(api.get({ session_id: 'nope' })).resolves.toBeNull()
  })

  it('create：未知会话 → ES-SESSION_NOT_FOUND；空 session_id → EC-INVALID_PARAMS', async () => {
    const { api } = await makeApi([])
    await expect(api.create({ session_id: 'ghost' })).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
    await expect(api.create({ session_id: '' })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
  })

  it('resume：幂等；再拿到的句柄可用（followup 正常成轮）', async () => {
    const { api, session } = await makeApi([textScript('一'), textScript('二')])
    await api.create({ session_id: 's1' })
    const first = await api.resume({ session_id: 's1' })
    const second = await api.resume({ session_id: 's1' })
    expect(second.agent_id).toBe(first.agent_id)
    const receipt = await api.followup({ agent_id: first.agent_id, content: CONTENT })
    expect(receipt.accepted).toBe(true)
    // 轮在后台完成：轮/事件落齐
    await new Promise<void>((resolve) => {
      const stop = session.onEvent((e) => {
        if (e.type === 'turn/end') {
          stop()
          resolve()
        }
      })
    })
    expect(session.events().filter((e) => e.type === 'turn/end')).toHaveLength(1)
  })
})

describe('agents.* · followup（只传入队回执）', () => {
  it('回执 seq = user/message 的 seq；watch 的 idle 事件 seq ≥ 回执 seq', async () => {
    const { api, session } = await makeApi([textScript('你好')])
    const { agent_id } = await api.create({ session_id: 's1' })
    const idle = waitIdle(api.watch({ agent_id }))
    const receipt = await api.followup({ agent_id, content: CONTENT })
    expect(receipt).toMatchObject({ accepted: true, session_id: 's1' })
    expect(typeof receipt.enqueued_at).toBe('number')
    const userMsg = session.events().find((e) => e.type === 'user/message')
    expect(receipt.seq).toBe(userMsg?.seq)
    const idleEvent = await idle
    expect(idleEvent.seq).toBeGreaterThanOrEqual(receipt.seq)
    expect(session.events().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: 'completed' } })
  })

  it('未配置模型 → EL-NO_MODEL_CONFIGURED（入队前同步给出），且不落任何事件', async () => {
    const { api, session } = await makeApi([textScript('x')], { configureModel: false })
    const { agent_id } = await api.create({ session_id: 's1' })
    await expect(api.followup({ agent_id, content: CONTENT })).rejects.toMatchObject({
      code: 'EL-NO_MODEL_CONFIGURED',
    })
    expect(session.events()).toHaveLength(0)
  })

  it('空 content → EC-INVALID_PARAMS', async () => {
    const { api } = await makeApi([textScript('x')])
    const { agent_id } = await api.create({ session_id: 's1' })
    await expect(api.followup({ agent_id, content: [] })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
  })

  it('未知 agent → ES-SESSION_NOT_FOUND', async () => {
    const { api } = await makeApi([textScript('x')])
    await expect(api.followup({ agent_id: 'ghost', content: CONTENT })).rejects.toMatchObject({
      code: 'ES-SESSION_NOT_FOUND',
    })
  })

  it('content 块原样落盘为 user/message（与 sessions.append 同构）', async () => {
    const { api, session } = await makeApi([textScript('收到')])
    const { agent_id } = await api.create({ session_id: 's1' })
    void (await api.followup({
      agent_id,
      content: [
        { type: 'text', text: '看这段：' },
        { type: 'text', text: 'const x = 1' },
      ],
    }))
    await new Promise<void>((resolve) => {
      const stop = session.onEvent((e) => {
        if (e.type === 'turn/end') {
          stop()
          resolve()
        }
      })
    })
    const userMsg = session.events().find((e) => e.type === 'user/message')
    expect(userMsg).toMatchObject({
      data: { role: 'user', content: [{ type: 'text', text: '看这段：' }, { type: 'text', text: 'const x = 1' }] },
    })
  })
})

describe('agents.* · steer / inject', () => {
  it('steer：运行中插话进入表面；未运行 → EC-NOT_RUNNING', async () => {
    const { api, session } = await makeApi([toolScript, textScript('收到补充')])
    const { agent_id } = await api.create({ session_id: 's1' })
    // followup 只传回执、轮在后台跑——先挂 idle 等待，再触发
    const idle = waitIdle(api.watch({ agent_id }))
    let steered = false
    const stop = session.onEvent((e) => {
      if (e.type === 'assistant/chunk' && !steered) {
        steered = true
        void api
          .steer({ agent_id, content: [{ type: 'text', text: '顺便补一句' }] })
          .catch(() => {})
      }
    })
    await api.followup({ agent_id, content: CONTENT })
    await idle
    stop()
    const events = session.events()
    const resultIdx = events.findIndex((e) => e.type === 'tool/result')
    expect(events[resultIdx + 1]).toMatchObject({ type: 'user/message', data: { content: [{ type: 'text', text: '顺便补一句' }] } })
    expect(events[resultIdx + 2]).toMatchObject({ type: 'step/start', data: { step: 2 } })
    const derived = deriveMessages(events)
    expect(
      derived.some(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === 'text' && b.text === '顺便补一句'),
      ),
    ).toBe(true)
    // 轮已结束：再插话 → EC-NOT_RUNNING
    await expect(api.steer({ agent_id, content: CONTENT })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
  })

  it('inject：dedupe_key 幂等（同 key 回**首次**回执）；来源落 request/context', async () => {
    const { api, session } = await makeApi([textScript('一'), textScript('二')])
    const { agent_id } = await api.create({ session_id: 's1' })
    // 第一轮先跑完（注入会在下一次请求构建时生效）
    const idle1 = waitIdle(api.watch({ agent_id }))
    await api.followup({ agent_id, content: CONTENT })
    await idle1
    // 轮 1 结束后注入两次（同 key）
    const first = await api.inject({ agent_id, content: [{ type: 'text', text: '背景资料' }], dedupe_key: 'kb-1' })
    const second = await api.inject({ agent_id, content: [{ type: 'text', text: '背景资料' }], dedupe_key: 'kb-1' })
    expect(second).toEqual(first)
    // 第二轮：注入内容随请求构建生效（request/context 落盘）
    const idle2 = waitIdle(api.watch({ agent_id }))
    await api.followup({ agent_id, content: CONTENT })
    await idle2
    // 轮 2 之后再注入同 key：若没有 dedupe 会拿到新的 marker seq——必须仍回**首次**回执
    const again = await api.inject({ agent_id, content: [{ type: 'text', text: '背景资料' }], dedupe_key: 'kb-1' })
    expect(again).toEqual(first)
    const contexts = session.events().filter((e) => e.type === 'request/context')
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ data: { sources: ['agents.inject'] } })
  })
})

describe('agents.* · cancel / watch / dispose', () => {
  it('cancel：幂等（两次都 { cancelled: true }）', async () => {
    const { api } = await makeApi([textScript('x')])
    const { agent_id } = await api.create({ session_id: 's1' })
    await expect(api.cancel({ agent_id, cause: 'user' })).resolves.toEqual({ cancelled: true })
    await expect(api.cancel({ agent_id, cause: 'user' })).resolves.toEqual({ cancelled: true })
    await expect(api.cancel({ agent_id, cause: 'wrong' as never })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
  })

  it('watch：可重订阅——两个独立流都收到 running + idle', async () => {
    const { api } = await makeApi([textScript('好')])
    const { agent_id } = await api.create({ session_id: 's1' })
    const streamA = api.watch({ agent_id })
    const streamB = api.watch({ agent_id })
    const eventsA: AgentStatusEvent[] = []
    const eventsB: AgentStatusEvent[] = []
    const idleA = waitIdle(streamA)
    const idleB = waitIdle(streamB)
    const stopA = streamA.subscribe((e) => eventsA.push(e))
    const stopB = streamB.subscribe((e) => eventsB.push(e))
    await api.followup({ agent_id, content: CONTENT })
    await Promise.all([idleA, idleB])
    stopA()
    stopB()
    expect(eventsA.map((e) => e.status)).toEqual(['running', 'idle'])
    expect(eventsB.map((e) => e.status)).toEqual(['running', 'idle'])
    expect(eventsA.every((e) => e.agentId === agent_id)).toBe(true)
    const idleEvent = eventsA.find((e) => e.status === 'idle')
    expect(typeof idleEvent?.seq).toBe('number')
  })

  it('dispose：幂等；之后 followup 被拒绝（EC-NOT_RUNNING）', async () => {
    const { api } = await makeApi([textScript('x')])
    const { agent_id } = await api.create({ session_id: 's1' })
    await expect(api.dispose({ agent_id })).resolves.toEqual({ disposed: true })
    await expect(api.dispose({ agent_id })).resolves.toEqual({ disposed: true })
    await expect(api.followup({ agent_id, content: CONTENT })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
  })
})

describe('now 注入', () => {
  it('enqueued_at 使用注入时钟', async () => {
    const ctx = createContext()
    const session = new InMemorySessionStore(asSessionId('s1'))
    const sessions = new Map<string, SessionService>([['s1', session]])
    const registry = new InMemoryToolRegistry(ctx)
    const prompts = createSystemPromptService(registry)
    const models = new InMemoryAgentDefaultModelService()
    await models.set({ provider: 'replay', model: 'replay-model' })
    const llm = new InMemoryLlmRegistry()
    llm.register(new ReplayLlmAdapter(textScript('好')))
    ctx.set('agents', new InMemoryAgentStore(ctx, getSessionOf(sessions)))
    ctx.set('tools', registry)
    ctx.set('systemPrompt', prompts)
    ctx.set('agentDefaultModel', models)
    ctx.set('llm', llm)
    ctx.set('agentLoop', createAgentLoop({ ctx, getSession: getSessionOf(sessions) }))
    let tick = 12345
    const api = new LocalAgentsApi({ ctx, getSession: getSessionOf(sessions), now: () => tick })
    const { agent_id } = await api.create({ session_id: 's1' })
    const receipt = await api.followup({ agent_id, content: CONTENT })
    expect(receipt.enqueued_at).toBe(12345)
    tick = 999
    expect(nowEpochMs()).not.toBe(receipt.enqueued_at)
  })
})

function getSessionOf(sessions: Map<string, SessionService>): (id: string) => SessionService {
  return (id) => {
    const found = sessions.get(id)
    if (found === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ES_SESSION_NOT_FOUND,
        message: `session not found: ${id}`,
        userMessage: '找不到这个会话。',
        retryable: false,
      })
    }
    return found
  }
}
