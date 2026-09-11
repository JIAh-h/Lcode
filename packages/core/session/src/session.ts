import type { SessionId } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl, asSeq, freezeLossless, nowEpochMs } from '@lcode/util'
import type { Disposer } from '@lcode/util'
import { deriveMessages } from './surface.ts'
import type { AppendedEvent, EventInput, SessionEvent, SessionEventType } from './types.ts'

/**
 * SessionService —— 骨架层核心（文档 20 §5.1）。
 * append-only 事件日志的唯一 owner：追加、读取、派生投影、分叉。
 * ctx key: `ctx.sessions`（复数 = 拥有多个具名成员的服务）。
 */
export interface SessionService {
  /** 唯一入口：追加事件（seq 由本模块分配，调用方不得传入） */
  append<K extends SessionEventType>(input: EventInput<K>): AppendedEvent<K>
  /** 批量追加（原子性：要么全部可见，要么全部不可见） */
  appendMany<K extends SessionEventType>(inputs: readonly EventInput<K>[]): readonly AppendedEvent<K>[]
  /** 读取（可按区间；返回逐条事件而非派生结果） */
  events(range?: { readonly from?: number; readonly to?: number }): readonly SessionEvent[]
  /** 派生投影（纯函数语义：同样的日志必然得到同样的结果） */
  deriveMessages(): ReturnType<typeof deriveMessages>
  /** 分叉：按某个"安全切点"复制出新会话 */
  fork(cutAtSeq: number): Promise<SessionHandle>
  /** 生命周期分界线（11 §6）：种子注入后立刻调用 */
  markEndSeed(): void
  /** 日志长度（= 下一个 seq） */
  readonly length: number
  /** 订阅：每个落盘事件广播一次（UI 的数据源） */
  onEvent(handler: (event: SessionEvent) => void): Disposer
}

/** 分叉产出的新会话句柄 */
export interface SessionHandle {
  readonly sessionId: SessionId
  readonly seed: readonly SessionEvent[]
}

/** 内存版实现（不变量 S5：同步提交内存；有界批写磁盘由持久化层负责） */
export class InMemorySessionStore implements SessionService {
  private log: SessionEvent[] = []
  private seeded = false
  private listeners = new Set<(event: SessionEvent) => void>()
  readonly id: SessionId

  constructor(id: SessionId) {
    this.id = id
  }

  get length(): number {
    return this.log.length
  }

  append<K extends SessionEventType>(input: EventInput<K>): AppendedEvent<K> {
    const event = this.materialize(input, this.log.length)
    this.log.push(event)
    this.broadcast(event)
    return event
  }

  appendMany<K extends SessionEventType>(inputs: readonly EventInput<K>[]): readonly AppendedEvent<K>[] {
    if (inputs.length === 0) return []
    // 原子性（S1）：先全部校验 + 物化，再统一入列；任一条失败则整体不提交
    const materialized = inputs.map((input, i) => this.materialize(input, this.log.length + i))
    for (const ev of materialized) {
      this.log.push(ev as SessionEvent)
    }
    // 广播（批量事件逐个广播，UI 逐条消费）
    for (const ev of materialized) {
      this.broadcast(ev as SessionEvent)
    }
    return materialized
  }

  events(range?: { readonly from?: number; readonly to?: number }): readonly SessionEvent[] {
    const from = range?.from ?? 0
    const to = range?.to ?? this.log.length
    return this.log.slice(from, to)
  }

  deriveMessages() {
    return deriveMessages(this.log)
  }

  /** 分叉：切点必须落在已关闭的轮内；产出的新会话以 [0, cutAtSeq) 为种子 */
  async fork(cutAtSeq: number): Promise<SessionHandle> {
    if (cutAtSeq < 0 || cutAtSeq > this.log.length) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ES_FORK_BOUNDARY_INVALID,
        message: `fork 切点越界：${cutAtSeq} / ${this.log.length}`,
        userMessage: '你选的位置落在一个还没结束的回合中间，请换一个位置。',
      })
    }
    // 骨架实现：校验切点不在未关闭的轮内（最后一个 turn/end 之前）
    const cut = this.log.slice(0, cutAtSeq)
    if (!isBoundarySafe(cut)) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ES_FORK_BOUNDARY_INVALID,
        message: `fork 切点落在未关闭的轮内：${cutAtSeq}`,
        userMessage: '你选的位置落在一个还没结束的回合中间，请换一个位置。',
      })
    }
    return { sessionId: this.id, seed: Object.freeze([...cut]) }
  }

  markEndSeed(): void {
    if (this.seeded) return
    this.seeded = true
    // 追加 session/end-seed（空载荷，靠位置表达含义）
    this.append({ type: 'session/end-seed', data: {} })
  }

  onEvent(handler: (event: SessionEvent) => void): Disposer {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  private materialize<K extends SessionEventType>(input: EventInput<K>, seq: number): AppendedEvent<K> {
    const data = freezeLossless(input.data)
    const event: AppendedEvent<K> = {
      type: input.type,
      seq: asSeq(seq),
      time: input.time ?? nowEpochMs(),
      data,
    }
    if (input.surfaceOp !== undefined) (event as unknown as Record<string, unknown>).surfaceOp = input.surfaceOp
    if (input.sourceEventSeqs !== undefined) (event as unknown as Record<string, unknown>).sourceEventSeqs = [...input.sourceEventSeqs]
    if (input.ignorable === true) (event as unknown as Record<string, unknown>).ignorable = true
    return event
  }

  private broadcast(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

/** 切点安全判定：最后一个 turn/start 必须有配对的 turn/end（骨架简化版） */
function isBoundarySafe(prefix: readonly SessionEvent[]): boolean {
  let turnStart: number | undefined
  let turnEnd: number | undefined
  for (const event of prefix) {
    if (event.type === 'turn/start') turnStart = event.seq
    if (event.type === 'turn/end') turnEnd = event.seq
  }
  if (turnStart === undefined) return true // 没有开启任何轮
  return turnEnd !== undefined && turnEnd >= (turnStart ?? 0)
}

export type { SessionEventMap, SessionEvent, EventInput, AppendedEvent, SessionEventType } from './types.ts'
