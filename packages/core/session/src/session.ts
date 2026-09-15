import type { SessionId } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl, asSeq, freezeLossless, nowEpochMs } from '@lcode/util'
import type { Disposer } from '@lcode/util'
import { deriveMessages } from './surface.ts'
import { isSurfaceEventType } from './types.ts'
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
  /** 已提交的**表面项**数量。维护它是为了让 I4 校验在 `append()` 时就是 O(1) */
  private surfaceCount = 0
  /**
   * 观察者抛错的上报口（可选）。
   *
   * 观察者失败必须被**包含**（06 §5.3）——不能让某个订阅者的异常变成 `append()` 的失败，
   * 也不能掐断其余订阅者。所以这里吞掉异常；但吞掉不等于假装没发生：
   * 传了这个回调就把异常交给它（装配层接 `console.error` / 应用日志 / 遥测）。
   *
   * 为什么是回调而不是"重抛到 `unhandledRejection`"：后者会让每一次订阅者抖动
   * 都污染全局错误处理器（在 vitest 里直接表现为一条失败记录），
   * 与 `SessionWriteBehind` 对定时器路径失败的处理方式（不抛、留给显式路径暴露）也不一致。
   */
  private readonly onObserverError: ((err: unknown, event: SessionEvent) => void) | undefined
  readonly id: SessionId

  constructor(id: SessionId, opts?: { readonly onObserverError?: (err: unknown, event: SessionEvent) => void }) {
    this.id = id
    this.onObserverError = opts?.onObserverError
  }

  get length(): number {
    return this.log.length
  }

  append<K extends SessionEventType>(input: EventInput<K>): AppendedEvent<K> {
    const event = this.materialize(input, this.log.length)
    assertSurfaceOpInRange(event as unknown as SessionEvent, this.surfaceCount)
    this.commit(event as unknown as SessionEvent)
    return event
  }

  appendMany<K extends SessionEventType>(inputs: readonly EventInput<K>[]): readonly AppendedEvent<K>[] {
    if (inputs.length === 0) return []
    // 原子性（S1）：先全部校验 + 物化，再统一入列；任一条失败则整体不提交
    const materialized = inputs.map((input, i) => this.materialize(input, this.log.length + i))
    let surfaceCount = this.surfaceCount
    for (const ev of materialized) {
      assertSurfaceOpInRange(ev as unknown as SessionEvent, surfaceCount)
      if (isSurfaceEventType(ev.type)) surfaceCount += 1
    }
    this.surfaceCount = surfaceCount
    for (const ev of materialized) {
      this.commit(ev as unknown as SessionEvent)
    }
    return materialized
  }

  private commit(event: SessionEvent): void {
    this.log.push(event)
    if (isSurfaceEventType(event.type)) this.surfaceCount += 1
    this.broadcast(event)
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

  /**
   * 同步通知观察者，**逐个包含失败**（06 §5.1 步骤⑤ / §5.3）。
   *
   * 一个观察者抛错既不影响 `append()` 的返回值，也不影响其它观察者看到同一事件。
   * 这不是防御性编程的洁癖：`onEvent` 正是桌面端 UI 事件流的挂载点，
   * 让"某个订阅者出错"升级成"写日志失败"，等于把渲染层的问题变成数据层的损坏。
   */
  private broadcast(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        this.onObserverError?.(err, event)
      }
    }
  }
}

/**
 * I4：`surfaceOp.replace` 的区间必须落在**当前表面范围内**（[start, end)，左闭右开）。
 *
 * 为什么要在 `append()` 时校验而不是等到派生：不变量若只在读取侧检查，等于允许写入
 * 一条**自己都派生不出来**的日志——那正是 11 §6.1「不猜」要避免的局面，而且
 * `index rebuild` 会把整个会话判成损坏。校验成本是 O(1)（维护 `surfaceCount` 计数）。
 */
function assertSurfaceOpInRange(event: SessionEvent, surfaceBefore: number): void {
  const op = event.surfaceOp
  if (op === undefined || op === 'append') return
  // 表面事件会先入表面、再应用 replace，所以当前这条若是表面事件要算进去
  const surfaceLength = surfaceBefore + (isSurfaceEventType(event.type) ? 1 : 0)
  const { start, end } = op
  if (start < 0 || end > surfaceLength || start >= end) {
    throw new RangeError(
      `surface replace 区间越界：start=${start} end=${end} surface 长度=${surfaceLength}（不变量 I4 违规）`,
    )
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
