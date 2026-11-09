/**
 * 跨会话编排的服务契约（26 §3 / §4 / §6 / §7）。
 *
 * ## 与 `SubagentService` 的区别（26 §1.1 必须分清）
 *
 * | | subagent | worker |
 * | --- | --- | --- |
 * | 边界 | **一个会话内部** | **跨会话** |
 * | 生命周期 | 跟随父会话（取消传播） | 独立（取消隔离） |
 * | 用户可见 | 否 | 是 |
 *
 * 二者共享"独立子会话 + 工具收窄 + 结构化结果 + 异步"这些**底层能力**，但
 * 生命周期与可见性相反，因此是不同的服务、不同的事件族（26 §4.1）。
 */

/** 派发请求。Router 每派一个任务就产生一次。 */
export interface WorkerDispatchInput {
  /** 发起派发的 Router 会话 */
  readonly routerSessionId: string
  /** 派给 worker 的任务描述（模型可读） */
  readonly task: string
  /** 工作区；缺省沿用 Router 的工作区 */
  readonly workspaceRoot?: string | undefined
  /** Router 的判断依据（落事件，供回放解释"为什么派这个"） */
  readonly reason?: string | undefined
  /** 调用方取消信号。**注意：worker 不继承 Router 的取消**（26 §6），这里只用于"派发这一动作"本身被取消 */
  readonly signal?: AbortSignal | undefined
}

/** 派发后立刻返回的回执。 */
export interface WorkerDispatchReceipt {
  readonly taskId: string
  readonly workerSessionId: string
  /** `observe` 档下为 false：记录了本该派发的动作，但没有真的建会话（26 §7.4） */
  readonly materialized: boolean
}

export type WorkerState = 'running' | 'settled'

export interface WorkerStatus {
  readonly taskId: string
  readonly workerSessionId: string
  readonly routerSessionId: string
  readonly task: string
  readonly state: WorkerState
  readonly dispatchedAt: number
  readonly completedAt?: number | undefined
  readonly outcome?: WorkerOutcome | undefined
  /** `observe` 预演记录没有真实 worker 会话时，workerSessionId 为空串 */
  readonly preview?: boolean | undefined
}

export type WorkerOutcome = 'completed' | 'failed' | 'cancelled'

export interface WorkerCompletion {
  readonly taskId: string
  readonly workerSessionId: string
  readonly outcome: WorkerOutcome
  readonly summary?: string | undefined
  readonly artifacts?:
    | {
        readonly changedPaths: readonly string[]
        readonly toolCalls: number
        readonly failedToolCalls: number
        readonly usage?: { readonly input?: number | undefined; readonly output?: number | undefined } | undefined
        readonly events: number
      }
    | undefined
  readonly error?: string | undefined
}

/**
 * 编排服务（ctx key：`orchestration`）。
 *
 * ## 为什么 `dispatch` 是同步回执而不是 Promise<结果>
 *
 * Router 派发完就该去做别的判断，等结果会让 Router 退化成串行执行器——
 * 正是 super-agent 要消除的东西（26 §5.1）。结果通过 `worker/completed`
 * 事件异步回传。
 */
export interface OrchestrationService {
  /** 当前授权档位（26 §7.4） */
  mode(): OrchestrationMode
  /** 切换授权档位；落 `orchestration/mode` 事件 */
  setMode(mode: OrchestrationMode, reason?: string): void

  /** 派发一个 worker，立刻返回回执 */
  dispatch(input: WorkerDispatchInput): Promise<WorkerDispatchReceipt>
  /** 列出 worker；可按 Router 过滤 */
  list(input?: { readonly routerSessionId?: string | undefined }): readonly WorkerStatus[]
  /** 单个 worker 状态；未知 id 返回 undefined */
  status(taskId: string): WorkerStatus | undefined
  /**
   * 取消一个 worker 的**当前 turn**（26 §6）。
   *
   * 取消隔离的出口：只停该 worker 的当前回合，不销毁会话、不删日志，
   * 与 `agents.cancel` 的粒度一致（P0-04）。
   */
  cancel(taskId: string): Promise<boolean>
  /** 在途 worker 数（用于上限判断，26 §7.5） */
  running(routerSessionId?: string): number
}

export type OrchestrationMode = 'off' | 'observe' | 'auto'

/** 并发上限默认值（26 §7.5.2）。0 = 不限。 */
export const DEFAULT_MAX_CONCURRENT_WORKERS = 8

/** worker **不允许**再派发 worker（26 §7.5.2）：深度硬编码为 1，不可配置。 */
export const MAX_WORKER_DISPATCH_DEPTH = 1

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    orchestration: OrchestrationService
  }
}

// 必须真实 import 一次，模块增强才能解析到 `@lcode/context` 的声明。
// 只写 `declare module` 而从不 import，TS 会报 TS2664（模块名无法解析）。
export type {} from '@lcode/context'
