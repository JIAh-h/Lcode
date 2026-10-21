import type { SessionService } from '@lcode/session'
import type {} from '@lcode/context'

export interface CompactionResult {
  readonly status: 'compacted' | 'not-beneficial' | 'invalid-range' | 'tool-boundary' | 'active-transaction'
  readonly compactionId?: string | undefined
  readonly originalChars: number
  readonly summaryChars: number
  readonly shadowedSeqs: readonly number[]
}

/** CompactionService —— 执行可审计的追加式 surface replace 事务。 */
export interface CompactionService {
  compact(input: {
    readonly session: SessionService
    readonly summary: string
    readonly start?: number | undefined
    readonly end?: number | undefined
    readonly trigger?: 'manual' | 'threshold' | undefined
  }): CompactionResult
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    compaction: CompactionService
  }
}
