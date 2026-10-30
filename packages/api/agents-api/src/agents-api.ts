import type { AgentHandle, AgentStatus } from '@lcode/agent'
import type { Context } from '@lcode/context'
import type { AgentLoopRuntime, LoopHandle } from '@lcode/agent-loop'
import type { ContentBlock, SessionService } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl, asAgentId, asSessionId, nowEpochMs } from '@lcode/util'
import { AgentStatusStream, assertContentBlocks } from './types.ts'
import type { AgentOptions, AgentStatusEvent, CancellationCause, EnqueueReceipt, QueuedMessage } from './types.ts'

/**
 * LocalAgentsApi —— docs/21 §2.2 `agents.*` 的边界层落地。
 *
 * 把 @lcode/agent-loop 的运行时句柄（AgentHandle + enqueue）包装成方法契约：
 * - **followup 只传入队回执**（EnqueueReceipt），轮结果由调用方在 watch 流上观察
 *   （docs/21 §5.4 同义：等待某个区间是调用方自己的事）；
 * - **inject 按 dedupe_key 幂等**：同 key 重复调用返回首次回执，不再注入；
 * - **cancel 幂等**：引擎保证二次取消无副作用，这里始终回 `{ cancelled: true }`；
 * - **watch 幂等重订阅**：每次调用返回新的独立状态流，idle 事件带 seq。
 *
 * 装配约定：`ctx` 里须已注册 `agentLoop`（AgentLoopRuntime 实现）与 `agents`
 * （AgentService）；`getSession` 抛 `ES-SESSION_NOT_FOUND` 表示会话不存在。
 * 句柄须由**同一 API 实例**的 create/resume 获得（装配层单例约定）。
 */

export interface LocalAgentsApiOptions {
  readonly ctx: Context
  readonly getSession: (sessionId: string) => SessionService
  readonly now?: (() => number) | undefined
}

const CANCELLATION_CAUSES: readonly CancellationCause[] = ['user', 'parent', 'hook', 'dispose']

export class LocalAgentsApi {
  private readonly handles = new Map<string, LoopHandle>()
  /** dedupe_key → 首次回执（inject 幂等的簿记；回执形态是 { accepted, seq }） */
  private readonly dedupe = new Map<string, Map<string, { readonly accepted: true; readonly seq: number }>>()
  private readonly now: () => number

  constructor(private readonly deps: LocalAgentsApiOptions) {
    this.now = deps.now ?? ((): number => nowEpochMs())
  }

  /** `agents.create`：ES-SESSION_NOT_FOUND / EC-INVALID_PARAMS */
  async create(input: { readonly session_id: string; readonly options?: AgentOptions }): Promise<{ readonly agent_id: string }> {
    if (typeof input.session_id !== 'string' || input.session_id.trim() === '') throw invalidParams('session_id 必填')
    // 未知会话在这里变成 ES-SESSION_NOT_FOUND（getSession 的装配契约）
    this.deps.getSession(input.session_id)
    const options = input.options ?? {}
    const handle = await this.loop().create({
      sessionId: asSessionId(input.session_id),
      ...(options.id !== undefined ? { id: asAgentId(options.id) } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.presetRef !== undefined ? { presetRef: options.presetRef } : {}),
    })
    this.handles.set(handle.id, handle)
    return { agent_id: handle.id }
  }

  /** `agents.resume`：幂等；按 D17 以会话 id 作为 agent id */
  async resume(input: { readonly session_id: string }): Promise<{ readonly agent_id: string }> {
    if (typeof input.session_id !== 'string' || input.session_id.trim() === '') throw invalidParams('session_id 必填')
    this.deps.getSession(input.session_id)
    const handle = await this.loop().resume({
      sessionId: asSessionId(input.session_id),
      agentId: asAgentId(input.session_id),
    })
    this.handles.set(handle.id, handle)
    return { agent_id: handle.id }
  }

