import type { JsonValue } from '@lcode/util'

/**
 * ────────────────────────────────────────────────────────────────
 * Lcode 事件数据模型（文档 06 §2 + 22 §5 字段字典 + 22 §6 枚举）
 * ────────────────────────────────────────────────────────────────
 * SessionEventMap 是**开放**接口（声明合并）：插件可新增日志事件而不改内核（06 §2.2）。
 * 因为开放，switch (event.type) 不能用 assertNever，必须写 default 兜底（06 §2.3）。
 */

// ─────────── 枚举（22 §6） ───────────

/** 轮结束原因（22 §6.2 会话/agent 状态） */
export type TurnEndReason = 'completed' | 'cancelled' | 'interrupted' | 'error'

/** 审批结果四态（22 §6.5；rejected 与 cancelled 是两个不同的事实，不得合并） */
export type ApprovalResult = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 工具卡片类型（22 §6.3） */
export type CardType = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'

/** agent 状态（20 §5.4 AgentHandle） */
export type AgentStatus = 'idle' | 'running' | 'waiting-approval' | 'cancelled'

/** 请求快照原因（06 待补充完整集合，骨架先列已知值） */
export type RequestHeaderReason = 'new-epoch' | 'continuation' | 'model-switch'

/** 审批展示的影响面（12 §5.4） */
export interface Impact {
  readonly kind: 'write' | 'exec' | 'network' | 'other'
  readonly summary: string
}

// ─────────── 消息与内容块 ───────────

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: JsonValue }
  | {
      readonly type: 'tool_result'
      readonly toolCallId: string
      readonly content: string | readonly ContentBlock[]
      readonly isError: boolean
    }

export interface UserMessage {
  readonly role: 'user'
  readonly content: string | readonly ContentBlock[]
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: readonly ContentBlock[]
  /** 来源标注（provider / model），来自适配器 */
  readonly provider?: string
  readonly model?: string
}

export interface ToolResultMessage {
  readonly role: 'user'
  readonly toolCallId: string
  readonly content: string | readonly ContentBlock[]
  readonly isError: boolean
}

/** 模型可见消息：三种角色（文档 06 §2.2：表面只含这三类） */
export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage

export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly total?: number
}

/** 待办项（todo/write 整表快照，last-write-wins，06 §2.2） */
export interface TodoItem {
  readonly id: string
  readonly text: string
  readonly status: 'pending' | 'in-progress' | 'done'
}

// ─────────── 流协议（闭合联合） ───────────

/**
 * StreamChunk：流式协议是 provider 与内核之间的**严格契约**（06 §2.3）。
 * 闭合联合——加变体必须让所有处理者编译失败，而不是静默漏处理。
 */
export type StreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly callId: string; readonly name: string; readonly argsDelta: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'done'; readonly message: AssistantMessage; readonly usage?: TokenUsage }

/** 请求快照（request/header 事件，09 文档 EpochHeader 的骨架简化） */
export interface EpochHeader {
  readonly provider: string
  readonly model: string
  readonly systemFingerprint: string
  readonly toolsFingerprint: string
}

/** request/context 事件载荷（骨架：外部上下文来源清单） */
export interface RequestContext {
  readonly sources: readonly string[]
}

// ─────────── 事件词汇表 ───────────

/**
 * 事件判别字段 → data 载荷（开放，声明合并扩展）：
 *
 *   declare module '@lcode/session' {
 *     interface SessionEventMap {
 *       'myplugin/custom': { foo: string }
 *     }
 *   }
 */
export interface SessionEventMap {
  // ─────────── 结构边界 ───────────
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }

  // ─────────── 表面事件（会产生模型可见消息） ───────────
  'user/message': UserMessage
  'assistant/message': {
    readonly turn: number
    readonly step: number
    readonly message: AssistantMessage
    readonly usage?: TokenUsage
    /** 流式被打断但有可见内容时为 true */
    readonly interrupted?: true
  }
  'tool/result': {
    readonly turn: number
    readonly step: number
    readonly message: ToolResultMessage
    readonly error?: { readonly name: string; readonly code: string }
    /** 可重放的 UI 元数据（如 diff 的 hunk） */
    readonly meta?: JsonValue
  }

  // ─────────── 日志事件（不进模型历史） ───────────
  'assistant/chunk': { readonly turn: number; readonly step: number; readonly chunk: StreamChunk }
  'tool/call': {
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly name: string
    /** ⚠️ 未解析的原始 JSON 字符串，不是对象（D9：参数不可被改写） */
    readonly arguments: string
  }
  'request/header': { readonly header: EpochHeader; readonly reason: RequestHeaderReason }
  'request/context': RequestContext
  /** 生命周期分界线：空载荷，靠位置表达含义（11 §7） */
  'session/end-seed': Record<string, never>
  /** 待办整表快照，last-write-wins */
  'todo/write': { readonly todos: readonly TodoItem[] }
  /** 计划模式：整值替换 */
  'plan/mode': { readonly active: boolean }
  'approval/asked': {
    readonly callId: string
    readonly action: string
    readonly basis: string
    readonly impact: Impact
  }
  'approval/decided': { readonly callId: string; readonly result: ApprovalResult }
  'compaction/start': { readonly compactionId: string }
  'compaction/summary': { readonly compactionId: string; readonly summary: string }
  'compaction/end': { readonly compactionId: string }
}

export type SessionEventType = keyof SessionEventMap

/** 表面操作（D5：压缩的唯一原语；不做删除） */
export type SurfaceOp = 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number }

/**
 * 事件信封（06 §2.1）。
 * seq = log.length（不变量 I2）；time 为 epoch ms（D18）；
 * ignorable 缺省即**不可跳过**——读到不认识的必需事件类型时拒绝重建会话（06 §2.1）。
 */
export interface SessionEventEnvelope<K extends SessionEventType = SessionEventType> {
  readonly type: K
  readonly seq: number
  readonly time: number
  readonly data: SessionEventMap[K]
  /** 仅表面事件携带 */
  readonly surfaceOp?: SurfaceOp
  /** 血缘：更早的 seq 列表（06 §6.2） */
  readonly sourceEventSeqs?: readonly number[]
  /** 向前兼容标记 */
  readonly ignorable?: true
}

export type SessionEvent<K extends SessionEventType = SessionEventType> = SessionEventEnvelope<K>

/** 追加事件时的输入（seq 由 session 模块分配，调用方不得传入） */
export type EventInput<K extends SessionEventType = SessionEventType> = Omit<
  SessionEventEnvelope<K>,
  'seq' | 'time'
> & {
  readonly time?: number
}

/** 追加后的完整事件（seq / time 已物化） */
export type AppendedEvent<K extends SessionEventType = SessionEventType> = SessionEventEnvelope<K>

/** 表面事件类型集合（06 §3.1：表面只包含这三类事件） */
export const SURFACE_EVENT_TYPES: readonly SessionEventType[] = [
  'user/message',
  'assistant/message',
  'tool/result',
]

export function isSurfaceEventType(type: string): type is 'user/message' | 'assistant/message' | 'tool/result' {
  return type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
}
