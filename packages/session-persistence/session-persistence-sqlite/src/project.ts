import { createHash } from 'node:crypto'
import type { ModelMessage } from '@lcode/session'
import { deriveEventMessage } from '@lcode/session'
import type { EventFrame, FileHeaderFrame, LogRecordSpan } from '@lcode/session-persistence-jsonl'
import { frameToEvent, scanSpans } from '@lcode/session-persistence-jsonl'
import type BetterSqlite3 from 'better-sqlite3'
import { sessionLogRelPath, workspaceBucket } from '@lcode/util'
import { segmentForFts } from './fts.ts'

/**
 * 投影：JSONL 事实 → SQLite 索引行（文档 22 §3.2–§3.8；实施计划 T3.2–T3.4）。
 *
 * **本文件是纯函数，不碰磁盘、不碰连接**，于是「实时写入」与「index rebuild」走的是
 * 同一段逻辑——docs/24 §5 T3.6 的出口判据（删库重建后逐行一致）因此是**构造性保证**，
 * 而不是"两边各写一遍然后祈祷它们一致"。
 *
 * 三条纪律：
 * - `assistant/chunk` **不进** `events` 表（22 §3.4）：chunk 只在 `session_log_index` 里按批出现，
 *   否则索引体积会反超日志。
 * - `tool_calls` **不存原始参数**（22 §3.6）：只有 `args_digest`（哈希 + 安全白名单字段）。
 * - `file_changes.source` 恒为 `presentation-meta`（22 §3.7）：变更集合是**派生**，不许扫盘。
 */

// ─────────────── 行类型（列名与 22 §3 一致，便于直接绑参） ───────────────

export type SessionStatus = 'idle' | 'busy' | 'waiting-approval' | 'error'
export type ToolCallStatus = 'pending' | 'running' | 'done' | 'failed' | 'denied' | 'cancelled'

export interface SessionRow {
  readonly session_id: string
  readonly workspace: string | null
  readonly workspace_key: string
  readonly title: string
  readonly created_at: number
  readonly updated_at: number
  readonly last_seq: number
  readonly preset: string | null
  readonly model_provider: string | null
  readonly model_name: string | null
  readonly status: SessionStatus
  readonly parent_session: string | null
  readonly seed_length: number
  readonly log_path: string
  readonly log_codec: 'none' | 'zstd'
  readonly log_bytes: number
  readonly log_revision: string | null
  readonly key_id: string | null
  readonly indexed_at: number | null
}

export interface LogIndexRow {
  readonly session_id: string
  readonly seq: number
  readonly seq_last: number
  readonly kind: string
  readonly type: string
  readonly byte_offset: number
  readonly byte_length: number
  readonly created_at: number
}

export interface TurnRow {
  readonly session_id: string
  readonly turn: number
  readonly start_seq: number
  readonly end_seq: number | null
  readonly reason: string | null
  readonly started_at: number
  readonly ended_at: number | null
  readonly steps: number
  readonly tool_calls: number
}

export interface StepRow {
  readonly session_id: string
  readonly turn: number
  readonly step: number
  readonly start_seq: number
  readonly end_seq: number | null
  readonly started_at: number
  readonly ended_at: number | null
  readonly model_provider: string | null
  readonly model_name: string | null
  readonly input_tokens: number | null
  readonly output_tokens: number | null
}

export interface EventRow {
  readonly session_id: string
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly turn: number | null
  readonly step: number | null
  readonly call_id: string | null
  readonly surface_op: 'append' | 'replace' | null
  readonly repl_start: number | null
  readonly repl_end: number | null
  readonly ignorable: number
  readonly data_bytes: number | null
}

export interface MessageRow {
  readonly session_id: string
  readonly surface_index: number
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool'
  readonly block_kind: string
  /** 原样可见文本（UI 读它，**不被分词污染**） */
  readonly summary: string
  readonly text_bytes: number
  /** 分词形态（只进 FTS，见 ddl.ts 文件头「第 15 项」） */
  readonly fts_text: string
  readonly replaced_by_seq: number | null
  readonly is_active: number
  readonly created_at: number
}

