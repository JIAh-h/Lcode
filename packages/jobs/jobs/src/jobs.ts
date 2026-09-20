import type { ErrorCode } from '@lcode/util'

/** 后台作业的生命周期状态（08 §10.3）。 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** 给作业回调的私有执行上下文。它不继承外层工具调用的取消 signal。 */
export interface JobRunContext {
  readonly signal: AbortSignal
  /** 追加输出到服务维护的有界 UTF-8 缓冲。 */
  write(data: string | Uint8Array): void
}

/** 作业回调完成时可上报的进程事实；非零 exitCode 不是服务错误。 */
export interface JobCompletion {
  readonly exitCode?: number | undefined
  readonly signal?: string | null | undefined
  readonly errorCode?: ErrorCode | undefined
}

/** 启动作业的进程内回调。回调不通过 RPC 传输。 */
export interface JobStartInput {
  readonly kind: string
  readonly label: string
  /** 资源所有权来自执行 scope；未归属的作业仅供受信任的宿主调用。 */
  readonly ownerAgentId?: string | undefined
  readonly outputLimitBytes?: number | undefined
  readonly run: (context: JobRunContext) => Promise<JobCompletion | void>
}

/** 非活引用：调用者只能观察它，不能借快照控制正在运行的作业。 */
export interface JobSnapshot {
  readonly jobId: string
  readonly kind: string
  readonly label: string
  readonly ownerAgentId?: string | undefined
  readonly status: JobStatus
  readonly createdAt: number
  readonly endedAt?: number | undefined
  readonly exitCode?: number | undefined
  readonly signal?: string | null | undefined
  readonly errorCode?: ErrorCode | undefined
  /** 已接收的 UTF-8 输出总字节数，可作为下次 read 的 sinceOffset。 */
  readonly outputOffset: number
  /** 当前保留缓冲的起始 byte offset；更早输出已因上限淘汰。 */
  readonly outputBaseOffset: number
}

export interface JobReadResult {
  readonly output: string
  readonly status: JobStatus
  readonly offset: number
  readonly baseOffset: number
}

/**
 * JobsService —— 发布即脱离的后台作业注册表（21 §2.10）。
 *
 * `ownerAgentId` 在能力层是通过执行 scope 得到的；RPC 边界不会采信不受信任的
 * owner 参数。调用带 owner 的作业时，所有观察与终止操作都必须携带相同 owner。
 */
export interface JobsService {
  start(input: JobStartInput): Promise<{ readonly jobId: string }>
  list(input?: { readonly ownerAgentId?: string | undefined }): readonly JobSnapshot[]
  status(input: { readonly jobId: string; readonly ownerAgentId?: string | undefined }): JobSnapshot
  read(input: { readonly jobId: string; readonly ownerAgentId?: string | undefined; readonly sinceOffset?: number | undefined }): JobReadResult
  kill(input: { readonly jobId: string; readonly ownerAgentId?: string | undefined }): Promise<{ readonly status: JobStatus }>
  /** Agent 释放时终止其仍运行的作业，并等待进程资源释放。 */
  disposeOwner(ownerAgentId: string): Promise<void>
  /** 服务卸载时终止全部仍运行的作业。 */
  dispose(): Promise<void>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    jobs: JobsService
  }
}
