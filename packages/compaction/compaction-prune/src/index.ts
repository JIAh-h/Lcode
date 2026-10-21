import type { Context } from '@lcode/context'
import type {} from '@lcode/agent-loop'
import { deriveVisibleSurfaceItems } from '@lcode/session'
import type { SessionService } from '@lcode/session'
import type { Disposer } from '@lcode/util'

export interface CompactionPruneResult {
  readonly status: 'pruned' | 'not-applicable' | 'not-visible'
  readonly originalChars: number
  readonly previewChars: number
}

export interface CompactionPruneService {
  prune(input: { readonly session: SessionService; readonly sourceEventSeq: number; readonly toolName: string }): CompactionPruneResult
}

declare module '@lcode/context' {
  interface Services { compactionPrune: CompactionPruneService }
}

/**
 * 第一层零成本压缩：只替换成功工具的超长纯文本结果，原 tool/result 事实不会删除。
 * `read` 必须跳过，避免 read -> prune/spill -> read 的循环。
 */
export function registerCompactionPrune(input: { readonly ctx: Context; readonly thresholdChars?: number | undefined }): Disposer {
  const service = createCompactionPrune(input.thresholdChars)
  const unregisterService = input.ctx.set('compactionPrune', service)
  const unregisterEvent = input.ctx.on('agent/tool-result-appended', ({ session, sourceEventSeq, tool }) => {
    service.prune({ session, sourceEventSeq, toolName: tool.name })
  })
  return () => {
    unregisterEvent()
    unregisterService()
  }
}

export function createCompactionPrune(thresholdChars = 12_000): CompactionPruneService {
  return {
    prune({ session, sourceEventSeq, toolName }) {
      const source = session.events().find((event) => event.seq === sourceEventSeq)
      if (source?.type !== 'tool/result') return { status: 'not-applicable', originalChars: 0, previewChars: 0 }
      const text = source.data.message.content
      if (toolName === 'read' || source.data.message.isError || typeof text !== 'string' || text.length <= thresholdChars) {
        return { status: 'not-applicable', originalChars: typeof text === 'string' ? text.length : 0, previewChars: 0 }
      }
      const visible = deriveVisibleSurfaceItems(session.events())
      const index = visible.findIndex((item) => item.sourceSeq === sourceEventSeq)
      if (index < 0) return { status: 'not-visible', originalChars: text.length, previewChars: 0 }
      const preview = pruneText(text, thresholdChars)
      session.append({
        type: 'tool/result',
        data: { ...source.data, message: { ...source.data.message, content: preview } },
        surfaceOp: { op: 'replace', start: index, end: index + 1 },
        sourceEventSeqs: [sourceEventSeq],
      })
      return { status: 'pruned', originalChars: text.length, previewChars: preview.length }
    },
  }
}

function pruneText(text: string, threshold: number): string {
  const head = Math.max(1, Math.floor((threshold - 160) / 2))
  const tail = head
  const omitted = Math.max(0, text.length - head - tail)
  return `${text.slice(0, head)}\n\n... [${omitted} characters omitted; original remains in the session log] ...\n\n${text.slice(-tail)}`
}
