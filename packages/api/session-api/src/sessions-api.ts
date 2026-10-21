import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EpochHeader, ModelMessage, SessionEvent, SessionService, StreamChunk, ToolResultMessage } from '@lcode/session'
import { InMemorySessionStore, deriveMessages } from '@lcode/session'
import type { EventFrame, JsonlSessionPersistence, LoadedLog } from '@lcode/session-persistence-jsonl'
import {
  applyRetention,
  computeRevision,
  createJsonlPersistence,
  encodeJsonl,
  eventFramesOf,
  findSessionFile,
  frameToEvent,
  framesToEvents,
  listSessionFiles,
  loadLog,
  loadLogWithSpans,
  planRecovery,
  writeFileAtomicSync,
} from '@lcode/session-persistence-jsonl'
import {
  SessionIndexWriter,
  applyProjection,
  closeAllIndexDbs,
  describeIndexDb,
  extractVisibleText,
  openIndexDb,
  projectSession,
  rebuildIndex,
  searchMessages,
} from '@lcode/session-persistence-sqlite'
import type { EventInput } from '@lcode/session'
import type { JsonValue } from '@lcode/util'
import { createPersistedSession } from './persisted-session.ts'
import {
  ERROR_CODES,
  LcodeErrorImpl,
  asSessionId,
  newSessionId,
  normalizePath,
  nowEpochMs,
  CACHE_DIR,
  exportsRoot,
  trashRoot,
} from '@lcode/util'
import {
  TRASH_RETENTION_MS,
  dirBytes,
  emptyTrash,
  listTrashEntries,
  moveToTrash,
  pruneCache,
  pruneTrash,
  purgeCache,
  purgeSpillFor,
  storageUsage,
  writeManifest,
} from './storage.ts'
import type {
  AppendEventInput,
  ArchiveInput,
  ArchiveResult,
  CreateSessionInput,
  CreateSessionResult,
  DeleteSessionInput,
  DeleteSessionResult,
  DeriveInput,
  DeriveResult,
  ExportAllEntry,
  ExportAllInput,
  ExportAllResult,
  ExportFormat,
  ExportInput,
  ExportResult,
  ImportSessionInput,
  ImportSessionResult,
  SearchSessionHit,
  SearchSessionsInput,
  SearchSessionsResult,
  FlushInput,
  FlushResult,
  ForkSessionInput,
  ForkSessionResult,
  HistoryApi,
  HistoryBodyInput,
  HistoryBodyResult,
  HistoryCheckpointsInput,
  HistoryReplayInput,
  HistoryWhyInput,
  IndexDoctorReport,
  IndexFinding,
  ListSessionsInput,
  ListSessionsResult,
  ListTrashResult,
  PruneStorageInput,
  PruneStorageResult,
  PurgeSessionInput,
  PurgeSessionResult,
  RestoreSessionInput,
  RestoreSessionResult,
  ResumeSessionInput,
  ResumeSessionResult,
  ReplayDecision,
  ReplaySnapshot,
  ReplayToolCall,
  Checkpoint,
  DecisionTrace,
  SessionHeader,
  SessionMeta,
  SessionMetaInput,
  SessionMetaResult,
  SessionStatus,
  RuntimeSessionsService,
  StorageUsageResult,
  TrashEntry,
} from './types.ts'

/**
 * `sessions.*` 的本地实现（doc 21 §2.1；实施计划 T4.1）。
 *
 * 装配关系：
 * ```
 * LocalSessionsApi
 *   ├── core/session     InMemorySessionStore —— 日志 owner（seq 分配、I4/I5 强校验）
 *   ├── JSONL 持久化      JsonlSessionPersistence —— 权威真相
 *   └── SQLite 索引       SessionIndexWriter -> projectSession/applyProjection —— 派生
 * ```
 *
 * 三条继承自下层的纪律，这里**不重复实现、也不绕过**：
 * - `seq` 只由 store 分配（调用方不得传入）；
 * - I5（无损 JSON）与 I4（surface 区间）在 `store.append()` 内强校验——本层只把
 *   `RangeError` 归一成契约允许的 `EC-INVALID_PARAMS`，不新增错误码；
 * - 索引失败绝不回压会话：`JsonlSessionPersistence` 已经吞掉 sink 异常。
 */

export interface LocalSessionsApiOptions {
  readonly home: string
  /** 注入持久化（测试或其它后端可替换） */
  readonly persistence?: JsonlSessionPersistence | undefined
  /** 注入索引写入器 */
  readonly index?: SessionIndexWriter | undefined
  readonly now?: (() => number) | undefined
}

interface OpenSession {
  readonly store: InMemorySessionStore
  readonly cwd: string | null
}

function notFound(sessionId: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_SESSION_NOT_FOUND,
    message: `会话不存在或日志缺失：${sessionId}`,
    userMessage: '这个对话找不到了。',
    retryable: false,
  })
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_INVALID_PARAMS,
    message,
    userMessage: '这个请求的参数不对。',
    retryable: false,
  })
}

function forkBoundary(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_FORK_BOUNDARY_INVALID,
    message,
    userMessage: '你选的位置落在一个还没结束的回合中间，请换一个位置。',
    retryable: false,
  })
}

function replayTargetNotFound(sessionId: string, seq: number): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_FOUND,
    message: `回放位置没有请求快照：${sessionId}@${seq}`,
    userMessage: '这个位置还没有可回放的请求。',
    retryable: false,
  })
}

function historyEventNotFound(sessionId: string, seq: number): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_FOUND,
    message: `会话事件不存在：${sessionId}@${seq}`,
    userMessage: '这个历史位置已经不存在。',
    retryable: false,
  })
}

function replayFormatUnsupported(sessionId: string, seq: number): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_FORMAT_UNSUPPORTED,
    message: `请求快照缺少 system 或 tools：${sessionId}@${seq}`,
    userMessage: '这个旧会话没有保存完整请求，不能伪造为精确回放。',
    retryable: false,
  })
}

function isRequestHeader(
  event: SessionEvent,
): event is SessionEvent & { readonly type: 'request/header'; readonly data: { readonly header: EpochHeader } } {
  return event.type === 'request/header'
}

function isAssistantChunk(
  event: SessionEvent,
): event is SessionEvent & { readonly type: 'assistant/chunk'; readonly data: { readonly chunk: StreamChunk } } {
  return event.type === 'assistant/chunk'
}

function isApprovalAsked(
  event: SessionEvent,
): event is SessionEvent & {
  readonly type: 'approval/asked'
  readonly data: {
    readonly callId: string
    readonly action: DecisionTrace['approval']['action']
    readonly basis: NonNullable<DecisionTrace['approval']['basis']>
    readonly impact: NonNullable<DecisionTrace['approval']['impact']>
    readonly askedAt: number
  }
} {
  return event.type === 'approval/asked'
}

