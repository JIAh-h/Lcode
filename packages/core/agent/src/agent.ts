import type { AgentId, SessionId } from '@lcode/util'
import type { ContentBlock } from '@lcode/session'

/**
 * Agent 契约（文档 20 §5.4）。
 * ctx key: `ctx.agents`（复数 = 注册表）。
 */

export type AgentStatus = 'idle' | 'running' | 'waiting-approval' | 'cancelled'

export interface AgentSpec {
  /** 缺省时与会话共享同一 id（D17）；全局唯一 */
  readonly id?: AgentId
  readonly sessionId: SessionId
  readonly name?: string
  /** 装配引用（agent.cordis.yml / profile），骨架只透传 */
  readonly presetRef?: string
}

/**
 * 用户输入（两形态）：
 * - `text`：纯文本（常用捷径）
 * - `content`：完整 ContentBlock[]（与 `sessions.append` 的 user/message 同构，docs/21 §2.2）
 */
export type UserInput = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'content'; readonly content: readonly ContentBlock[] }

export type InjectedContext = { readonly content: string; readonly source: string }

/**
 * 取消原因：对齐 docs/21 §2.0 的 `CancellationCause`（user/parent/hook/dispose），
 * 并保留循环内部使用的 error / max-steps。
 */
export type CancelReason = 'user' | 'parent' | 'hook' | 'dispose' | 'error' | 'max-steps'

/** AgentHandle：disposer 就是能力——销毁即回滚（A4） */
export interface AgentHandle {
  readonly id: AgentId
  readonly sessionId: SessionId
  readonly status: AgentStatus
  /** 追加一轮（队列尾部） */
  followup(input: UserInput): Promise<void>
  /** 在当前轮的下一个步边界生效（插话） */
  steer(input: UserInput): Promise<void>
  /** 不改对话可见内容，只入上下文 */
  inject(input: InjectedContext): Promise<void>
  cancel(reason: CancelReason): Promise<void>
  /** 销毁即回滚；之后不得再有该 agent 的事件（A4） */
  dispose(): Promise<void>
}

/** 恢复/分叉时的引用 */
export interface AgentRef {
  readonly sessionId: SessionId
  readonly agentId: AgentId
}

/** 发起者引用（子代理归属链） */
export type InitiatorRef = AgentRef

export interface AgentService {
  create(spec: AgentSpec): Promise<AgentHandle>
  resume(ref: AgentRef): Promise<AgentHandle>
  get(agentId: AgentId): AgentHandle | undefined
  list(): readonly AgentHandle[]
  /** 让后续操作归属到某个发起者 */
  withInitiator<T>(initiator: InitiatorRef, fn: () => Promise<T>): Promise<T>
}

declare module '@lcode/context' {
  interface Events {
    'agent/created': { agentId: string; sessionId: string }
    'agent/status': { agentId: string; status: AgentStatus; reason?: string }
    'agent/inbox': { agentId: string; kind: 'followup' | 'steer' | 'inject' }
    'agent/disposed': { agentId: string }
  }
  /** ctx key（文档 20 §5.4）：复数 = 注册表 */
  interface Services {
    agents: AgentService
  }
}
