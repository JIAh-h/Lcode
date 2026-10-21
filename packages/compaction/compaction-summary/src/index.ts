import { randomUUID } from 'node:crypto'
import { deriveVisibleSurfaceItems } from '@lcode/session'
import type { SessionService } from '@lcode/session'
import type { CompactionResult, CompactionService } from '@lcode/compaction'

/** P7-02 本地摘要 provider：只提交事务，不决定阈值也不自行调用模型。 */
export function createLocalCompactionSummary(): CompactionService {
  return { compact }
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
  if (selected.some((item) => hasToolResult(item.message)) || splitsToolTransaction(log, selected.map((item) => item.sourceSeq))) return rejected('tool-boundary')
  const original = selected.map((item) => JSON.stringify(item.message)).join('\n')
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

function hasToolResult(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'content' in message && Array.isArray((message as { content: unknown }).content)
    && (message as { content: readonly { type?: unknown }[] }).content.some((block) => block.type === 'tool_result')
}

function splitsToolTransaction(log: readonly { readonly type: string; readonly data: unknown; readonly seq: number }[], selectedSeqs: readonly number[]): boolean {
  const selected = new Set(selectedSeqs)
  const calls = new Map<string, boolean>()
  for (const event of log) {
    if (event.type !== 'tool/call' || typeof event.data !== 'object' || event.data === null) continue
    const callId = (event.data as { readonly callId?: unknown }).callId
    if (typeof callId === 'string') calls.set(callId, selected.has(event.seq))
  }
  for (const event of log) {
    if (event.type !== 'tool/result' || typeof event.data !== 'object' || event.data === null) continue
    const callId = (event.data as { readonly message?: { readonly toolCallId?: unknown } }).message?.toolCallId
    if (typeof callId === 'string' && calls.has(callId) && calls.get(callId) !== selected.has(event.seq)) return true
  }
  return false
}

function rejected(status: Exclude<CompactionResult['status'], 'compacted' | 'not-beneficial'>): CompactionResult {
  return { status, originalChars: 0, summaryChars: 0, shadowedSeqs: [] }
}
