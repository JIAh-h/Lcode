import type { ContentBlock, ModelMessage, SessionEvent } from '@lcode/session'

export interface HistorySnapshot {
  readonly header: unknown
  readonly messages: readonly ModelMessage[]
  readonly chunks: readonly unknown[]
  readonly toolCalls: readonly ReplayToolCall[]
  readonly decisions: readonly unknown[]
}

export interface ReplayToolCall {
  readonly call: {
    readonly seq: number
    readonly call_id: string
    readonly name: string
    readonly card?: string | undefined
    readonly arguments: string
  }
  readonly result?: {
    readonly role: 'user'
    readonly toolCallId: string
    readonly content: string | readonly ContentBlock[]
    readonly isError: boolean
  } | undefined
}

export interface HistoryBodyResult {
  readonly bytes: number
  readonly ref: string
  readonly data: unknown
}

export interface SessionMeta {
  readonly session_id: string
  readonly workspace: string | null
  readonly title: string
  readonly status: 'idle' | 'busy' | 'waiting-approval' | 'error'
  readonly last_seq: number
  readonly updated_at: number
  readonly created_at: number
  readonly deleted_at: number | null
  readonly archived_at: number | null
}

/** 回收站条目（永久归档后的文件；到期后可被清理，不可恢复） */
export interface TrashEntry {
  readonly session_id: string
  readonly path: string
  readonly bytes: number
  readonly deleted_at: number
  /** 展示用内容标签（首条用户消息或标题）；旧条目可能为空 */
  readonly label: string
  readonly expires_in_ms: number
}

export interface OpenedSession {  readonly meta: SessionMeta
  readonly events: readonly SessionEvent[]
  readonly history: { readonly messages: readonly ModelMessage[] }
  readonly repaired: boolean
  readonly closers: readonly SessionEvent[]
  readonly last_turn_errored?: boolean
}

export interface SessionBridge {
  list(input?: { readonly limit?: number; readonly cursor?: string; readonly includeDeleted?: boolean }): Promise<{
    readonly items: readonly SessionMeta[]
    readonly nextCursor?: string | undefined
  }>
  trash(): Promise<{ readonly items: readonly TrashEntry[]; readonly total_bytes: number }>
  emptyTrash(): Promise<unknown>
  create(input: unknown): Promise<{ readonly session_id: string; readonly last_seq: number }>
  open(sessionId: string): Promise<OpenedSession>
  delete(input: { readonly session_id: string }): Promise<unknown>
  restore(input: { readonly session_id: string }): Promise<unknown>
  rename(input: { readonly session_id: string; readonly title: string }): Promise<{ readonly session_id: string; readonly title: string }>
  purge(input: { readonly session_id: string; readonly force?: boolean }): Promise<unknown>
  export(input: { readonly session_id: string; readonly format: 'jsonl' | 'md' | 'bundle' }): Promise<{
    readonly path: string
    readonly bytes: number
    readonly sha256: string
  }>
  import(input: { readonly path: string; readonly title?: string }): Promise<{
    readonly session_id: string
    readonly last_seq: number
    readonly imported_events: number
  }>
  fork(input: { readonly source_session_id: string; readonly boundary: number }): Promise<{ readonly session_id: string }>
  history(input: { readonly session_id: string; readonly up_to_seq: number }): Promise<HistorySnapshot>
  body(input: { readonly session_id: string; readonly seq: number }): Promise<HistoryBodyResult>
  why(input: { readonly session_id: string; readonly call_seq: number }): Promise<unknown>
  checkpoints(input: { readonly session_id: string }): Promise<readonly { readonly turn: number; readonly end_seq: number; readonly ended_at: number; readonly reason: string }[]>
  fileCheckpoints(input: { readonly session_id: string }): Promise<readonly FileCheckpointMeta[]>
  restoreCheckpoint(input: { readonly session_id: string; readonly checkpoint_id: string }): Promise<{ readonly restoredPaths: readonly string[]; readonly removedPaths: readonly string[] }>
  /** 编辑后重发：回退该提问之后的日志与文件改动，再重新发送 */
  rewindSend(input: {
    readonly session_id: string
    readonly to_seq: number
    readonly text: string
    readonly skills?: readonly string[]
    readonly images?: readonly { readonly mediaType: string; readonly data: string }[]
  }): Promise<{
    readonly accepted: true
    readonly rewind: {
      readonly discarded: number
      readonly restored: readonly string[]
      readonly removed: readonly string[]
      readonly unrestored: readonly string[]
    }
  }>
  /** 重试最后一轮：只允许没有工具副作用的回合，清掉失败回答后原样重发 */
  retryTurn(input: { readonly session_id: string }): Promise<{
    readonly accepted: true
    readonly retry: { readonly discarded: number }
  }>
  /** 输入框状态栏：上下文占用估算（2 字符/token） */
  contextUsage(sessionId: string): Promise<SessionContextUsage>
  /** 手动压缩较早历史；摘要由当前默认模型生成 */
  compact(sessionId: string): Promise<CompactResult>
  /** 压缩预览：生成摘要并展示范围，不修改日志 */
  compactPreview(input: { readonly session_id: string; readonly keep_recent_turns?: number }): Promise<CompactionPreview>
  compactApply(input: { readonly session_id: string; readonly preview_id: string }): Promise<CompactResult>
  compactUndo(input: { readonly session_id: string; readonly compaction_id: string }): Promise<{ readonly status: 'undone' | 'not-found' | 'not-visible' | 'not-completed' }>
  /** 固定/屏蔽某一轮 */
  marker(input: { readonly session_id: string; readonly target_seq: number; readonly pinned?: boolean; readonly muted?: boolean }): Promise<{ readonly target_seq: number; readonly pinned: boolean; readonly muted: boolean }>
  onEvent(handler: (payload: unknown) => void): () => void
  onChunks(handler: (payload: unknown) => void): () => void
  onTurnFailed(handler: (payload: unknown) => void): () => void
  onChanged(handler: (payload: unknown) => void): () => void
}

