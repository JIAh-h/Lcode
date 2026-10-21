import { Context } from '@lcode/context'
import type { SessionService } from '@lcode/session'
import type { AgentId, Disposer, SessionId } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl, asAgentId } from '@lcode/util'
import type {
  AgentHandle,
  AgentRef,
  AgentService,
  AgentSpec,
  AgentStatus,
  CancelReason,
  InjectedContext,
  InitiatorRef,
  UserInput,
} from './agent.ts'

/** 内存实现：活体注册表 + AgentHandle 状态机（20 §5.4） */
export class InMemoryAgentStore implements AgentService {
  private handles = new Map<string, AgentHandleImpl>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly getSession: (sessionId: SessionId) => SessionService,
  ) {}

  async create(spec: AgentSpec): Promise<AgentHandle> {
    this.assertAlive()
    const id = spec.id ?? asAgentId(spec.sessionId)
    if (this.handles.has(id)) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_CONFLICT,
        message: `agent 已存在：${id}`,
        userMessage: '这个对话已经在运行了。',
      })
    }
    const handle = new AgentHandleImpl(
      this.ctx,
      id,
      spec.sessionId,
      this.getSession(spec.sessionId),
      () => this.handles.delete(id),
    )
    this.handles.set(id, handle)
    await this.ctx.emit('agent/created', { agentId: id, sessionId: spec.sessionId })
    return handle
  }

  async resume(ref: AgentRef): Promise<AgentHandle> {
    this.assertAlive()
    const existing = this.handles.get(ref.agentId)
    if (existing) return existing
    const handle = new AgentHandleImpl(
      this.ctx,
      ref.agentId,
      ref.sessionId,
      this.getSession(ref.sessionId),
      () => this.handles.delete(ref.agentId),
    )
    this.handles.set(ref.agentId, handle)
    return handle
  }

  get(agentId: AgentId): AgentHandle | undefined {
    return this.handles.get(agentId)
  }

  list(): readonly AgentHandle[] {
    return [...this.handles.values()]
  }

  async withInitiator<T>(initiator: InitiatorRef, fn: () => Promise<T>): Promise<T> {
    // 骨架阶段不做发起者归属（批次⑥ 的审批链会用到）；显式 void 表明"故意未使用"
    void initiator
    return fn()
  }

  /** 整体销毁（应用退出 / 组合重建时调用） */
  async disposeAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.dispose()
    }
    this.disposed = true
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_RUNNING,
        message: 'agent store 已销毁',
        userMessage: '它现在没在干活，插话没地方放。',
      })
    }
  }
}

class AgentHandleImpl implements AgentHandle {
  private _status: AgentStatus = 'idle'
  private alive = true
  private disposers: Disposer[] = []

  constructor(
    private readonly ctx: Context,
    readonly id: AgentId,
    readonly sessionId: SessionId,
    private readonly session: SessionService,
    private readonly unregister: () => void,
  ) {}

  get status(): AgentStatus {
    return this._status
  }

  async followup(input: UserInput): Promise<void> {
    this.assertAlive()
    this.setStatus('running')
    await this.ctx.emit('agent/inbox', { agentId: this.id, kind: 'followup' })
    void input
  }

  async steer(input: UserInput): Promise<void> {
    this.assertAlive()
    this.assertRunning()
    await this.ctx.emit('agent/inbox', { agentId: this.id, kind: 'steer' })
    void input
  }

  async inject(input: InjectedContext): Promise<void> {
    this.assertAlive()
    await this.ctx.emit('agent/inbox', { agentId: this.id, kind: 'inject' })
    void input
  }

  async cancel(reason: CancelReason): Promise<void> {
    if (!this.alive) return
    this.setStatus('cancelled', reason)
    // 不变量 A2：取消后必须落盘一个明确的结束事件——把未关闭的轮补上 turn/end(cancelled)
    const events = this.session.events()
    const hasOpenTurn = events.some((e) => e.type === 'turn/start')
    if (hasOpenTurn) {
      const lastTurn = [...events].reverse().find((e) => e.type === 'turn/start' || e.type === 'turn/end')
      if (lastTurn?.type === 'turn/start') {
        this.session.append({
          type: 'turn/end',
          data: { turn: lastTurn.data.turn, reason: 'cancelled' },
          sourceEventSeqs: [lastTurn.seq],
        })
      }
    }
    await this.ctx.emit('agent/status', { agentId: this.id, status: 'cancelled', reason })
  }

  /** A4：dispose 后不得再有该 agent 的事件 */
  async dispose(): Promise<void> {
    if (!this.alive) return
    this.alive = false
    /* c8 ignore next 3 -- core store 当前不注册额外 disposer；循环保留给装配层扩展点 */
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      this.disposers[i]!()
    }
    this.disposers = []
    this.unregister()
    await this.ctx.emit('agent/disposed', { agentId: this.id })
  }

  private setStatus(status: AgentStatus, reason?: string): void {
    this._status = status
    // `exactOptionalPropertyTypes` 下 `reason?: string` 不接受显式 undefined，
    // 因此"有值才带上这个字段"（而不是传一个 undefined 进去）
    void this.ctx.emit('agent/status', {
      agentId: this.id,
      status,
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  private assertAlive(): void {
    if (!this.alive) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_RUNNING,
        message: 'agent 已销毁',
        userMessage: '它现在没在干活，插话没地方放。',
      })
    }
  }

  private assertRunning(): void {
    if (this._status !== 'running') {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_RUNNING,
        message: 'agent 未在运行，无法插话',
        userMessage: '它现在没在干活，插话没地方放。',
      })
    }
  }
}
