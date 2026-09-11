import type { SessionEvent, SessionEventType } from '@lcode/session'
import type { Disposer, SessionId } from '@lcode/util'

/**
 * SessionPersistenceService —— 会话持久化契约（文档 22 §1 / D12）。
 * ctx key: `ctx.sessionPersistence`。
 */
export interface SessionPersistenceService {
  /** 打开/创建会话存储（惰性；目录按 22 §2 布局） */
  open(sessionId: SessionId, opts?: { readonly cwd?: string }): Promise<void>
  /** 追加写入（write-behind：同步内存 + 有界批写磁盘，不变量 S5） */
  append(sessionId: SessionId, events: readonly SessionEvent[]): Promise<void>
  /** 强制落盘（静默屏障） */
  flush(sessionId: SessionId): Promise<void>
  /** 读取全部事件（load() 必须还原出完全相同的追加序列，22 §4.1） */
  load(sessionId: SessionId): Promise<readonly SessionEvent[]>
  /** 校验：seq 连续性（I2）/ 配对完整性（I3）/ surface 区间（I4） */
  verify(sessionId: SessionId): Promise<VerificationReport>
  /** 关闭并释放句柄 */
  close(sessionId: SessionId): Promise<void>
  /** 订阅外部变更（revision 不一致 → ES-LOG_MODIFIED_EXTERNALLY） */
  onExternalChange(handler: (sessionId: SessionId) => void): Disposer
}

export interface VerificationReport {
  readonly ok: boolean
  readonly issues: readonly string[]
  readonly eventCount: number
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    sessionPersistence: SessionPersistenceService
  }
}

/** 帧类型（22 §4.1：第 0 帧是头部帧，其后全是事件记录） */
export const FRAME_KIND_HEADER = 'file-header' as const
export const FRAME_KIND_EVENT = 'event' as const

export const SCHEMA_VERSION = 1 as const

export type { SessionEvent, SessionEventType }