export interface AgentBridge {
  send(input: {
    readonly session_id: string
    readonly text: string
    readonly skills?: readonly string[]
    readonly images?: readonly { readonly mediaType: string; readonly data: string }[]
  }): Promise<{ readonly accepted: true; readonly queue_id: string }>
  steer(input: { readonly session_id: string; readonly text: string }): Promise<{ readonly accepted: true; readonly mode: 'steered' | 'queued' }>
  queue: {
    list(input: { readonly session_id: string }): Promise<{ readonly items: readonly QueuedMessage[] }>
    edit(input: { readonly session_id: string; readonly queue_id: string; readonly text: string }): Promise<{ readonly updated: boolean }>
    remove(input: { readonly session_id: string; readonly queue_id: string }): Promise<{ readonly removed: boolean }>
    clear(input: { readonly session_id: string }): Promise<{ readonly removed: number }>
    guide(input: { readonly session_id: string; readonly queue_id: string }): Promise<{ readonly guided: boolean }>
  }
  cancel(sessionId: string): Promise<unknown>
  resume(sessionId: string): Promise<unknown>
}

export interface SessionContextUsage {
  readonly contextWindowTokens: number | null
  readonly usedTokens: number
  readonly percent: number | null
  readonly usageSource: 'provider' | 'mixed' | 'estimate'
  readonly measurement: {
    readonly revision: number
    readonly surfaceTokens: number
    readonly systemTokens: number
    readonly toolSchemaTokens: number
    readonly imageTokens: number
    readonly summaryTokens: number
    readonly total: number
    readonly observedInputTokens: number
    readonly observedOutputTokens: number
    readonly providerTotal?: number | undefined
    readonly providerDeltaTokens?: number | undefined
  }
  readonly provenance: {
    readonly sources: readonly string[]
    readonly contextTokens: number
    readonly skills: readonly { readonly id: string; readonly name: string }[]
    readonly images: number
    readonly summary: boolean
  }
  readonly compaction: {
    readonly compactionId: string
    readonly originalChars: number
    readonly summaryChars: number
    readonly shadowedSeqs: readonly number[]
    readonly canUndo: boolean
  } | null
}

