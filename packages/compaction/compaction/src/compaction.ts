/** 压缩计划：声明要替换的表面区间（D5：追加声明，不删除） */
export interface CompactionPlan {
  readonly compactionId: string
  readonly replaceSurface: { readonly start: number; readonly end: number }
  /** 摘要内容（compaction-summary）或剪枝说明（compaction-prune） */
  readonly summary: string
}

/** CompactionService —— 生成压缩计划（执行 = 追加 surfaceOp: replace 事件） */
export interface CompactionService {
  plan(input: { readonly surface: unknown; readonly tokens: number }): Promise<CompactionPlan | undefined>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    compaction: CompactionService
  }
}
