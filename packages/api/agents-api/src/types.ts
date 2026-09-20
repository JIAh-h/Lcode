import type { AgentStatus } from '@lcode/agent'
import type { ContentBlock } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import type { Disposer } from '@lcode/util'

/**
 * agents.* 的 API 层类型（docs/21 §2.2 / §2.0）。
 * 线上形态对齐契约；ContentBlock 直接复用 @lcode/session 的定义。
 */

/** agents.create 的 options（契约 `options?: AgentOptions`） */
export interface AgentOptions {
  /** 缺省 = 会话 id（D17：agent 与会话共享同一 id） */
  readonly id?: string
  readonly name?: string
  /** 装配引用（agent.cordis.yml / profile），透传给 spec */
  readonly presetRef?: string
}

/** docs/21 §2.0 `EnqueueReceipt`：followup 只传入队回执，不返回轮结果（§5.4 同义） */
export interface EnqueueReceipt {
  readonly accepted: true
  readonly session_id: string
  readonly seq: number
  /** 尚未开始的消息在当前运行时队列中的标识。 */
  readonly queue_id: string
  readonly enqueued_at: number
}

export interface QueuedMessage {
  readonly queue_id: string
  readonly content: readonly ContentBlock[]
}

/** docs/21 §2.0 `CancellationCause` */
export type CancellationCause = 'user' | 'parent' | 'hook' | 'dispose'

/** agents.watch 的流事件。`seq` 只在 idle 时携带：此刻日志长度（「idleSeq ≥ 回执 seq 即跑完」判据） */
export interface AgentStatusEvent {
  readonly agentId: string
  readonly status: AgentStatus
  readonly reason?: string
  readonly seq?: number
  readonly at: number
}

/**
 * 进程内状态流（`Stream<AgentStatusEvent>` 的进程内形态）。
 * - `watch()` 每次调用返回**新的独立流**（幂等重订阅）
 * - 活跃订阅期间事件实时推送；不做历史回放（订阅须先于动作，§2.2 示例的用法）
 */
export class AgentStatusStream {
  private readonly listeners = new Set<(event: AgentStatusEvent) => void>()
  private upstream: (() => void) | null = null

  /** API 内部：把 ctx 订阅的撤销器挂到流上 */
  attachUpstream(dispose: () => void): void {
    this.upstream = dispose
  }

  /** API 内部：推送一条事件 */
  push(event: AgentStatusEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** 订阅；返回撤销器 */
  subscribe(listener: (event: AgentStatusEvent) => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 关闭流（断开上游；已订阅者不再收到事件） */
  close(): void {
    this.listeners.clear()
    this.upstream?.()
    this.upstream = null
  }
}

/** 内容块入参校验（EC-INVALID_PARAMS） */
export function assertContentBlocks(content: readonly ContentBlock[]): void {
  if (!Array.isArray(content) || content.length === 0) {
    throw new LcodeErrorImpl({
      code: ERROR_CODES.EC_INVALID_PARAMS,
      message: 'content 必须是非空 ContentBlock[]',
      userMessage: '这个请求的参数不对。',
      retryable: false,
    })
  }
}