export interface ToolCallRow {
  readonly session_id: string
  readonly call_id: string
  readonly seq: number
  readonly result_seq: number | null
  readonly turn: number
  readonly step: number
  readonly name: string
  readonly args_digest: string
  readonly args_bytes: number
  readonly status: ToolCallStatus
  readonly started_at: number | null
  readonly ended_at: number | null
  readonly duration_ms: number | null
  readonly error_code: string | null
  readonly result_bytes: number | null
}

export interface FileChangeRow {
  readonly session_id: string
  readonly turn: number
  readonly path: string
  readonly change_kind: 'add' | 'modify' | 'delete' | 'rename'
  readonly additions: number
  readonly deletions: number
  readonly tool_call_id: string
  readonly source: 'presentation-meta'
  readonly seq: number
  readonly created_at: number
}

export interface CheckpointRow {
  readonly session_id: string
  readonly seq: number
  readonly kind: 'turn-end' | 'step-end' | 'session-end-seed' | 'manual'
  readonly safe_fork: number
  readonly label: string | null
  readonly created_at: number
}

export interface ProjectedSession {
  readonly session: SessionRow
  readonly logIndex: readonly LogIndexRow[]
  readonly turns: readonly TurnRow[]
  readonly steps: readonly StepRow[]
  readonly events: readonly EventRow[]
  readonly messages: readonly MessageRow[]
  readonly toolCalls: readonly ToolCallRow[]
  readonly fileChanges: readonly FileChangeRow[]
  readonly checkpoints: readonly CheckpointRow[]
}

export interface ProjectionInput {
  readonly sessionId: string
  readonly header: FileHeaderFrame
  readonly events: readonly EventFrame[]
  readonly spans: readonly LogRecordSpan[]
  readonly revision: string
  readonly bytes: number
  readonly indexedAt: number
  readonly title?: string | undefined
}