  /** `agents.get`：按会话找活体 agent（找不到回 null，不抛错） */
  async get(input: { readonly session_id: string }): Promise<{ readonly agent_id: string } | null> {
    if (typeof input.session_id !== 'string' || input.session_id.trim() === '') throw invalidParams('session_id 必填')
    const store = this.deps.ctx.get('agents')
    const found: AgentHandle | undefined = store.list().find((h) => h.sessionId === input.session_id)
    return found === undefined ? null : { agent_id: found.id }
  }

  /** `agents.followup`：只传入队回执；EL-NO_MODEL_CONFIGURED 在入队前同步给出 */
  async followup(input: {
    readonly agent_id: string
    readonly content: readonly ContentBlock[]
    /** 通道占位：取消统一走 agents.cancel（docs/21 §2.2） */
    readonly signal?: AbortSignal
  }): Promise<EnqueueReceipt> {
    if (input.signal !== undefined) void input.signal
    const handle = this.requireHandle(input.agent_id)
    assertContentBlocks(input.content)
    this.assertModelConfigured()
    const { seq, queueId } = handle.enqueue({ kind: 'content', content: input.content })
    return { accepted: true, session_id: handle.sessionId, seq, queue_id: queueId, enqueued_at: this.now() }
  }

  /**
   * `agents.steer`：当前轮的下一个步边界生效；未在运行 → EC-NOT_RUNNING。
   * `mode: 'interrupt'` 先打断当前步骤（正在跑的工具 / 流式请求）再交付。
   */
  async steer(input: {
    readonly agent_id: string
    readonly content: readonly ContentBlock[]
    readonly mode?: 'soft' | 'interrupt' | undefined
  }): Promise<{ readonly accepted: true; readonly seq: number }> {
    const handle = this.requireHandle(input.agent_id)
    assertContentBlocks(input.content)
    await handle.steer({ kind: 'content', content: input.content }, input.mode ?? 'soft')
    return { accepted: true, seq: this.deps.getSession(handle.sessionId).length }
  }

  /** 当前活体 agent 尚未开始的消息。队列不落盘，进程重启后不存在。 */
  async queued(input: { readonly agent_id: string }): Promise<{ readonly items: readonly QueuedMessage[] }> {
    const handle = this.requireHandle(input.agent_id)
    return {
      items: handle.queued().map(({ queueId, input }) => ({
        queue_id: queueId,
        content: input.kind === 'content' ? input.content : [{ type: 'text', text: input.text }],
      })),
    }
  }

  async editQueued(input: { readonly agent_id: string; readonly queue_id: string; readonly content: readonly ContentBlock[] }): Promise<{ readonly updated: boolean }> {
    const handle = this.requireHandle(input.agent_id)
    assertContentBlocks(input.content)
    return { updated: handle.editQueued(input.queue_id, { kind: 'content', content: input.content }) }
  }

  async removeQueued(input: { readonly agent_id: string; readonly queue_id: string }): Promise<{ readonly removed: boolean }> {
    return { removed: this.requireHandle(input.agent_id).removeQueued(input.queue_id) }
  }

  async clearQueued(input: { readonly agent_id: string }): Promise<{ readonly removed: number }> {
    return { removed: this.requireHandle(input.agent_id).clearQueued() }
  }

  async guideQueued(input: {
    readonly agent_id: string
    readonly queue_id: string
    readonly mode?: 'soft' | 'interrupt' | undefined
  }): Promise<{ readonly guided: boolean }> {
    return { guided: this.requireHandle(input.agent_id).guideQueued(input.queue_id, input.mode ?? 'soft') }
  }

