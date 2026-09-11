/** SubagentService —— 子代理（能力只可收窄，深度有限） */
export interface SubagentService {
  run(input: { readonly task: string; readonly depth: number; readonly allowedToolIds?: readonly string[] }): Promise<{ readonly result: string }>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    subagents: SubagentService
  }
}
