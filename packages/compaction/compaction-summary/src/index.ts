import { randomUUID } from 'node:crypto'
import { deriveTurnMarkers, deriveVisibleSurfaceItems } from '@lcode/session'
import type { ContentBlock, ModelMessage, SessionService } from '@lcode/session'
import type { CompactionResult, CompactionService, CompactionUndoResult } from '@lcode/compaction'

/** P7-02 本地摘要 provider：只提交事务，不决定阈值也不自行调用模型。 */
export function createLocalCompactionSummary(): CompactionService {
  return { compact, undo }
}

function compact(input: {
  readonly session: SessionService
  readonly summary: string
  readonly start?: number | undefined
  readonly end?: number | undefined
  readonly trigger?: 'manual' | 'threshold' | undefined
}): CompactionResult {
  const log = input.session.events()
  if (hasActiveTransaction(log)) return rejected('active-transaction')
  const surface = deriveVisibleSurfaceItems(log)
  const start = input.start ?? 0
  const end = input.end ?? Math.max(0, surface.length - 1)
  if (start < 0 || end > surface.length || start >= end) return rejected('invalid-range')
  const selected = surface.slice(start, end)
  const markers = deriveTurnMarkers(log)
  if (selected.some((item) => markers.get(item.sourceSeq)?.pinned === true)) return rejected('pinned-turn')
  /*
   * 只有"拆散工具配对"才拒绝。旧实现见到任何 tool result 就整笔拒绝——真实编码会话里
   * 几乎每一段历史都含工具结果，那等于让自动压缩永远没有合法范围。配对完整性由
   * `splitsToolTransaction` 保证：调用与结果必须同时在区间内或同时在区间外。
   */
  if (splitsToolTransaction(log, selected.map((item) => item.sourceSeq))) return rejected('tool-boundary')
  // 图片按占位符计，不能把 base64 当文本长度；否则一次截图会让“压缩收益”虚高
  const original = selected.map((item) => messageSizeText(item.message)).join('\n')
  const summary = input.summary.trim()
  if (summary === '' || summary.length >= original.length) {
    return { status: 'not-beneficial', originalChars: original.length, summaryChars: summary.length, shadowedSeqs: selected.map((item) => item.sourceSeq) }
  }
  const compactionId = randomUUID()
  const shadowedSeqs = selected.map((item) => item.sourceSeq)
  input.session.append({ type: 'compaction/start', data: { compactionId, trigger: input.trigger ?? 'manual' } })
  input.session.append({ type: 'compaction/summary', data: { compactionId, summary, sourceEventSeqs: shadowedSeqs, originalChars: original.length, summaryChars: summary.length }, sourceEventSeqs: shadowedSeqs, compactionId })
  input.session.append({
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: `[Conversation summary]\n${summary}` }] },
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: shadowedSeqs,
    compactionId,
    shadowedSeqs,
  })
  input.session.append({ type: 'compaction/end', data: { compactionId, outcome: 'completed' }, compactionId })
  return { status: 'compacted', compactionId, originalChars: original.length, summaryChars: summary.length, shadowedSeqs }
}

/**
 * 撤销仍在当前表面上的压缩。
 *
 * 只接受摘要仍可见的那一次：如果后续压缩已经把摘要压进新摘要，恢复原文会让
 * 表面与后来那次压缩的范围语义冲突，因此明确拒绝（用户可以从更靠前的位置重新压）。
 */