export interface CompactionPreview {
  readonly previewId: string
  readonly summary: string
  readonly plan: {
    readonly start: 0
    readonly end: number
    readonly prefixChars: number
    readonly keptItems: number
    readonly compactedItems: number
    readonly totalItems: number
    readonly keptTurns: number
    readonly totalTurns: number
    readonly pinnedTurns: number
  }
  readonly originalChars: number
  readonly summaryChars: number
  readonly revision: number
}

export interface CompactResult {
  readonly status: 'compacted' | 'not-beneficial' | 'invalid-range' | 'tool-boundary' | 'active-transaction' | 'pinned-turn'
  readonly originalChars: number
  readonly summaryChars: number
  readonly compactionId?: string | undefined
}

export interface WorkspaceGitInfo {
  readonly isRepo: boolean
  readonly branch: string | null
  readonly mode: 'local' | 'worktree'
}

export interface WorkspaceInfoBridge {
  gitInfo(path: string): Promise<WorkspaceGitInfo>
}

export function workspaceInfoBridge(): WorkspaceInfoBridge | undefined {
  return (globalThis as unknown as { lcode?: { workspace?: WorkspaceInfoBridge } }).lcode?.workspace
}

export interface FileCheckpointMeta {  readonly checkpointId: string
  readonly turn: number
  readonly endSeq: number
  readonly createdAt: number
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly trackedPaths: readonly string[]
  readonly partial: boolean
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

export interface QueuedMessage {
  readonly queue_id: string
  readonly content: readonly ContentBlock[]
}

/** P3 活动任务桥：资源只存在于当前桌面主进程，不由新开进程恢复。 */
export interface TaskBridge {
  list(input: { readonly session_id: string }): Promise<unknown>
  readJob(input: { readonly session_id: string; readonly job_id: string; readonly since_offset?: number }): Promise<unknown>
  killJob(input: { readonly session_id: string; readonly job_id: string }): Promise<unknown>
  readTerminal(input: { readonly session_id: string; readonly terminal_id: string; readonly since_offset?: number }): Promise<unknown>
  closeTerminal(input: { readonly session_id: string; readonly terminal_id: string }): Promise<unknown>
}

export interface PlanBridge {
  enter(input: { readonly session_id: string }): Promise<unknown>
  confirm(input: { readonly session_id: string }): Promise<unknown>
}

export interface WorkspaceTrustBridge {
  list(): Promise<readonly { readonly path: string; readonly trustedAt: number }[]>
  set(input: { readonly workspace: string; readonly trusted: boolean; readonly session_id?: string }): Promise<{ readonly workspace: string; readonly trusted: boolean }>
}

export interface AttachmentBridge {
  read(input: { readonly hash: string; readonly media_type: string }): Promise<{ readonly media_type: string; readonly data: string }>
}

export function attachmentBridge(): AttachmentBridge | undefined {
  return (globalThis as unknown as { lcode?: { attachments?: AttachmentBridge } }).lcode?.attachments
}

export function sessionBridge(): SessionBridge | undefined {
  return (globalThis as unknown as { lcode?: { session?: SessionBridge } }).lcode?.session
}

export function agentBridge(): AgentBridge | undefined {
  return (globalThis as unknown as { lcode?: { agent?: AgentBridge } }).lcode?.agent
}

export function taskBridge(): TaskBridge | undefined {
  return (globalThis as unknown as { lcode?: { tasks?: TaskBridge } }).lcode?.tasks
}

export function planBridge(): PlanBridge | undefined {
  return (globalThis as unknown as { lcode?: { plan?: PlanBridge } }).lcode?.plan
}

export function workspaceTrustBridge(): WorkspaceTrustBridge | undefined {
  return (globalThis as unknown as { lcode?: { workspaceTrust?: WorkspaceTrustBridge } }).lcode?.workspaceTrust
}

export function notifySessionChanged(): void {
  window.dispatchEvent(new Event('lcode:session-changed'))
}
