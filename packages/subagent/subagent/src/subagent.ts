/** 子代理的委托输入。父会话是唯一可审计入口，不能由子代理自行选择任意会话。 */
export interface SubagentRunInput {
  readonly parentSessionId: string
  readonly parentAgentId?: string | undefined
  readonly task: string
  /** 父链当前深度；provider 只能接受未超过自身上限的值。 */
  readonly depth?: number | undefined
  /** 请求名单只能进一步收窄 provider 的默认能力，不能扩权。 */
  readonly allowedToolIds?: readonly string[] | undefined
  /**
   * 父级的取消信号（**取消传播**）。
   *
   * 会话内的子代理是父会话为完成同一任务而开的内部执行单元，不是独立任务：
   * 父级 abort（用户点暂停、回合被取消、agent 被 dispose）必须一并中止它。
   * 否则会出现"界面显示已停止、子代理仍在后台烧 token、事后又冒出一条完成事件"。
   *
   * 跨会话的 Worker 相反——那是独立任务，取消应当隔离（见 docs/25 P10-06）。
   */
  readonly signal?: AbortSignal | undefined
}

/**
 * 子代理的结构化产物。
 *
 * ## 为什么不再只有一句 `result`
 *
 * 旧的返回是"末条 assistant 的纯文本"。父代理据此无法判断子代理**做了什么**：
 * 改了哪些文件、调了几次工具、花了多少 token 全丢了，于是它只能把摘要原样复述，
 * 或在需要引用具体路径时再猜一次。这里把会话日志里已有的事实直接投影出来。
 */
export interface SubagentArtifacts {
  /** 子会话里成功写入/编辑过的文件（按出现顺序去重，取自 `tool/call` 的 parsed 入参） */
  readonly changedPaths: readonly string[]
  /** 工具调用次数（`tool/call` 计数，含失败） */
  readonly toolCalls: number
  /** 失败的工具结果数（`tool/result` 中 `error` 存在或 message.isError） */
  readonly failedToolCalls: number
  /** 子会话消耗的 token（累加自 `assistant/message.usage`）；供应商没给则为 undefined */
  readonly usage?: { readonly input?: number | undefined; readonly output?: number | undefined } | undefined
  /** 子会话事件条数，便于父代理判断"值不值得展开读" */
  readonly events: number
}

export interface SubagentRunResult {
  readonly delegationId: string
  readonly childSessionId?: string | undefined
  readonly depth: number
  /**
   * `cancelled` 与 `failed` 必须分开：前者表示**父级中止了它**（取消传播），
   * 后者表示子代理自己跑挂了。父会话回放到此事件时，靠这个区分"用户不要了"
   * 和"出了错"，否则审批/失败统计会把用户主动取消算成故障。
   */
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'depth-denied'
  /** 末条 assistant 的纯文本（保持旧语义：父代理直接可读的结论） */
  readonly result?: string | undefined
  readonly error?: string | undefined
  /** 结构化产物；失败、取消或深度拒绝时为 undefined */
  readonly artifacts?: SubagentArtifacts | undefined
}

/** 异步派发的回执：子代理已在后台开跑，父会话不必等待。 */
export interface SubagentStartReceipt {
  readonly delegationId: string
  readonly childSessionId: string
  readonly depth: number
}

/**
 * SubagentService —— 子代理（能力只可收窄，深度有限）。
 *
 * ## 同步与异步是同一套实现的两个门面
 *
 * `run` 保留同步语义（delegate 工具用它）：调用方等到子代理结束才拿到结果。
 * `start` 立刻返回回执，结果通过 `wait` 取，或用 `collect` 读当前已落盘的事实。
 *
 * 两者共用 `runSubagent` 的内部三阶段（创建 → 执行 → 汇总），因此审计事件、
 * 深度校验、工具收窄、dispose 清理的行为完全一致——不会出现"异步那条路忘了记事件"。
 */
export interface SubagentService {
  /** 同步：等到子代理结束后返回完整结果（delegate 工具使用） */
  run(input: SubagentRunInput): Promise<SubagentRunResult>
  /** 异步：立刻返回回执，子代理在后台继续跑 */
  start(input: SubagentRunInput): Promise<SubagentStartOutcome>
  /** 等待某个已派发的子代理结束；已结束则立刻返回。未知 id 返回 undefined。 */
  wait(delegationId: string): Promise<SubagentRunResult | undefined>
  /** 读取派发状态（不阻塞）；用于父会话在后续步骤里检查进度。 */
  status(delegationId: string): SubagentTaskStatus | undefined
  /** 当前仍未结束的派发 id（会话级清理用） */
  pending(): readonly string[]
}

/** `start` 的结果：要么已派发，要么当场失败（参数/深度/工作区不满足）。 */
export type SubagentStartOutcome =
  | { readonly kind: 'started'; readonly receipt: SubagentStartReceipt }
  | { readonly kind: 'rejected'; readonly result: SubagentRunResult }

export interface SubagentTaskStatus {
  readonly delegationId: string
  readonly childSessionId: string
  readonly depth: number
  readonly task: string
  /** running = 子会话仍在跑；settled = 已有终态（此时 status 只是快照） */
  readonly state: 'running' | 'settled'
  /** settled 时的结果 */
  readonly result?: SubagentRunResult | undefined
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    subagents: SubagentService
  }
}