function undo(input: { readonly session: SessionService; readonly compactionId: string }): CompactionUndoResult {
  const log = input.session.events()
  const summary = log.find(
    (event) =>
      event.type === 'compaction/summary' &&
      event.data.compactionId === input.compactionId,
  )
  if (summary === undefined || summary.type !== 'compaction/summary') {
    return { status: 'not-found', restoredSeqs: [] }
  }
  const ended = log.find(
    (event) => event.type === 'compaction/end' && event.data.compactionId === input.compactionId,
  )
  if (ended === undefined || ended.type !== 'compaction/end' || ended.data.outcome !== 'completed') {
    return { status: 'not-completed', restoredSeqs: [] }
  }
  const replacement = log.find(
    (event) => event.type === 'user/message' && event.compactionId === input.compactionId,
  )
  if (replacement === undefined) return { status: 'not-found', restoredSeqs: [] }
  const visible = deriveVisibleSurfaceItems(log)
  const index = visible.findIndex((item) => item.sourceSeq === replacement.seq)
  if (index < 0) return { status: 'not-visible', restoredSeqs: [] }
  const restoredSeqs = [...summary.data.sourceEventSeqs]
  if (restoredSeqs.length === 0) return { status: 'not-found', restoredSeqs: [] }
  input.session.append({
    type: 'compaction/undo',
    data: {
      compactionId: input.compactionId,
      summarySeq: replacement.seq,
      restoredSeqs,
    },
    surfaceOp: { op: 'restore', start: index, eventSeqs: restoredSeqs },
    compactionId: input.compactionId,
  })
  return { status: 'undone', restoredSeqs }
}

function messageSizeText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map(blockSizeText).join('\n')
}

function blockSizeText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'image' || block.type === 'image-ref') return '[image]'
  if (block.type === 'file-ref') return `[attachment: ${block.path}]\n${block.content}`
  if (block.type === 'skill') return `[skill: ${block.name}]\n${block.instructions}`
  if (block.type === 'tool_use') return `[tool call ${block.name}] ${safeJson(block.input)}`
  if (typeof block.content === 'string') return `[tool result] ${block.content}`
  return `[tool result] ${block.content.map(blockSizeText).join('\n')}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function hasActiveTransaction(log: readonly { readonly type: string; readonly data: unknown }[]): boolean {
  const active = new Set<string>()
  for (const event of log) {
    if (!isCompactionEvent(event)) continue
    if (event.type === 'compaction/start') active.add(event.data.compactionId)
    if (event.type === 'compaction/end') active.delete(event.data.compactionId)
  }
  return active.size > 0
}

function isCompactionEvent(event: { readonly type: string; readonly data: unknown }): event is { readonly type: 'compaction/start' | 'compaction/end'; readonly data: { readonly compactionId: string } } {
  return (event.type === 'compaction/start' || event.type === 'compaction/end') && typeof event.data === 'object' && event.data !== null && typeof (event.data as { compactionId?: unknown }).compactionId === 'string'
}

/**
 * 工具事务 =「带 tool_use 的 assistant 消息 + tool/call + tool/result」。
 *
 * 可见表面只含消息，不含 `tool/call` 事件，所以不能拿 call 的 seq 去比；要用
 * tool_use 的 callId 找到承载它的 assistant 消息，再和结果比"是否同为选中"。
 * 只有两边不一致才算拆散——两边都在区间内是合法的完整事务，可以压。
 */
function splitsToolTransaction(log: readonly { readonly type: string; readonly data: unknown; readonly seq: number }[], selectedSeqs: readonly number[]): boolean {
  const selected = new Set(selectedSeqs)
  const assistantByCall = new Map<string, number>()
  for (const event of log) {
    if (event.type !== 'assistant/message' || typeof event.data !== 'object' || event.data === null) continue
    const content = (event.data as { readonly message?: { readonly content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const value = block as { readonly type?: unknown; readonly id?: unknown }
      if (value.type === 'tool_use' && typeof value.id === 'string') assistantByCall.set(value.id, event.seq)
    }
  }
  for (const event of log) {
    if (event.type !== 'tool/result' || typeof event.data !== 'object' || event.data === null) continue
    const callId = (event.data as { readonly message?: { readonly toolCallId?: unknown } }).message?.toolCallId
    if (typeof callId !== 'string') continue
    const assistantSeq = assistantByCall.get(callId)
    // 没有可判定的配对（导入的历史/外部写入）时不做猜测
    if (assistantSeq === undefined) continue
    if (selected.has(assistantSeq) !== selected.has(event.seq)) return true
  }
  return false
}

function rejected(status: Exclude<CompactionResult['status'], 'compacted' | 'not-beneficial'>): CompactionResult {
  return { status, originalChars: 0, summaryChars: 0, shadowedSeqs: [] }
}