function isApprovalDecided(
  event: SessionEvent,
): event is SessionEvent & {
  readonly type: 'approval/decided'
  readonly data: {
    readonly callId: string
    readonly result: Exclude<DecisionTrace['approval']['status'], 'not-requested' | 'pending'>
    readonly decidedBy: NonNullable<DecisionTrace['approval']['decided_by']>
    readonly decidedAt: number
  }
} {
  return event.type === 'approval/decided'
}

function hasReplayableRequest(header: EpochHeader): boolean {
  return typeof header.system === 'string' && Array.isArray(header.tools)
}

function replayToolCalls(events: readonly SessionEvent[]): readonly ReplayToolCall[] {
  const results = new Map<string, ToolResultMessage>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const data = event.data as { readonly message: ToolResultMessage }
    results.set(data.message.toolCallId, data.message)
  }

  const calls: ReplayToolCall[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { readonly callId: string; readonly name: string; readonly card?: string; readonly arguments: string }
    const result = results.get(data.callId)
    calls.push({
      call: { seq: event.seq, call_id: data.callId, name: data.name, arguments: data.arguments, ...(data.card === undefined ? {} : { card: data.card }) },
      ...(result === undefined ? {} : { result }),
    })
  }
  return calls
}

function replayDecisions(events: readonly SessionEvent[]): readonly ReplayDecision[] {
  const decisions: ReplayDecision[] = []
  for (const event of events) {
    if (event.type === 'approval/asked') {
      const data = event.data as { readonly basis: { readonly reason: string }; readonly askedAt: number }
      decisions.push({ kind: 'approval/asked', basis: data.basis.reason, at: data.askedAt })
      continue
    }
    if (event.type === 'approval/decided') {
      const data = event.data as { readonly result: string; readonly decidedBy: string; readonly decidedAt: number }
      decisions.push({ kind: `approval/decided:${data.result}`, basis: data.decidedBy, at: data.decidedAt })
    }
  }
  return decisions
}

interface AuditEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

function asAuditEvent(event: SessionEvent): AuditEvent {
  return event as unknown as AuditEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sandboxTrace(events: readonly SessionEvent[]): DecisionTrace['sandbox'] {
  let trace: DecisionTrace['sandbox'] = { status: 'not-recorded' }
  for (const event of events) {
    const audit = asAuditEvent(event)
    if (audit.type === 'sandbox/profile' && isRecord(audit.data)) {
      trace = {
        status: 'profiled',
        ...(typeof audit.data['mode'] === 'string' ? { mode: audit.data['mode'] } : {}),
      }
      continue
    }
    if (audit.type === 'sandbox/degraded' && isRecord(audit.data)) {
      trace = {
        status: 'degraded',
        ...(typeof audit.data['reason'] === 'string' ? { reason: audit.data['reason'] } : {}),
        ...(typeof audit.data['mechanism'] === 'string' ? { mechanism: audit.data['mechanism'] } : {}),
      }
    }
  }
  return trace
}

function decisionTrace(events: readonly SessionEvent[], callIndex: number): DecisionTrace {
  const callEvent = events[callIndex]
  if (callEvent === undefined || callEvent.type !== 'tool/call') throw new Error('不可达：工具调用丢失')
  const { callId, name } = callEvent.data

  // 工具流水线逐个执行。窗口到匹配结果为止，避免同名 callId 在后续轮次复用时串线。
  let endIndex = events.length
  for (let index = callIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'tool/result' && event.data.message.toolCallId === callId) {
      endIndex = index + 1
      break
    }
  }
  const related = events.slice(callIndex + 1, endIndex)
  const asked = related.filter(isApprovalAsked).find((event) => event.data.callId === callId)
  const decided = related.filter(isApprovalDecided).find((event) => event.data.callId === callId)

  if (asked === undefined) {
    return {
      call: { seq: callEvent.seq, call_id: callId, name },
      policy: { status: 'not-recorded' },
      approval: { status: 'not-requested' },
      sandbox: sandboxTrace(related),
    }
  }

  const approval: DecisionTrace['approval'] = {
    status: decided?.data.result ?? 'pending',
    action: asked.data.action,
    basis: asked.data.basis,
    impact: asked.data.impact,
    // 旧日志缺少时间字段时，事件信封 time 是唯一正确回退，不改写原日志。
    asked_at: asked.data.askedAt ?? asked.time,
    ...(decided === undefined
      ? {}
      : {
          decided_at: decided.data.decidedAt ?? decided.time,
          decided_by: decided.data.decidedBy,
        }),
  }
  return {
    call: { seq: callEvent.seq, call_id: callId, name },
    policy: { status: 'recorded', basis: asked.data.basis },
    approval,
    sandbox: sandboxTrace(related),
  }
}

function closedTurnCheckpoints(events: readonly SessionEvent[]): readonly Checkpoint[] {
  const openTurns = new Set<number>()
  const checkpoints: Checkpoint[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurns.add(event.data.turn)
      continue
    }
    if (event.type !== 'turn/end' || !openTurns.has(event.data.turn)) continue
    openTurns.delete(event.data.turn)
    checkpoints.push({
      turn: event.data.turn,
      end_seq: event.seq,
      ended_at: event.time,
      reason: event.data.reason,
    })
  }
  return checkpoints
}

function historyBody(sessionId: string, event: SessionEvent): HistoryBodyResult {
  // I5 已保证 data 能无损 JSON 化。复制后返回，调用方不能改到内存中的权威事件。
  const encoded = JSON.stringify(event.data)
  return {
    bytes: Buffer.byteLength(encoded, 'utf8'),
    // `ref` 不暴露日志路径；同一不可变事件数据总有同一 ref，追加后不会失效。
    ref: `event:${Buffer.from(`${sessionId}:${event.seq}:${sha256Hex(encoded)}`, 'utf8').toString('base64url')}`,
    data: JSON.parse(encoded) as JsonValue,
  }
}

/** 事件帧 → 追加输入（回放已有日志用；`seq` 由 store 重新分配，必须与位置一致） */
function toEventInput(frame: EventFrame): EventInput {
  return {
    type: frame.type,
    data: frame.data as JsonValue,
    time: frame.time,
    ...(frame.surfaceOp === undefined ? {} : { surfaceOp: frame.surfaceOp }),
    ...(frame.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: frame.sourceEventSeqs }),
    ...(frame.ignorable === true ? { ignorable: true } : {}),
  } as unknown as EventInput
}

/**
 * 切点是否安全（doc 06 §7.2）：前缀里**不能有未闭合的轮**。
 * 与 `core/session` 的 `fork()` 同判据；那边是私有的，这里保持同一语义（有测试兜住）。
 */
function isSafeForkBoundary(prefix: readonly { readonly type: string }[]): boolean {
  let opened = false
  for (const event of prefix) {
    if (event.type === 'turn/start') opened = true
    if (event.type === 'turn/end') opened = false
  }
  return !opened
}

interface SessionRowLike {
  [column: string]: unknown
}

