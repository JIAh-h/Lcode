/** 子代理的委托输入。父会话是唯一可审计入口，不能由子代理自行选择任意会话。 */
export interface SubagentRunInput {
  readonly parentSessionId: string
  readonly parentAgentId?: string | undefined
  readonly task: string
  /** 父链当前深度；provider 只能接受未超过自身上限的值。 */
  readonly depth?: number | undefined
  /** 请求名单只能进一步收窄 provider 的默认能力，不能扩权。 */
  readonly allowedToolIds?: readonly string[] | undefined
}

export interface SubagentRunResult {
  readonly delegationId: string
  readonly childSessionId?: string | undefined
  readonly depth: number
  readonly outcome: 'completed' | 'failed' | 'depth-denied'
  readonly result?: string | undefined
  readonly error?: string | undefined
}

/** SubagentService —— 子代理（能力只可收窄，深度有限） */
export interface SubagentService {
  run(input: SubagentRunInput): Promise<SubagentRunResult>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    subagents: SubagentService
  }
}