  /** `agents.inject`：幂等（按 dedupe_key）；不改对话可见内容 */
  async inject(input: {
    readonly agent_id: string
    readonly content: readonly ContentBlock[]
    readonly dedupe_key?: string
  }): Promise<{ readonly accepted: true; readonly seq: number }> {
    const handle = this.requireHandle(input.agent_id)
    assertContentBlocks(input.content)
    if (input.dedupe_key !== undefined) {
      const seen = this.dedupe.get(handle.id)?.get(input.dedupe_key)
      if (seen !== undefined) return seen
    }
    // 纯文本注入按原文交给宿主提示（JSON.stringify 会把一句话变成转义后的数组字面量）
    const text = input.content.every((block) => block.type === 'text')
      ? input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      : JSON.stringify(input.content)
    await handle.inject({ content: text, source: 'agents.inject' })
    const receipt = { accepted: true, seq: this.deps.getSession(handle.sessionId).length } as const
    if (input.dedupe_key !== undefined) {
      const perAgent = this.dedupe.get(handle.id) ?? new Map<string, EnqueueReceipt>()
      perAgent.set(input.dedupe_key, receipt)
      this.dedupe.set(handle.id, perAgent)
    }
    return receipt
  }

  /** `agents.cancel`：幂等 */
  async cancel(input: { readonly agent_id: string; readonly cause: CancellationCause }): Promise<{ readonly cancelled: boolean }> {
    if (!CANCELLATION_CAUSES.includes(input.cause)) {
      throw invalidParams(`cause 必须是 ${CANCELLATION_CAUSES.join('|')}：${String(input.cause)}`)
    }
    const handle = this.requireHandle(input.agent_id)
    await handle.cancel(input.cause)
    return { cancelled: true }
  }

  /** 恢复最近一次由用户暂停的回合；不是恢复已中断的网络流，而是基于日志续跑。 */
  async resumeTurn(input: { readonly agent_id: string }): Promise<{ readonly resumed: boolean }> {
    const handle = this.requireHandle(input.agent_id)
    return { resumed: await handle.resumeTurn() }
  }

  /** `agents.watch`：幂等重订阅——每次调用返回新的独立状态流 */
  watch(input: { readonly agent_id: string }): AgentStatusStream {
    const handle = this.requireHandle(input.agent_id)
    const stream = new AgentStatusStream()
    const dispose = this.deps.ctx.on('agent/status', (payload: { agentId: string; status: AgentStatus; reason?: string }) => {
      if (payload.agentId !== input.agent_id) return
      const event: AgentStatusEvent = {
        agentId: payload.agentId,
        status: payload.status,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        // idle 事件带 seq：此刻日志长度（「idleSeq ≥ 回执 seq 即跑完」判据，docs/21 §2.2）
        ...(payload.status === 'idle' ? { seq: this.deps.getSession(handle.sessionId).length } : {}),
        at: this.now(),
      }
      stream.push(event)
    })
    stream.attachUpstream(dispose)
    return stream
  }

  /** `agents.dispose`：幂等；A4——之后不得再有该 agent 的事件 */
  async dispose(input: { readonly agent_id: string }): Promise<{ readonly disposed: true }> {
    const handle = this.requireHandle(input.agent_id)
    await handle.dispose()
    return { disposed: true }
  }

  // ─────────── 内部 ───────────

  private loop(): AgentLoopRuntime {
    // 装配层保证 ctx.agentLoop 是 createAgentLoop 的产物（AgentLoopRuntime ⊇ AgentLoop）
    return this.deps.ctx.get('agentLoop') as AgentLoopRuntime
  }

  private requireHandle(agentId: string): LoopHandle {
    if (typeof agentId !== 'string' || agentId.trim() === '') throw invalidParams('agent_id 必填')
    const found = this.handles.get(agentId)
    if (found === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ES_SESSION_NOT_FOUND,
        message: `agent 不存在或未由本 API 装配：${agentId}`,
        userMessage: '找不到这个对话的执行体。',
        retryable: false,
      })
    }
    return found
  }

  private assertModelConfigured(): void {
    if (!this.deps.ctx.has('agentDefaultModel')) return
    if (this.deps.ctx.get('agentDefaultModel').get() === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_NO_MODEL_CONFIGURED,
        message: '没有可用的模型选择（agentDefaultModel 未配置）',
        userMessage: '还没有选择模型。请到「设置 → 模型」里选一个。',
        retryable: false,
      })
    }
  }
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_INVALID_PARAMS,
    message,
    userMessage: '这个请求的参数不对。',
    retryable: false,
  })
}
