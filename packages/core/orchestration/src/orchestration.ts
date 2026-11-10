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
  /**
   * 边界：**不要**做什么（26 §5.5）。
   *
   * 没有它，worker 只知道自己要做什么，不知道哪里不该碰——跨会话场景里
   * 这是返工的主要来源。对应官方 Ticket 的 scope 段。
   */
  readonly scope?: string | undefined
  /**
   * 完成判据：**什么算做完**（26 §5.5）。
   *
   * 让"完成"可验证，而不是由 worker 自己定义。对应官方 Mandate 里的交付要求。
   */
  readonly doneWhen?: string | undefined
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
  /**
   * worker 正在等人回答（26 §5.6）。
   *
   * 它与 `running` 的区别是**谁在等**：`running` 是 worker 自己在干活，
   * `needsInput` 是它卡住了、等你一句话。后者必须被看见，不能静默。
   */
  readonly needsInput?: boolean | undefined
  /** worker 提出的问题（`needsInput` 时给出） */
  readonly question?: string | undefined
}

export type WorkerOutcome = 'completed' | 'failed' | 'cancelled' | 'needs-input'

/**
 * 从 Router 追加给 worker 的一条输入（26 §5.5）。
 *
 * 三种用法共用一个原语：运行中补充要求、完成后追问细节、回答 worker 的求助。
 */
export interface WorkerInjectInput {
  readonly taskId: string
  /** 追加的文本（模型可读） */
  readonly text: string
  /** 为什么追加（落事件，供回放解释 worker 为何改道） */
  readonly reason?: string | undefined
}

/**
 * worker 主动回传（26 §5.6）。
 *
 * 与"事后从日志投影摘要"的区别：这是 worker **主动表达意图**，能区分
 * 进度 / 求助 / 完成。日志投影仍然保留作为兜底——不依赖模型守规矩。
 */
export interface WorkerReportInput {
  /** 发起汇报的 worker 会话（由编排服务反查 taskId） */
  readonly workerSessionId: string
  readonly kind: WorkerReportKind
  readonly summary: string
  /** `kind: 'question'` 时必填 */
  readonly question?: string | undefined
  /** 需要什么才能继续（文件、决策、权限…） */
  readonly needs?: readonly string[] | undefined
}

/**
 * 回传意图（26 §5.6）。
 *
 * | kind | 是否唤醒 Router |
 * | --- | --- |
 * | `progress` | 否（记录即可，避免刷屏） |
 * | `question` | **是，且绕过批处理**（求助不能等窗口） |
 * | `done` | 是（受 §5.3 批处理约束） |
 */
export type WorkerReportKind = 'progress' | 'question' | 'done'

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
  /** 当前授权档位（26 §7.4）。**全局兜底值**，用于没有会话上下文的场合。 */
  mode(): OrchestrationMode
  /**
   * 某个会话的授权档位（26 §7.4）。
   *
   * 档位是**按会话**的，不是全局一个值：`observe`（只记录）还是 `auto`（真派发）
   * 是"这次任务我愿不愿意让它花钱"的判断，而不同 Router 会话面对的信任程度不同。
   *
   * 解析顺序：该会话最近一条 `orchestration/mode` 事件 → 全局兜底。
   */
  modeFor(sessionId: string): OrchestrationMode
  /**
   * 切换授权档位并落 `orchestration/mode` 事件。
   *
   * 传 `sessionId` 表示只改那个会话；不传则改全局兜底值。
   */
  setMode(mode: OrchestrationMode, reason?: string, sessionId?: string): void

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
  /**
   * 向已存在的 worker 追加一条输入（26 §5.5）。
   *
   * 这是 Router → Worker 的**唯一**持续通道，三种用法共用：
   *
   * | worker 处于 | 行为 |
   * | --- | --- |
   * | `running` | 进该会话的串行队列，成为下一个回合（不打断当前步） |
   * | `settled` / `needs-input` | `agentLoop.resume` 接回原历史继续 |
   *
   * 返回 false 表示 worker 不存在或已销毁。
   */
  inject(input: WorkerInjectInput): Promise<boolean>
  /**
   * worker 主动回传（26 §5.6）。
   *
   * 由 `report_to_router` 工具调用，也允许编排层内部使用。返回 false 表示
   * 找不到对应 taskId（不是 worker 会话，或已被清理）。
   */
  report(input: WorkerReportInput): Promise<boolean>
  /** 由 worker 会话反查 taskId（工具侧用它定位自己的任务） */
  taskIdOf(workerSessionId: string): string | undefined
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