// ─────────────── 小工具 ───────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
  } catch {
    return 0
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * 参数脱敏摘要（22 §3.6）。
 *
 * **刻意不包含** `content` / `command` / `token` / `body` / `data` 这类可能含敏感内容的键——
 * 索引层是可丢的派生层，没有理由再存一份敏感数据。白名单只放"定位用"的字段。
 */
const SAFE_ARG_KEYS = [
  'path',
  'file',
  'filePath',
  'file_path',
  'glob',
  'pattern',
  'query',
  'url',
  'name',
  'tool',
  'kind',
  'line',
  'start',
  'limit',
  'root',
  'cwd',
  'mode',
] as const

export function digestArgs(rawArguments: string): string {
  const hash = createHash('sha256').update(rawArguments, 'utf8').digest('hex').slice(0, 16)
  const parts: string[] = []
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    const record = asRecord(parsed)
    for (const key of SAFE_ARG_KEYS) {
      const value = record[key]
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${key}=${truncate(String(value), 32)}`)
      }
    }
  } catch {
    // 参数不是合法 JSON（或不是对象）：只留哈希，这是"不猜"的正确行为
  }
  return parts.length === 0 ? `sha256:${hash}` : `sha256:${hash} ${parts.join(' ')}`
}

/** 可见文本（`messages_projection.summary` 的来源，06 §4.1） */
export function extractVisibleText(message: ModelMessage): string {
  const content: unknown = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as readonly Record<string, unknown>[]) {
    const kind = block['type']
    if (kind === 'text') {
      const text = str(block['text'])
      if (text !== null) parts.push(text)
    } else if (kind === 'tool_result') {
      const inner: unknown = block['content']
      if (typeof inner === 'string') parts.push(inner)
      else if (Array.isArray(inner)) {
        for (const sub of inner as readonly Record<string, unknown>[]) {
          const text = str(sub['text'])
          if (text !== null && sub['type'] === 'text') parts.push(text)
        }
      }
    }
  }
  return parts.join('\n')
}

function hasToolUse(message: ModelMessage): boolean {
  const content: unknown = message.content
  if (!Array.isArray(content)) return false
  return (content as readonly Record<string, unknown>[]).some((b) => b['type'] === 'tool_use')
}

// ─────────────── 表面投影（T3.3） ───────────────

interface SurfaceNode {
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool'
  readonly blockKind: string
  readonly summary: string
  readonly createdAt: number
  active: boolean
  replacedBy: number | null
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

function replaceRange(event: EventFrame): { start: number; end: number } | null {
  const op = event.surfaceOp
  if (op === undefined || op === 'append' || op.op !== 'replace') return null
  return { start: op.start, end: op.end }
}

function restoreSeqs(event: EventFrame): { start: number; eventSeqs: readonly number[] } | null {
  const op = event.surfaceOp
  if (op === undefined || op === 'append' || op.op !== 'restore') return null
  return { start: op.start, eventSeqs: op.eventSeqs }
}

/**
 * 表面投影：把表面事件投影成"模型看到的消息列表"，并记录被 `replace` 遮蔽者。
 *
 * 与 `deriveSurfaceItems` 的关键差别：这里**额外记下 `replaced_by_seq` 与 `surface_index`**
 * （22 §3.5 的列），并显式处理「replace 落在表面事件自身上」的形态（压缩摘要，06 §3.3）。
 * 消息本体仍走 `deriveEventMessage` 纯函数（T3.3 的既定要求）。
 */
function projectSurface(events: readonly EventFrame[]): SurfaceNode[] {
  const nodes: SurfaceNode[] = []
  for (const event of events) {
    if (SURFACE_TYPES.has(event.type)) {
      const message = deriveEventMessage(frameToEvent(event))
      if (message !== null) {
        const range = replaceRange(event)
        nodes.push({
          seq: event.seq,
          role: message.role === 'assistant' ? 'assistant' : event.type === 'tool/result' ? 'tool' : 'user',
          // 压缩摘要的形态就是「user/message + replace」（06 §3.3），据此标 block_kind
          blockKind:
            range !== null && event.type === 'user/message'
              ? 'summary'
              : event.type === 'tool/result'
                ? 'tool-result'
                : hasToolUse(message)
                  ? 'tool-call'
                  : 'text',
          summary: extractVisibleText(message),
          createdAt: event.time,
          active: true,
          replacedBy: null,
        })
      }
    }
    const range = replaceRange(event)
    if (range !== null) {
      const { start, end } = range
      if (start < 0 || end > nodes.length || start >= end) {
        // I4：区间必须落在当前表面范围内（与 deriveSurfaceItems 同判据）
        throw new RangeError(
          `surface replace 区间越界：start=${start} end=${end} surface 长度=${nodes.length}（不变量 I4 违规）`,
        )
      }
      for (let i = start; i < end; i++) {
        const node = nodes[i]!
        node.active = false
        node.replacedBy = event.seq
      }
    }
    const restore = restoreSeqs(event)
    if (restore !== null) {
      const { start, eventSeqs } = restore
      if (start < 0 || start >= nodes.length || eventSeqs.length === 0) {
        throw new RangeError(
          `surface restore 区间越界：start=${start} surface 长度=${nodes.length}（不变量 I4 违规）`,
        )
      }
      const summary = nodes[start]!
      summary.active = false
      summary.replacedBy = event.seq
      const wanted = new Set(eventSeqs)
      for (const node of nodes) {
        if (!wanted.has(node.seq)) continue
        node.active = true
        node.replacedBy = null
      }
    }
  }
  return nodes
}

// ─────────────── 主投影 ───────────────

export function projectSession(input: ProjectionInput): ProjectedSession {
  const { sessionId, header, events } = input

  const logIndex: LogIndexRow[] = input.spans.map((span) => ({
    session_id: sessionId,
    seq: span.seq,
    seq_last: span.seqLast,
    kind: span.kind,
    type: span.type,
    byte_offset: span.byteOffset,
    byte_length: span.byteLength,
    created_at: input.indexedAt,
  }))

  interface TurnAcc {
    row: TurnRow | null
    start: { turn: number; startSeq: number; startedAt: number } | null
    end: { seq: number; time: number; reason: string | null } | null
    steps: number
    toolCalls: number
  }
  interface StepAcc {
    start: { turn: number; step: number; startSeq: number; startedAt: number }
    end: { seq: number; time: number } | null
    provider: string | null
    model: string | null
    inputTokens: number | null
    outputTokens: number | null
  }

  const turns = new Map<number, TurnAcc>()
  const steps = new Map<string, StepAcc>()
  const eventRows: EventRow[] = []
  const toolCalls = new Map<string, ToolCallRow>()
  const toolCallOrder: string[] = []
  const fileChanges: FileChangeRow[] = []
  const checkpoints: CheckpointRow[] = []
  const approvalDecisions = new Map<string, string>()
  const askedApprovals = new Set<string>()

  let lastTime = header.createdAt
  let lastProvider: string | null = null
  let lastModel: string | null = null
  let lastRequestHeader: { provider: string | null; model: string | null } = { provider: null, model: null }
  /**
   * 尚未结束的步。**步的模型归属必须这样取**：真实的日志顺序永远是
   * `step/start → request/header → …`，即 `request/header` 出现在 `step/start` **之后**，
   * 所以"在 step/start 那一刻取当前 request/header"会**永远取到 null**。
   * 正确语义是"本步**期间**实际使用的 provider"（22 §3.3），因此要在步打开期间持续更新。
   */
  const openStepKeys: string[] = []

  const stepKey = (turn: number, step: number): string => `${turn}:${step}`

  const assignModelToOpenSteps = (provider: string | null, model: string | null): void => {
    if (provider === null && model === null) return
    for (const key of openStepKeys) {
      const acc = steps.get(key)
      if (acc === undefined) continue
      if (provider !== null) acc.provider = provider
      if (model !== null) acc.model = model
    }
  }

  for (const event of events) {
    if (event.time > lastTime) lastTime = event.time
    const data = asRecord(event.data)
    const turn = num(data['turn'])
    const step = num(data['step'])
    const range = replaceRange(event)

    if (event.type === 'request/header') {
      const h = asRecord(data['header'])
      lastRequestHeader = { provider: str(h['provider']), model: str(h['model']) }
      if (lastRequestHeader.provider !== null) lastProvider = lastRequestHeader.provider
      if (lastRequestHeader.model !== null) lastModel = lastRequestHeader.model
      assignModelToOpenSteps(lastRequestHeader.provider, lastRequestHeader.model)
    } else if (event.type === 'assistant/message') {
      const message = asRecord(data['message'])
      const provider = str(message['provider'])
      const model = str(message['model'])
      if (provider !== null) lastProvider = provider
      if (model !== null) lastModel = model
      assignModelToOpenSteps(provider, model)
      if (turn !== null && step !== null) {
        const acc = steps.get(stepKey(turn, step))
        const usage = asRecord(data['usage'])
        if (acc !== undefined) {
          const input = num(usage['input'])
          const output = num(usage['output'])
          if (input !== null) acc.inputTokens = input
          if (output !== null) acc.outputTokens = output
        }
      }
    } else if (event.type === 'turn/start' && turn !== null) {
      turns.set(turn, {
        row: null,
        start: { turn, startSeq: event.seq, startedAt: event.time },
        end: null,
        steps: 0,
        toolCalls: 0,
      })
    } else if (event.type === 'turn/end' && turn !== null) {
      const acc = turns.get(turn)
      if (acc !== undefined) acc.end = { seq: event.seq, time: event.time, reason: str(data['reason']) }
      checkpoints.push({
        session_id: sessionId,
        seq: event.seq,
        kind: 'turn-end',
        safe_fork: 1, // 轮边界处日志没有未闭合轮，可安全分叉（22 §3.8）
        label: null,
        created_at: event.time,
      })
    } else if (event.type === 'step/start' && turn !== null && step !== null) {
      steps.set(stepKey(turn, step), {
        start: { turn, step, startSeq: event.seq, startedAt: event.time },
        end: null,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
      })
      openStepKeys.push(stepKey(turn, step))
      const acc = turns.get(turn)
      if (acc !== undefined) acc.steps += 1
    } else if (event.type === 'step/end' && turn !== null && step !== null) {
      const acc = steps.get(stepKey(turn, step))
      if (acc !== undefined) acc.end = { seq: event.seq, time: event.time }
      const index = openStepKeys.indexOf(stepKey(turn, step))
      if (index >= 0) openStepKeys.splice(index, 1)
      checkpoints.push({
        session_id: sessionId,
        seq: event.seq,
        kind: 'step-end',
        safe_fork: 0, // 步边界可能落在未闭合轮内，不能当分叉点
        label: null,
        created_at: event.time,
      })
    } else if (event.type === 'tool/call') {
      const callId = str(data['callId'])
      if (callId !== null && turn !== null && step !== null) {
        const rawArgs = str(data['arguments']) ?? ''
        toolCalls.set(callId, {
          session_id: sessionId,
          call_id: callId,
          seq: event.seq,
          result_seq: null,
          turn,
          step,
          name: str(data['name']) ?? '',
          args_digest: digestArgs(rawArgs),
          args_bytes: Buffer.byteLength(rawArgs, 'utf8'),
          status: 'pending',
          started_at: event.time,
          ended_at: null,
          duration_ms: null,
          error_code: null,
          result_bytes: null,
        })
        toolCallOrder.push(callId)
        const acc = turns.get(turn)
        if (acc !== undefined) acc.toolCalls += 1
      }
    } else if (event.type === 'tool/result') {
      const message = asRecord(data['message'])
      const callId = str(message['toolCallId'])
      if (callId !== null) {
        const existing = toolCalls.get(callId)
        const error = asRecord(data['error'])
        const errorCode = str(error['code'])
        const resultBytes = byteLength(message['content'])
        if (existing !== undefined) {
          const startedAt = existing.started_at
          toolCalls.set(callId, {
            ...existing,
            result_seq: event.seq,
            status: errorCode !== null ? 'failed' : 'done',
            ended_at: event.time,
            duration_ms: startedAt === null ? null : event.time - startedAt,
            error_code: errorCode,
            result_bytes: resultBytes,
          })
        }
        // file_changes 从 presentationMeta 派生（22 §3.7 / 08 §8.4），**不是**扫盘
        const meta = asRecord(data['meta'])
        const changes: unknown = meta['changes']
        if (meta['card'] === 'diff' && Array.isArray(changes) && turn !== null) {
          for (const raw of changes as readonly unknown[]) {
            const change = asRecord(raw)
            const path = str(change['path'])
            const kind = str(change['kind'])
            if (path === null || kind === null) continue
            if (kind !== 'add' && kind !== 'modify' && kind !== 'delete' && kind !== 'rename') continue
            fileChanges.push({
              session_id: sessionId,
              turn,
              path,
              change_kind: kind,
              additions: num(change['additions']) ?? 0,
              deletions: num(change['deletions']) ?? 0,
              tool_call_id: callId,
              source: 'presentation-meta',
              seq: event.seq,
              created_at: event.time,
            })
          }
        }
      }
    } else if (event.type === 'approval/asked') {
      const callId = str(data['callId'])
      if (callId !== null) askedApprovals.add(callId)
    } else if (event.type === 'approval/decided') {
      const callId = str(data['callId'])
      const result = str(data['result'])
      if (callId !== null && result !== null) {
        approvalDecisions.set(callId, result)
        askedApprovals.delete(callId)
      }
    } else if (event.type === 'session/end-seed') {
      checkpoints.push({
        session_id: sessionId,
        seq: event.seq,
        kind: 'session-end-seed',
        safe_fork: 1,
        label: null,
        created_at: event.time,
      })
    }

    // events 表：**不含** assistant/chunk（22 §3.4）
    if (event.type !== 'assistant/chunk') {
      eventRows.push({
        session_id: sessionId,
        seq: event.seq,
        type: event.type,
        time: event.time,
        turn,
        step,
        call_id:
          str(data['callId']) ??
          str(asRecord(data['message'])['toolCallId']) ??
          null,
        surface_op: range !== null ? 'replace' : event.surfaceOp === 'append' ? 'append' : null,
        repl_start: range === null ? null : range.start,
        repl_end: range === null ? null : range.end,
        ignorable: event.ignorable === true ? 1 : 0,
        data_bytes: byteLength(event.data),
      })
    }
  }

  // 被拒绝 / 取消的调用：有结果的不覆盖（结果才是事实），无结果的按审批结论定状态
  for (const callId of toolCallOrder) {
    const row = toolCalls.get(callId)!
    if (row.result_seq !== null) continue
    const decision = approvalDecisions.get(callId)
    if (decision === undefined) continue
    const status: ToolCallStatus = decision === 'allowed-once' ? 'pending' : decision === 'cancelled' ? 'cancelled' : 'denied'
    toolCalls.set(callId, { ...row, status })
  }

  const turnRows: TurnRow[] = []
  let hasOpenTurn = false
  let lastEndedReason: string | null = null
  for (const [turnNumber, acc] of [...turns.entries()].sort((a, b) => a[0] - b[0])) {
    const start = acc.start
    if (start === null) continue
    if (acc.end === null) hasOpenTurn = true
    else lastEndedReason = acc.end.reason
    turnRows.push({
      session_id: sessionId,
      turn: turnNumber,
      start_seq: start.startSeq,
      end_seq: acc.end === null ? null : acc.end.seq,
      reason: acc.end === null ? null : acc.end.reason,
      started_at: start.startedAt,
      ended_at: acc.end === null ? null : acc.end.time,
      steps: acc.steps,
      tool_calls: acc.toolCalls,
    })
  }

  const stepRows: StepRow[] = [...steps.values()]
    .sort((a, b) => (a.start.turn - b.start.turn) || (a.start.step - b.start.step))
    .map((acc) => ({
      session_id: sessionId,
      turn: acc.start.turn,
      step: acc.start.step,
      start_seq: acc.start.startSeq,
      end_seq: acc.end === null ? null : acc.end.seq,
      started_at: acc.start.startedAt,
      ended_at: acc.end === null ? null : acc.end.time,
      model_provider: acc.provider,
      model_name: acc.model,
      input_tokens: acc.inputTokens,
      output_tokens: acc.outputTokens,
    }))

  const nodes = projectSurface(events)
  const messageRows: MessageRow[] = nodes.map((node, index) => ({
    session_id: sessionId,
    surface_index: index,
    seq: node.seq,
    role: node.role,
    block_kind: node.blockKind,
    summary: node.summary,
    text_bytes: Buffer.byteLength(node.summary, 'utf8'),
    fts_text: segmentForFts(node.summary),
    replaced_by_seq: node.replacedBy,
    is_active: node.active ? 1 : 0,
    created_at: node.createdAt,
  }))

  const hasDanglingApproval = askedApprovals.size > 0
  const status: SessionStatus = hasOpenTurn
    ? hasDanglingApproval
      ? 'waiting-approval'
      : 'busy'
    : lastEndedReason === 'error'
      ? 'error'
      : 'idle'

  const session: SessionRow = {
    session_id: sessionId,
    workspace: header.cwd,
    workspace_key: workspaceBucket(header.cwd),
    // `title` 是**用户元数据**（22 §3.1），JSONL 里没有它的位置（§4.1 的头部帧不含 title）。
    // 因此这里**不传就沿用索引里已有的值**（UPSERT 时 excluded.title 会是空串，
    // 见 SQL 侧对空串的处理）——避免重投影把用户设置过的标题清掉。
    title: input.title ?? '',
    created_at: header.createdAt,
    updated_at: lastTime,
    last_seq: events.length - 1, // 零事件为 -1（22 §3.1）
    preset: null,
    model_provider: lastProvider,
    model_name: lastModel,
    status,
    parent_session: header.parentSession,
    seed_length: header.seedLength,
    log_path: sessionLogRelPath(header.cwd, sessionId),
    log_codec: header.codec,
    log_bytes: input.bytes,
    log_revision: input.revision,
    key_id: header.keyId,
    indexed_at: input.indexedAt,
  }

  return {
    session,
    logIndex,
    turns: turnRows,
    steps: stepRows,
    events: eventRows,
    messages: messageRows,
    toolCalls: toolCallOrder.map((id) => toolCalls.get(id)!),
    fileChanges,
    checkpoints,
  }
}

// ─────────────── 落库 ───────────────

const SESSIONS_UPSERT = `
INSERT INTO sessions (
  session_id, workspace, workspace_key, title, created_at, updated_at, last_seq,
  preset, model_provider, model_name, status, parent_session, seed_length,
  log_path, log_codec, log_bytes, log_revision, key_id, indexed_at
) VALUES (
  @session_id, @workspace, @workspace_key, @title, @created_at, @updated_at, @last_seq,
  @preset, @model_provider, @model_name, @status, @parent_session, @seed_length,
  @log_path, @log_codec, @log_bytes, @log_revision, @key_id, @indexed_at
)
ON CONFLICT(session_id) DO UPDATE SET
  workspace = excluded.workspace,
  workspace_key = excluded.workspace_key,
  -- title 是用户元数据、不在 JSONL 里，所以"投影没带 title"（空串）时保留已有值，
  -- 否则每一次重投影都会把用户命名过的会话打回未命名（index rebuild 后尤其明显）。
  title = CASE WHEN excluded.title = '' THEN sessions.title ELSE excluded.title END,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  last_seq = excluded.last_seq,
  preset = excluded.preset,
  model_provider = excluded.model_provider,
  model_name = excluded.model_name,
  status = excluded.status,
  parent_session = excluded.parent_session,
  seed_length = excluded.seed_length,
  log_path = excluded.log_path,
  log_codec = excluded.log_codec,
  log_bytes = excluded.log_bytes,
  log_revision = excluded.log_revision,
  key_id = excluded.key_id,
  indexed_at = excluded.indexed_at
`

/** 子表删除顺序：先删被引用者，避免外键报错（steps 引 turns） */
const CHILD_TABLES = [
  'file_changes',
  'tool_calls',
  'checkpoints',
  'messages_projection',
  'events',
  'steps',
  'turns',
  'session_log_index',
] as const

/**
 * 把投影结果落库。**整会话重算 + 全量替换**（单事务），因此结果与 `projectSession` 一一对应。
 *
 * 注意 `deleted_at` / `archived_at` **不在 UPSERT 的更新列里**——它们是用户状态（软删、归档），
 * 不是从日志派生的事实；重算索引不该把它们抹掉（22 §9.5）。
 */
export function applyProjection(db: BetterSqlite3.Database, projected: ProjectedSession): void {
  const sessionId = projected.session.session_id
  const run = db.transaction((): void => {
    db.prepare(SESSIONS_UPSERT).run(projected.session as unknown as Record<string, unknown>)
    for (const table of CHILD_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
    }

    const insertLogIndex = db.prepare(
      `INSERT INTO session_log_index (session_id, seq, seq_last, kind, type, byte_offset, byte_length, created_at)
       VALUES (@session_id, @seq, @seq_last, @kind, @type, @byte_offset, @byte_length, @created_at)`,
    )
    for (const row of projected.logIndex) insertLogIndex.run(row as unknown as Record<string, unknown>)

    const insertTurn = db.prepare(
      `INSERT INTO turns (session_id, turn, start_seq, end_seq, reason, started_at, ended_at, steps, tool_calls)
       VALUES (@session_id, @turn, @start_seq, @end_seq, @reason, @started_at, @ended_at, @steps, @tool_calls)`,
    )
    for (const row of projected.turns) insertTurn.run(row as unknown as Record<string, unknown>)

    const insertStep = db.prepare(
      `INSERT INTO steps (session_id, turn, step, start_seq, end_seq, started_at, ended_at,
                          model_provider, model_name, input_tokens, output_tokens)
       VALUES (@session_id, @turn, @step, @start_seq, @end_seq, @started_at, @ended_at,
               @model_provider, @model_name, @input_tokens, @output_tokens)`,
    )
    for (const row of projected.steps) insertStep.run(row as unknown as Record<string, unknown>)

    const insertEvent = db.prepare(
      `INSERT INTO events (session_id, seq, type, time, turn, step, call_id, surface_op,
                           repl_start, repl_end, ignorable, data_bytes)
       VALUES (@session_id, @seq, @type, @time, @turn, @step, @call_id, @surface_op,
               @repl_start, @repl_end, @ignorable, @data_bytes)`,
    )
    for (const row of projected.events) insertEvent.run(row as unknown as Record<string, unknown>)

    const insertMessage = db.prepare(
      `INSERT INTO messages_projection (session_id, surface_index, seq, role, block_kind, summary,
                                        text_bytes, fts_text, replaced_by_seq, is_active, created_at)
       VALUES (@session_id, @surface_index, @seq, @role, @block_kind, @summary,
               @text_bytes, @fts_text, @replaced_by_seq, @is_active, @created_at)`,
    )
    for (const row of projected.messages) insertMessage.run(row as unknown as Record<string, unknown>)

    const insertToolCall = db.prepare(
      `INSERT INTO tool_calls (session_id, call_id, seq, result_seq, turn, step, name, args_digest,
                               args_bytes, status, started_at, ended_at, duration_ms, error_code, result_bytes)
       VALUES (@session_id, @call_id, @seq, @result_seq, @turn, @step, @name, @args_digest,
               @args_bytes, @status, @started_at, @ended_at, @duration_ms, @error_code, @result_bytes)`,
    )
    for (const row of projected.toolCalls) insertToolCall.run(row as unknown as Record<string, unknown>)

    const insertFileChange = db.prepare(
      `INSERT INTO file_changes (session_id, turn, path, change_kind, additions, deletions,
                                 tool_call_id, source, seq, created_at)
       VALUES (@session_id, @turn, @path, @change_kind, @additions, @deletions,
               @tool_call_id, @source, @seq, @created_at)`,
    )
    for (const row of projected.fileChanges) insertFileChange.run(row as unknown as Record<string, unknown>)

    const insertCheckpoint = db.prepare(
      `INSERT INTO checkpoints (session_id, seq, kind, safe_fork, label, created_at)
       VALUES (@session_id, @seq, @kind, @safe_fork, @label, @created_at)`,
    )
    for (const row of projected.checkpoints) insertCheckpoint.run(row as unknown as Record<string, unknown>)
  })
  run()
}

/** 从已读出的日志直接投影（重建路径用，见 `index-rebuild.ts`） */
export function projectFromLog(input: {
  readonly sessionId: string
  readonly header: FileHeaderFrame
  readonly events: readonly EventFrame[]
  readonly frames: readonly import('@lcode/session-persistence-jsonl').LogFrame[]
  readonly lines: readonly string[]
  readonly revision: string
  readonly bytes: number
  readonly indexedAt: number
}): ProjectedSession {
  const spans = scanSpans(input.lines, input.frames, input.indexedAt)
  return projectSession({
    sessionId: input.sessionId,
    header: input.header,
    events: input.events,
    spans,
    revision: input.revision,
    bytes: input.bytes,
    indexedAt: input.indexedAt,
  })
}
