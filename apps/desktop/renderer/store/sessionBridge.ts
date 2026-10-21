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
}

export interface OpenedSession {
  readonly meta: SessionMeta
  readonly events: readonly SessionEvent[]
  readonly history: { readonly messages: readonly ModelMessage[] }
  readonly repaired: boolean
  readonly closers: readonly SessionEvent[]
  readonly last_turn_errored?: boolean
}

export interface SessionBridge {
  list(input?: unknown): Promise<{ readonly items: readonly SessionMeta[] }>
  create(input: unknown): Promise<{ readonly session_id: string; readonly last_seq: number }>
  open(sessionId: string): Promise<OpenedSession>
  delete(input: { readonly session_id: string }): Promise<unknown>
  restore(input: { readonly session_id: string }): Promise<unknown>
  export(input: { readonly session_id: string; readonly format: 'jsonl' | 'md' }): Promise<{
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
  onEvent(handler: (payload: unknown) => void): () => void
  onChunks(handler: (payload: unknown) => void): () => void
  onTurnFailed(handler: (payload: unknown) => void): () => void
  onChanged(handler: (payload: unknown) => void): () => void
}

export interface AgentBridge {
  send(input: { readonly session_id: string; readonly text: string }): Promise<{ readonly accepted: true; readonly queue_id: string }>
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

export interface FileCheckpointMeta {
  readonly checkpointId: string
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