function rowToHeader(row: SessionRowLike): SessionHeader {
  return {
    session_id: String(row['session_id']),
    workspace: (row['workspace'] as string | null) ?? null,
    workspace_key: String(row['workspace_key']),
    title: String(row['title'] ?? ''),
    created_at: Number(row['created_at']),
    updated_at: Number(row['updated_at']),
    preset: (row['preset'] as string | null) ?? null,
    model_provider: (row['model_provider'] as string | null) ?? null,
    model_name: (row['model_name'] as string | null) ?? null,
    status: String(row['status']) as SessionStatus,
    parent_session: (row['parent_session'] as string | null) ?? null,
    seed_length: Number(row['seed_length'] ?? 0),
    log_path: String(row['log_path']),
    log_codec: (row['log_codec'] as 'none' | 'zstd') ?? 'none',
    key_id: (row['key_id'] as string | null) ?? null,
  }
}

function rowToMeta(row: SessionRowLike): SessionMeta {
  return {
    ...rowToHeader(row),
    last_seq: Number(row['last_seq']),
    log_bytes: Number(row['log_bytes'] ?? 0),
    log_revision: (row['log_revision'] as string | null) ?? null,
    archived_at: (row['archived_at'] as number | null) ?? null,
    deleted_at: (row['deleted_at'] as number | null) ?? null,
  }
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

const CURSOR_SEP = '\u0000'

function encodeCursor(updatedAt: number, sessionId: string): string {
  return Buffer.from(`${updatedAt}${CURSOR_SEP}${sessionId}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { updatedAt: number; sessionId: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const at = text.indexOf(CURSOR_SEP)
  if (at < 0) throw invalidParams(`cursor 格式非法：${cursor}`)
  const updatedAt = Number(text.slice(0, at))
  if (!Number.isFinite(updatedAt)) throw invalidParams(`cursor 格式非法：${cursor}`)
  return { updatedAt, sessionId: text.slice(at + 1) }
}

/** Markdown 导出：只含对话正文（doc 21 §2.1 `sessions.export` 的 md 语义） */
function renderMarkdown(header: { session_id: string; cwd: string | null; createdAt: number }, messages: readonly ModelMessage[]): string {
  const lines: string[] = [
    `# 会话 ${header.session_id}`,
    '',
    `- 工作区：${header.cwd ?? '（未指定）'}`,
    `- 创建于：${new Date(header.createdAt).toISOString()}`,
    `- 消息数：${messages.length}`,
    '',
    '---',
    '',
  ]
  messages.forEach((message, index) => {
    lines.push(`## ${index + 1}. ${message.role}`, '')
    const text = extractVisibleText(message)
    lines.push(text === '' ? '_（无文本内容）_' : text, '')
  })
  return lines.join('\n')
}

export class LocalSessionsApi implements RuntimeSessionsService, HistoryApi {
  private readonly home: string
  private readonly persistence: JsonlSessionPersistence
  private readonly index: SessionIndexWriter
  private readonly now: () => number
  private readonly sessions = new Map<string, OpenSession>()

  constructor(options: LocalSessionsApiOptions) {
    this.home = options.home
    this.now = options.now ?? ((): number => nowEpochMs())
    this.index = options.index ?? new SessionIndexWriter({ home: options.home })
    this.persistence = options.persistence ?? createJsonlPersistence({ home: options.home, sink: this.index })
  }

  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const cwd = this.requireCwd(input.cwd)
    const sessionId = newSessionId()
    await this.persistence.open(sessionId, { cwd })
    this.sessions.set(sessionId, { store: new InMemorySessionStore(sessionId), cwd })
    // 落一次空投影：否则 `list` 看不到这个还没有任何事件的会话
    await this.persistence.flush(sessionId)
    await this.index.drain()
    // `title` 是用户元数据，JSONL 里没有它的位置（22 §3.1 / §4.1），只能落在索引上。
    // 必须在上面那次空投影**之后**写：投影走 UPSERT，空 title 会走"保留已有值"分支，
    // 所以顺序反过来的话这里设的标题会被紧随其后的投影保持（其实也行），
    // 但先投影再设标题更直白——每个会话总是先有行、再有属性。
    if (input.title !== undefined && input.title !== '') {
      openIndexDb({ home: this.home })
        .prepare('UPDATE sessions SET title = ? WHERE session_id = ?')
        .run(input.title, sessionId)
    }
    const meta = this.metaFromIndex(sessionId)
    return { session_id: sessionId, last_seq: meta?.last_seq ?? -1 }
  }

  async resume(input: ResumeSessionInput): Promise<ResumeSessionResult> {
    const sessionId = input.session_id

    /*
     * **已经打开的会话：直接返回，绝不做"磁盘恢复"。**
     *
     * 这一条是实测踩出来的，而且后果很重。原来的实现无论会话是否已在内存里，
     * 都走"读文件 → `forget()` → `recoverLog()`（**按文件重写**）→ `ensureOpen()`"。
     * 而 UI 的正常流程恰好会踩中：
     *
     * ```
     * 首页发送 → 引擎拿到 store A 开跑（磁盘上还只有 turn/start…）
     *          → 跳转工作台 → session.open → resume
     *          → 读到"turn 开着"的旧快照 → 合成 turn/end(aborted) + end-seed
     *          → forget() 删掉 store A、adopt() 建出 store B
     *          → 模型的分片这时才回来，引擎**仍然往已经孤立的 store A 写**
     * ```
     *
     * 结果：store B 与 store A 各自从 0 编号，日志里出现**重复 seq**（违反 I2），
     * 一个正常结束的轮被记成 `aborted`，界面上第二轮永远渲染不出来。
     *
     * **为什么"已打开"就不该恢复**：会话在本进程里打开着，说明进程活着、内存镜像
     * 不比磁盘旧（write-behind 只会滞后于内存）。真正的崩溃恢复场景是"新进程 +
     * 磁盘上有未闭合的轮"——那时 `this.sessions` 里没有它，自然会走下面那条路。
     */
    const open = this.sessions.get(sessionId)
    if (open !== undefined) {
      // 待写的事件先推过持久屏障，这样调用方（以及索引）看到的是最新状态
      await this.persistence.flush(asSessionId(sessionId))
      return { session_id: sessionId, last_seq: open.store.length - 1, repaired: false }
    }

    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw notFound(sessionId)

    const loaded = loadLog(file)

    // 走到这里说明会话**不在内存里**（新进程，或崩溃前那一次 run 已经没了），
    // 所以下面是纯粹的"从磁盘恢复"，不需要再 `forget()` 任何进程内状态。

    // **为什么是"重写"而不是"追加几条"**：撕裂尾场景下磁盘帧数比可用事件数多一条
    // （被丢弃的那条），补记的 `seq` 只能从**保留下来**的事件之后续起，与磁盘帧数对不上；
    // 而运行期补写又会让"内存镜像"与"文件内容"静默分叉（把 seq 号段提前占用）。
    // 物化重写把"已有事件 + 补记"一次性按 I2 连续编号落盘，两个问题一起消失，
    // 且走的是 22 §4.3 既有的原子物化原语（tmp → fsync → rename）。
    const recovery = await this.recoverLog(file, loaded)

    // 重新打开（持久化侧 + 内存镜像）：此时读到的就是恢复后的日志
    const session = await this.ensureOpen(sessionId)

    if (input.seed !== undefined && input.seed.length > 0) {
      const appended = session.store.appendMany(input.seed.map((event) => this.eventToInput(event)))
      await this.persistence.append(asSessionId(sessionId), appended as readonly SessionEvent[])
    }

    const closers = framesToEvents(recovery.appended)

    return {
      session_id: sessionId,
      last_seq: session.store.length - 1,
      repaired: loaded.tornTailDiscarded || closers.length > 0,
      ...(closers.length === 0 ? {} : { closers }),
    }
  }

  async list(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const where: string[] = ['deleted_at IS NULL']
    const args: unknown[] = []
    if (input.workspace !== undefined) {
      where.push('workspace = ?')
      args.push(normalizePath(input.workspace))
    }
    if (input.includeArchived !== true) where.push('archived_at IS NULL')
    if (input.cursor !== undefined) {
      const { updatedAt, sessionId } = decodeCursor(input.cursor)
      where.push('(updated_at < ? OR (updated_at = ? AND session_id < ?))')
      args.push(updatedAt, updatedAt, sessionId)
    }
    const db = openIndexDb({ home: this.home })
    const rows = db
      .prepare(
        `SELECT * FROM sessions WHERE ${where.join(' AND ')}
         ORDER BY updated_at DESC, session_id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as SessionRowLike[]

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const more = rows.length > limit && last !== undefined
    return {
      items: page.map(rowToMeta),
      ...(more ? { nextCursor: encodeCursor(Number(last!['updated_at']), String(last!['session_id'])) } : {}),
    }
  }

  async meta(input: SessionMetaInput): Promise<SessionMetaResult> {
    const sessionId = input.session_id
    if (findSessionFile(this.home, sessionId) === null) throw notFound(sessionId)
    let meta = this.metaFromIndex(sessionId)
    if (meta === null) {
      // 索引是派生层、可缺行：缺了就按日志补一次投影，而不是报"找不到会话"
      this.projectOne(sessionId)
      meta = this.metaFromIndex(sessionId)
    }
    if (meta === null) throw notFound(sessionId)
    return { last_seq: meta.last_seq, header: meta, log_revision: meta.log_revision ?? '' }
  }

  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    const sourceFile = findSessionFile(this.home, input.source_session_id)
    if (sourceFile === null) throw notFound(input.source_session_id)
    const loaded = loadLog(sourceFile)
    const boundary = input.boundary
    if (!Number.isInteger(boundary) || boundary < 0 || boundary > loaded.events.length) {
      throw forkBoundary(`切点越界：${boundary}，日志长度 ${loaded.events.length}`)
    }
    const prefix = loaded.events.slice(0, boundary)
    if (!isSafeForkBoundary(prefix)) {
      throw forkBoundary(`切点 ${boundary} 落在未闭合的轮内`)
    }

    const childId = input.child_id ?? newSessionId()
    if (findSessionFile(this.home, childId) !== null) throw invalidParams(`子会话已存在：${childId}`)
    const cwd = loaded.header.cwd
    await this.persistence.open(asSessionId(childId), {
      ...(cwd === null ? {} : { cwd }),
      parentSession: input.source_session_id,
      seedLength: boundary,
    })
    const store = new InMemorySessionStore(asSessionId(childId))
    this.sessions.set(childId, { store, cwd })

    if (prefix.length > 0) {
      const seeded = store.appendMany(prefix.map(toEventInput))
      await this.persistence.append(asSessionId(childId), seeded as readonly SessionEvent[])
    }
    // 生命周期分界线（doc 11 §7）：种子注入完立刻标记，重放时才知道"种子到此为止"
    const marker = store.append({ type: 'session/end-seed', data: {} } as unknown as EventInput)
    await this.persistence.append(asSessionId(childId), [marker as SessionEvent])
    await this.persistence.flush(asSessionId(childId))

    return { session_id: childId, last_seq: store.length - 1 }
  }

  async append(input: AppendEventInput): Promise<SessionEvent> {
    const session = await this.ensureOpen(input.session_id)
    let event: SessionEvent
    try {
      event = session.store.append({
        type: input.type,
        data: input.data,
        ...(input.surface_op === undefined ? {} : { surfaceOp: input.surface_op }),
        ...(input.source_event_seqs === undefined ? {} : { sourceEventSeqs: input.source_event_seqs }),
      } as unknown as EventInput) as unknown as SessionEvent
    } catch (err) {
      // store 会在 I4 越界时抛 RangeError。契约里 append 允许的错误码没有 I4 专用项，
      // 归一成 EC-INVALID_PARAMS（语义："你给的参数写不出合法日志"），不新增错误码。
      if (err instanceof RangeError) throw invalidParams(err.message)
      throw err
    }
    // 写入是 write-behind：这里只入队，不 await 磁盘（doc 06 §5.3 热路径纪律）
    await this.persistence.append(asSessionId(input.session_id), [event])
    return event
  }

  async derive(input: DeriveInput): Promise<DeriveResult> {
    if (input.up_to !== undefined && (!Number.isInteger(input.up_to) || input.up_to < 0)) {
      throw invalidParams(`up_to 非法：${input.up_to}`)
    }
    // 只读派生**不走 ensureOpen**：那条路会把持久化句柄挂上，而对归档会话来说
    // 挂句柄意味着**解压还原成 `.jsonl`**（22 §9.2）。派生是纯读，不该改变文件形态。
    const session = await this.ensureReadable(input.session_id)
    const events = session.store.events(input.up_to === undefined ? undefined : { to: input.up_to })
    return { messages: deriveMessages(events) }
  }

  /**
   * 从权威 JSONL 构造一次历史请求快照（21 §2.12）。
   *
   * `up_to_seq` 不是简单的数组截断：它定位到“不晚于该位置的最近请求头”，
   * 而模型消息只能由该请求头之前的事件派生。把请求后的 assistant/tool
   * 事件混进 `messages` 会让回放变成事后重算，直接破坏 I1。
   */
  async replay(input: HistoryReplayInput): Promise<ReplaySnapshot> {
    if (!Number.isInteger(input.up_to_seq) || input.up_to_seq < 0) {
      throw invalidParams(`up_to_seq 非法：${input.up_to_seq}`)
    }

    const session = await this.ensureReadable(input.session_id)
    const events = session.store.events()
    let headerIndex = -1
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (event === undefined) continue
      if (event.seq > input.up_to_seq) break
      if (isRequestHeader(event)) headerIndex = index
    }
    if (headerIndex < 0) throw replayTargetNotFound(input.session_id, input.up_to_seq)

    let endIndex = events.length
    for (let index = headerIndex + 1; index < events.length; index += 1) {
      const event = events[index]
      if (event !== undefined && isRequestHeader(event)) {
        endIndex = index
        break
      }
    }

    const headerEvent = events[headerIndex]
    if (headerEvent === undefined || !isRequestHeader(headerEvent)) throw new Error('不可达：回放请求头丢失')
    if (!hasReplayableRequest(headerEvent.data.header)) {
      throw replayFormatUnsupported(input.session_id, input.up_to_seq)
    }
    const requestEvents = events.slice(headerIndex + 1, endIndex)
    return {
      header: headerEvent.data.header,
      messages: deriveMessages(events.slice(0, headerIndex)),
      chunks: requestEvents.filter(isAssistantChunk).map((event) => event.data.chunk),
      toolCalls: replayToolCalls(requestEvents),
      decisions: replayDecisions(requestEvents),
    }
  }

  /** 从一次工具调用的相邻审计事件构造可解释的权限决策轨迹（21 §2.12）。 */
  async why(input: HistoryWhyInput): Promise<DecisionTrace> {
    if (!Number.isInteger(input.call_seq) || input.call_seq < 0) {
      throw invalidParams(`call_seq 非法：${input.call_seq}`)
    }
    const session = await this.ensureReadable(input.session_id)
    const events = session.store.events()
    const callIndex = events.findIndex((event) => event.type === 'tool/call' && event.seq === input.call_seq)
    if (callIndex < 0) throw replayTargetNotFound(input.session_id, input.call_seq)
    return decisionTrace(events, callIndex)
  }

  /** 列出已闭合轮边界；文件回滚属于后续 P6，不在这里预先承诺。 */
  async checkpoints(input: HistoryCheckpointsInput): Promise<readonly Checkpoint[]> {
    const session = await this.ensureReadable(input.session_id)
    return closedTurnCheckpoints(session.store.events())
  }

  /** 惰性读取单个事件 payload；权限校验由将来 IPC 边界按会话归属执行。 */
  async body(input: HistoryBodyInput): Promise<HistoryBodyResult> {
    if (!Number.isInteger(input.seq) || input.seq < 0) {
      throw invalidParams(`seq 非法：${input.seq}`)
    }
    const session = await this.ensureReadable(input.session_id)
    const event = session.store.events().find((candidate) => candidate.seq === input.seq)
    if (event === undefined) throw historyEventNotFound(input.session_id, input.seq)
    return historyBody(input.session_id, event)
  }

  async flush(input: FlushInput): Promise<FlushResult> {
    // 会话存在即可冲洗（哪怕当前没在内存里）。
    // **不能**用 `ensureOpen`：那条路径会把日志灌进内存 store 并重新注册持久化句柄，
    // 而 `flush` 的语义只是"把已排队的写入推过持久屏障"。走 ensureOpen 会凭空
    // 造出一个**空的**内存 store，于是 flush 变成 no-op——索引侧也就永远看不到新事件。
    if (findSessionFile(this.home, input.session_id) === null) throw notFound(input.session_id)
    await this.persistence.flush(asSessionId(input.session_id))
    await this.index.drain()
    return { flushed: true }
  }

  async export(input: ExportInput): Promise<ExportResult> {
    const sessionId = input.session_id
    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw notFound(sessionId)
    const dir = join(exportsRoot(this.home))
    mkdirSync(dir, { recursive: true })
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')

    if (input.format === 'jsonl') {
      // jsonl 导出 = 原始日志的字节级副本（doc 22 §9.5：导出要能再导入）
      const bytes = readFileSync(file)
      const target = join(dir, `${sessionId}-${stamp}.jsonl`)
      writeFileAtomicSync(target, bytes)
      return { path: target, bytes: bytes.length, sha256: sha256Hex(bytes) }
    }

    const loaded = loadLog(file)
    const messages = deriveMessages(loaded.events.map(frameToEvent))
    const text = renderMarkdown(
      { session_id: sessionId, cwd: loaded.header.cwd, createdAt: loaded.header.createdAt },
      messages,
    )
    const target = join(dir, `${sessionId}-${stamp}.md`)
    writeFileAtomicSync(target, text)
    return { path: target, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) }
  }

  async import(input: ImportSessionInput): Promise<ImportSessionResult> {
    if (typeof input.path !== 'string' || input.path.trim() === '') throw invalidParams('导入路径不能为空')
    const source = input.path
    if (!existsSync(source) || !statSync(source).isFile()) throw invalidParams(`导入文件不存在或不是普通文件：${source}`)
    let loaded: LoadedLog
    try {
      loaded = loadLog(source)
    } catch (cause) {
      throw invalidParams(`导入文件不是受支持的 JSONL 会话：${cause instanceof Error ? cause.message : String(cause)}`)
    }

    const sourceBytes = readFileSync(source)
    const sessionId = newSessionId()
    await this.persistence.open(asSessionId(sessionId), { ...(loaded.header.cwd === null ? {} : { cwd: loaded.header.cwd }) })
    const store = new InMemorySessionStore(asSessionId(sessionId))
    this.sessions.set(sessionId, { store, cwd: loaded.header.cwd })
    try {
      const provenance = store.append({
        type: 'session/imported',
        data: {
          source: {
            file: source,
            sha256: sha256Hex(sourceBytes),
            bytes: sourceBytes.length,
            sourceSessionId: loaded.header.sessionId,
            sourceCreatedAt: loaded.header.createdAt,
            importedAt: this.now(),
          },
        },
      })
      const imported = store.appendMany(loaded.events.map(toEventInput))
      await this.persistence.append(asSessionId(sessionId), [provenance, ...imported] as readonly SessionEvent[])
      await this.persistence.flush(asSessionId(sessionId))
      await this.index.drain()
      const title = input.title?.trim() || '导入的共享会话'
      openIndexDb({ home: this.home }).prepare('UPDATE sessions SET title = ? WHERE session_id = ?').run(title, sessionId)
      return { session_id: sessionId, last_seq: store.length - 1, imported_events: imported.length }
    } catch (cause) {
      this.sessions.delete(sessionId)
      throw cause
    }
  }

  /**
   * 全文检索（22 §3.13 的 FTS5 形态）。
   *
   * `searchMessages` 只回 `(session_id, seq, role)`，命中文本要回 `messages_projection`
   * 取原样 `summary`（分词后中文带空格，不能用 `snippet()`）。结果**按会话去重**：
   * 同一个会话里命中多条的，只保留排名最高的一条——列表里重复出现同一会话没有意义。
   */
  async search(input: SearchSessionsInput): Promise<SearchSessionsResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query === '') throw invalidParams('检索词不能为空')
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50)
    // 索引写入是写后异步的；检索前先排空，避免刚追加的消息搜不到
    await this.index.drain()
    const db = openIndexDb({ home: this.home })
    // 去重前多取一些，避免一个会话的多条命中占满配额
    const hits = searchMessages(db, query, {
      limit: Math.min(limit * 5, 200),
      ...(input.include_deleted === true ? { includeDeleted: true } : {}),
    })
    const lookup = db.prepare(
      `SELECT m.summary AS summary, s.title AS title, s.workspace AS workspace, s.updated_at AS updated_at
       FROM messages_projection m
       JOIN sessions s ON s.session_id = m.session_id
       WHERE m.session_id = ? AND m.seq = ?
       ORDER BY m.surface_index DESC
       LIMIT 1`,
    )
    const seen = new Set<string>()
    const items: SearchSessionHit[] = []
    for (const hit of hits) {
      if (seen.has(hit.sessionId)) continue
      const row = lookup.get(hit.sessionId, hit.seq) as
        | { summary: string; title: string; workspace: string | null; updated_at: number }
        | undefined
      if (row === undefined) continue
      seen.add(hit.sessionId)
      items.push({
        session_id: hit.sessionId,
        seq: hit.seq,
        role: hit.role === 'assistant' || hit.role === 'tool' ? hit.role : 'user',
        summary: row.summary,
        title: row.title,
        workspace: row.workspace,
        updated_at: row.updated_at,
      })
      if (items.length >= limit) break
    }
    return { items }
  }

  /** 全量重建索引（`lcode index rebuild` 的进程内入口；T6.4 `doctor --index` 也会用它） */
  reindex(sessionId?: string): ReturnType<typeof rebuildIndex> {
    return rebuildIndex({ home: this.home, ...(sessionId === undefined ? {} : { sessionId }) })
  }

  /**
   * 全量导出（22 §9.5 的 `lcode export --all`）：逐会话写文件 + `manifest.json`。
   *
   * `manifest.json` 记每个文件的字节数与 SHA-256——`revision` 是廉价变更令牌、
   * **不用于完整性校验**（22 §4.3），所以"用户能自己校验备份"必须靠这个清单。
   *
   * 单个会话失败（损坏、文件读不到）**不中断整次导出**：记进 `skipped` 继续跑。
   * 理由与 `index rebuild` 一致——一个坏文件不该让其余 99 个导不出来。
   */
  async exportAll(input: ExportAllInput = {}): Promise<ExportAllResult> {
    const format: ExportFormat = input.format ?? 'jsonl'
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const dir = input.out ?? join(exportsRoot(this.home), stamp)
    mkdirSync(dir, { recursive: true })

    const entries: ExportAllEntry[] = []
    const skipped: { session_id: string; reason: string }[] = []

    for (const { sessionId, file } of listSessionFiles(this.home)) {
      try {
        let bytes: Buffer
        let name: string
        if (format === 'jsonl') {
          bytes = readFileSync(file)
          name = `${sessionId}.jsonl`
        } else {
          const loaded = loadLog(file)
          const text = renderMarkdown(
            { session_id: sessionId, cwd: loaded.header.cwd, createdAt: loaded.header.createdAt },
            deriveMessages(loaded.events.map(frameToEvent)),
          )
          bytes = Buffer.from(text, 'utf8')
          name = `${sessionId}.md`
        }
        const target = join(dir, name)
        writeFileAtomicSync(target, bytes)
        entries.push({ session_id: sessionId, path: target, bytes: bytes.length, sha256: sha256Hex(bytes) })
      } catch (err) {
        skipped.push({ session_id: sessionId, reason: err instanceof Error ? err.message : String(err) })
      }
    }

    const manifestPath = writeManifest(dir, {
      // manifest 自己也说清口径：这是"导出时刻"的快照，不是活的索引
      generated_at: this.now(),
      format,
      home: this.home,
      count: entries.length,
      skipped,
      files: entries.map((entry) => ({
        session_id: entry.session_id,
        file: entry.path.slice(dir.length + 1),
        bytes: entry.bytes,
        sha256: entry.sha256,
      })),
    })

    return { dir, manifest_path: manifestPath, entries, skipped }
  }

  /**
   * 软删（22 §9.3）：写 `sessions.deleted_at`，**文件不动**。
   *
   * 投影的 UPSERT 有意不碰 `deleted_at`（见 `project.ts` 的注释），所以这个标记
   * 不会被后续重投影覆盖掉——这正是软删能长期生效的前提。
   */
  async delete(input: DeleteSessionInput): Promise<DeleteSessionResult> {
    const sessionId = input.session_id
    if (findSessionFile(this.home, sessionId) === null) throw notFound(sessionId)
    const existing = this.metaFromIndex(sessionId)
    if (existing === null) {
      // 索引缺行：先补一次投影，否则"软删"会无处落笔
      this.projectOne(sessionId)
    }
    const deletedAt = this.now()
    openIndexDb({ home: this.home })
      .prepare('UPDATE sessions SET deleted_at = ? WHERE session_id = ?')
      .run(deletedAt, sessionId)
    return { deleted_at: deletedAt }
  }

  async restore(input: RestoreSessionInput): Promise<RestoreSessionResult> {
    const sessionId = input.session_id
    if (findSessionFile(this.home, sessionId) === null && !this.isInTrash(sessionId)) {
      throw notFound(sessionId)
    }
    openIndexDb({ home: this.home })
      .prepare('UPDATE sessions SET deleted_at = NULL WHERE session_id = ?')
      .run(sessionId)
    return { restored: true }
  }

  /**
   * 硬删（22 §9.3）：文件移入 `trash/` → 删索引行（外键级联清派生表）→ 清 `cache/spill`。
   *
   * **必须先确认可导出**：`exported !== true && force !== true` 时回 `EC-CONFLICT`。
   * 这不是防护性编程——"用户拥有自己的数据"要求删除前一定有导出提示，
   * 而"提示"只有在**真的拦住**一次调用时才有意义（11 §9.3 / 宪法第二条）。
   *
   * 顺序有讲究：**先移文件、后删索引行**。反过来的话，中途失败会留下"索引说会话没了、
   * 文件还在"的状态，用户再也找不到它；而"文件在回收站、索引还留着"是可恢复的。
   */
  async purge(input: PurgeSessionInput): Promise<PurgeSessionResult> {
    const sessionId = input.session_id
    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw notFound(sessionId)
    if (input.exported !== true && input.force !== true) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_CONFLICT,
        message: `会话 ${sessionId} 尚未导出，拒绝硬删（11 §9.3：删除前必先提示导出）`,
        userMessage: '删除前建议先导出一份备份。确认不要备份的话，请再次确认删除。',
        retryable: false,
      })
    }

    const at = this.now()
    const trashedPath = moveToTrash(this.home, file, sessionId, at)
    // 索引行删除会经外键 CASCADE 带走 session_log_index / turns / steps / events /
    // messages_projection / tool_calls / checkpoints；FTS 由触发器随行删除同步
    // `file_changes` 没有外键，按 22 §9.5「显式清理」
    const db = openIndexDb({ home: this.home })
    const purgeTx = db.transaction((id: string) => {
      db.prepare('DELETE FROM file_changes WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(id)
    })
    purgeTx(sessionId)

    const spillFreed = purgeSpillFor(this.home, sessionId)
    this.sessions.delete(sessionId)
    await this.persistence.close(asSessionId(sessionId))

    return { trashed_path: trashedPath, spill_freed_bytes: spillFreed }
  }

  /** 回收站清单（含每条距到期的剩余时间） */
  async listTrash(): Promise<ListTrashResult> {
    const now = this.now()
    const items: TrashEntry[] = listTrashEntries(this.home).map((entry) => ({
      session_id: entry.session_id,
      path: entry.path,
      bytes: entry.bytes,
      deleted_at: entry.deleted_at,
      // 时间基准必须与 pruneTrash 一致：都用条目自带的 deleted_at
      expires_in_ms: Math.max(0, entry.deleted_at + TRASH_RETENTION_MS - now),
    }))
    items.sort((a, b) => b.deleted_at - a.deleted_at)
    return { items, total_bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
  }

  async storageUsage(): Promise<StorageUsageResult> {
    return storageUsage(this.home)
  }

  /** 保留策略维护（22 §9.2）：回收站到期清理 + `cache/` 全局 LRU。**绝不删会话**。 */
  async prune(input: PruneStorageInput = {}): Promise<PruneStorageResult> {
    let trash: PruneStorageResult['trash'] = { removed: 0, freedBytes: 0, kept: 0 }
    if (input.emptyTrash === true) {
      const result = emptyTrash(this.home)
      trash = { removed: result.removed.length, freedBytes: result.freedBytes, kept: 0 }
    } else if (input.trash !== false) {
      const result = pruneTrash(this.home, { now: this.now() })
      trash = { removed: result.removed.length, freedBytes: result.freedBytes, kept: result.kept }
    }

    let cache: PruneStorageResult['cache'] = {
      evicted: 0,
      freedBytes: 0,
      remainingBytes: dirBytes(join(this.home, CACHE_DIR)),
      stillOverLimit: false,
    }
    if (input.purgeCache === true) {
      const freed = purgeCache(this.home)
      cache = { evicted: 0, freedBytes: freed, remainingBytes: 0, stillOverLimit: false }
    } else if (input.cache !== false) {
      const result = pruneCache(this.home)
      cache = {
        evicted: result.evicted.length,
        freedBytes: result.freedBytes,
        remainingBytes: result.remainingBytes,
        stillOverLimit: result.stillOverLimit,
      }
    }

    return { trash, cache, usage: this.storageUsageSync() }
  }

  /**
   * 压缩归档空闲会话（22 §9.2/§9.4；T6.2）。
   *
   * **开放中的会话永不压缩**（22 §9.2）：`openSessionIds` 由装配层给。
   * 本类自己也持有已打开会话的清单，所以两者取并集——调用方忘了传也不会压到热文件。
   */
  async archive(input: ArchiveInput = {}): Promise<ArchiveResult> {
    const open = new Set<string>([...(input.openSessionIds ?? []), ...this.sessions.keys()])
    const report = applyRetention({
      home: this.home,
      openSessionIds: [...open],
      ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
      ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      ...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
      now: this.now(),
    })
    // 归档改的是**文件形态**，所以索引里的 `log_path` / `log_bytes` / `log_codec`
    // 必须同步——否则 `doctor --index` 会把每个归档会话都报成"文件不见了"，而它其实好好的。
    for (const entry of report.archived) {
      this.reindex(entry.sessionId)
    }
    return {
      scanned: report.scanned,
      archived: report.archived.map((entry) => ({
        session_id: entry.sessionId,
        file: entry.file,
        archived_path: entry.archivedPath,
        original_bytes: entry.originalBytes,
        compressed_bytes: entry.compressedBytes,
        ratio: entry.ratio,
      })),
      skipped_idle: report.skippedIdle,
      skipped_open: report.skippedOpen,
      failed: report.failed.map((f) => ({ session_id: f.sessionId, message: f.message })),
      zstd_available: report.zstdAvailable,
    }
  }

  /** 会话是否在回收站里（`restore` 允许"文件已进回收站但索引行还在"的情形） */
  private isInTrash(sessionId: string): boolean {
    const root = trashRoot(this.home)
    if (!existsSync(root)) return false
    return readdirSync(root).some((name) => name.startsWith(`${sessionId}.jsonl.`))
  }

  private storageUsageSync(): StorageUsageResult {
    return storageUsage(this.home)
  }

  /**
   * 索引体检（22 §1.3 / T6.4）：逐会话比对 `sessions.log_revision` 与真实文件。
   *
   * 判据只有一个：**索引里记的 revision 与文件此刻的 revision 是否相等**。
   * `revision` 是廉价变更检测令牌（22 §4.3），所以这趟体检是 O(会话数) 次 stat，
   * 不需要读日志内容——这正是当初选它而不是内容哈希的理由。
   *
   * 四类判定（`reason`）：
   * | reason | 含义 | 建议动作 |
   * |---|---|---|
   * | `missing` | 索引里有行，日志文件不在了 | 删掉索引里的孤儿行（或恢复文件） |
   * | `changed` | 文件被外部改动（手工编辑、别的工具写入） | 重建该会话索引 |
   * | `not-indexed` | 日志存在但索引里没有 | 重建该会话索引 |
   * | `no-revision` | 索引行存在但 `log_revision` 为空 | 重建该会话索引 |
   *
   * `ok` 为 true 表示**没有需要处理的会话**；`needsReindex` 是前三类里"重建能解决"的
   * 那部分（`missing` 单独列出，因为它多半需要人工看一眼，不是重建能救回的）。
   */
  async doctorIndex(): Promise<IndexDoctorReport> {
    const indexed = new Map<string, string | null>()
    let schemaVersion: number | null = null
    let dbExists = false
    try {
      const status = describeIndexDb(this.home)
      dbExists = status.exists
      schemaVersion = status.schemaVersion
      if (dbExists) {
        const db = openIndexDb({ home: this.home })
        const rows = db.prepare('SELECT session_id, log_path, log_revision FROM sessions').all() as {
          session_id: string
          log_path: string | null
          log_revision: string | null
        }[]
        for (const row of rows) indexed.set(row.session_id, row.log_revision)
      }
    } catch {
      // 索引库损坏/半截：体检本身不该因此炸掉——报"库有问题，建议重建"即可
      return {
        ok: false,
        dbExists,
        schemaVersion,
        findings: [],
        needsReindex: 0,
        note: '索引库无法读取（可能已损坏或版本不匹配）——建议运行 lcode index rebuild',
      }
    }

    const findings: IndexFinding[] = []
    const onDisk = new Set<string>()

    for (const { sessionId, file } of listSessionFiles(this.home)) {
      onDisk.add(sessionId)
      const known = indexed.get(sessionId)
      if (known === undefined) {
        findings.push({ sessionId, logPath: file, reason: 'not-indexed' })
        continue
      }
      if (known === null || known === '') {
        findings.push({ sessionId, logPath: file, reason: 'no-revision' })
        continue
      }
      let current: string
      try {
        current = computeRevision(file).revision
      } catch {
        findings.push({ sessionId, logPath: file, reason: 'missing' })
        continue
      }
      if (current !== known) findings.push({ sessionId, logPath: file, reason: 'changed' })
    }

    // 索引里有、磁盘上没有（文件被删/移走）
    for (const sessionId of indexed.keys()) {
      if (!onDisk.has(sessionId)) {
        findings.push({ sessionId, logPath: null, reason: 'missing' })
      }
    }

    const needsReindex = findings.filter((f) => f.reason !== 'missing').length
    return {
      ok: findings.length === 0 && dbExists,
      dbExists,
      schemaVersion,
      findings,
      needsReindex,
      ...(dbExists ? {} : { note: '索引库不存在——运行 lcode index rebuild 即可从 JSONL 重建' }),
    }
  }

  /**
   * 引擎装配入口（docs/24 T5.1：让 `agent-loop` 的事件经持久化会话写入 JSONL → SQLite）。
   *
   * 为**已打开**的会话返回一个与 `sessions.*` 共用同一内存 store 的持久化
   * `SessionService`——对它的 `append` 会同时：① 由 store 分配 seq、落内存日志；
   * ② 写穿到**同一条** JSONL 日志（write-behind），进而经索引侧投影到 SQLite。
   *
   * 未打开的会话抛 `ES-SESSION_NOT_FOUND`（与 `getSession` 的装配契约一致）：
   * 绝不给未灌入历史日志的 store 发包装——那会让引擎的 seq 从 0 重排、覆盖已有日志。
   * 装配层先 `create`/`resume` 打开会话，再把本方法接到 `AgentLoopDeps.getSession`
   * （该签名是同步的，故本方法保持同步）。
   */
  sessionServiceFor(sessionId: string): SessionService {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw notFound(sessionId)
    return createPersistedSession(asSessionId(sessionId), session.store, this.persistence)
  }

  /**
   * 某个会话的工作区根（头部的 `cwd`）。
   *
   * 权限判定要它才能算出"这个路径在不在工作区内"（12 §4.7）。**不用
   * `process.cwd()`**：一个进程里可能开着多个工作区的会话，用进程 cwd 会让
   * 另一个会话的路径判定错位——那正是"以为在工作区内、实际写到了外面"的成因。
   */
  workspaceOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd ?? undefined
  }

  /** 关闭全部会话与索引写入器（进程退出 / 测试清理） */
  async close(): Promise<void> {
    await this.persistence.closeAll()
    await this.index.close()
    closeAllIndexDbs()
    this.sessions.clear()
  }

  /** 已打开的会话数（诊断用） */
  get openCount(): number {
    return this.sessions.size
  }

  // ─────────── 内部 ───────────

  private requireCwd(cwd: string): string {
    if (typeof cwd !== 'string' || cwd.trim() === '') throw invalidParams('cwd 必填且不能为空')
    const normalized = normalizePath(cwd.trim())
    if (/^[A-Za-z]:$/.test(normalized)) throw invalidParams(`cwd 必须是绝对路径：${cwd}`)
    if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) {
      throw invalidParams(`cwd 必须是绝对路径：${cwd}`)
    }
    return normalized
  }

  private eventToInput(event: SessionEvent): EventInput {
    return {
      type: event.type,
      data: event.data as JsonValue,
      time: event.time,
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
      ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
      ...(event.ignorable === true ? { ignorable: true } : {}),
    } as unknown as EventInput
  }

  /** 把已落盘的日志灌回内存日志（resume 的核心：seq 必须原样连续） */
  private adopt(sessionId: string, loaded: LoadedLog): OpenSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const store = new InMemorySessionStore(asSessionId(sessionId))
    if (loaded.events.length > 0) store.appendMany(loaded.events.map(toEventInput))
    const session: OpenSession = { store, cwd: loaded.header.cwd }
    this.sessions.set(sessionId, session)
    return session
  }

  /**
   * 应用崩溃恢复（11 §6 / T6.1）：见 `resume` 的调用点说明。
   * 这里只负责"从磁盘帧算出补记、编号、原子重写"，不碰任何进程内状态。
   */
  private async recoverLog(
    file: string,
    loaded: LoadedLog,
  ): Promise<{ readonly appended: readonly EventFrame[] }> {
    const frames = eventFramesOf(loaded)
    // 锚点取"最后一条保留事件的时间"：补记要贴着崩溃时刻，而不是恢复时刻
    const tailTime = frames.length === 0 ? undefined : frames[frames.length - 1]!.time
    const plan = planRecovery(frames, this.now(), tailTime)
    const closers = plan.closers
    const tornTail = loaded.tornTailDiscarded
    if (closers.length === 0 && !tornTail) return { appended: [] }

    // 补记接着**保留下来**的事件编号（撕裂尾不在其中），time 单调不减
    const appended: EventFrame[] = []
    let seq = frames.length
    let lastTime = tailTime ?? 0
    for (const closer of closers) {
      const time = Math.max(closer.time, lastTime)
      appended.push({ ...closer, seq, time })
      lastTime = time
      seq += 1
    }

    // 撕裂尾被丢弃时**也要重写**：否则那条半截记录会一直留在磁盘上，下次加载再被当一次撕裂尾
    writeFileAtomicSync(file, encodeJsonl([loaded.header, ...frames, ...appended]))
    return { appended }
  }

  private async ensureOpen(sessionId: string): Promise<OpenSession> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw notFound(sessionId)
    const loaded = loadLog(file)
    // 已打开的会话先落盘再读，语义才与"从没打开过"一致
    const session = this.adopt(sessionId, loaded)
    await this.persistence.open(asSessionId(sessionId), loaded.header.cwd === null ? {} : { cwd: loaded.header.cwd })
    return session
  }

  /**
   * 只读打开（派生 / 回放）：把日志读进内存镜像，但**绝不挂持久化句柄**。
   *
   * 为什么需要它而不是直接用 `ensureOpen`：`ensureOpen` 会 `persistence.open()`，
   * 而对**归档会话**那一步会把 `.jsonl.zst` 解压还原成 `.jsonl`（22 §9.2 的 resume 路径）。
   * 于是"看一眼列表/回放一步"这种纯读操作会把 33× 的磁盘重新吃掉，归档策略等于白做
   * ——实测确认过：一次 `lcode sessions show` 就让 `.jsonl.zst` 变回 `.jsonl`。
   */
  private async ensureReadable(sessionId: string): Promise<OpenSession> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw notFound(sessionId)
    return this.adopt(sessionId, loadLog(file))
  }

  private metaFromIndex(sessionId: string): SessionMeta | null {
    const db = openIndexDb({ home: this.home })
    const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRowLike | undefined
    return row === undefined ? null : rowToMeta(row)
  }

  /** 按需把单个会话投影进索引（索引缺行时的补救，不影响其它会话） */
  private projectOne(sessionId: string): void {
    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw notFound(sessionId)
    const indexedAt = this.now()
    const { log, spans } = loadLogWithSpans(file, indexedAt)
    const db = openIndexDb({ home: this.home })
    applyProjection(
      db,
      projectSession({
        sessionId,
        header: log.header,
        events: log.events,
        spans,
        revision: computeRevision(file).revision,
        bytes: statSync(file).size,
        indexedAt,
      }),
    )
  }
}
