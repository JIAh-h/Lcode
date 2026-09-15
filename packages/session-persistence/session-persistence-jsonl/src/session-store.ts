import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent } from '@lcode/session'
import { deriveSurfaceItems } from '@lcode/session'
import type { SessionPersistenceService, VerificationReport } from '@lcode/session-persistence'
import {
  ERROR_CODES,
  LcodeErrorImpl,
  absFromHome,
  LOG_EXT,
  LOG_EXT_ZST,
  nowEpochMs,
  sessionsRoot,
  sessionLogRelPath,
  type Disposer,
  type SessionId,
} from '@lcode/util'
import { fileBytes, computeRevision } from './revision.ts'
import type { EventFrame, FileHeaderFrame } from './jsonl.ts'
import { packFrames } from './jsonl.ts'
import { loadLog, SUPPORTED_FORMAT_VERSION } from './loader.ts'
import { restoreLogFile } from './archive.ts'
import type { SessionIndexSink, SessionLogSnapshot } from './sink.ts'
import { scanSpans } from './spans.ts'
import { SessionWriteBehind } from './write-behind.ts'
import { zstdDecompress, zstdReady } from './zstd.ts'

/**
 * JSONL 会话持久化（权威真相侧；文档 22 §1/§4，实施计划 T2.1–T2.5）。
 *
 * 实现契约 `SessionPersistenceService`（`@lcode/session-persistence`）。
 * 职责边界：**这里只负责"把事实可靠地写进 JSONL 并读回来"**；
 * 索引（SQLite）通过 `SessionIndexSink` 异步跟随，失败不回压会话。
 *
 * 目录分桶（22 §2.1 / §2.5）：`sessions/<workspace-key>/<session-id>.jsonl`，
 * 无 cwd 落 `sessions/_unknown/`。
 */

export interface JsonlPersistenceOptions {
  /** Lcode Home（22 §2） */
  readonly home: string
  /** 索引侧接收口；不传则纯文件模式（CLI/测试常用） */
  readonly sink?: SessionIndexSink | undefined
  /** 批写窗口（默认 200ms，见 `SessionWriteBehind`） */
  readonly batchMs?: number | undefined
  readonly now?: (() => number) | undefined
}

interface OpenSession {
  /** 当前正在写入的文件；打开时若发现是归档件，这里指向**还原后**的 `.jsonl` */
  readonly file: string
  readonly writeBehind: SessionWriteBehind
  readonly header: FileHeaderFrame
  /** 全量事件的内存镜像（用于 flush 时给索引侧完成态快照） */
  readonly events: EventFrame[]
}

/**
 * 只读打开：读出归档件的全部事件，但**不还原成 `.jsonl`**。
 *
 * 存在的理由是一个很容易忽略的后果：归档（22 §9.2）在空闲 30 天后把会话压成
 * `.jsonl.zst`，而"看一眼列表 / 回放一步"是**只读**操作——如果它也走 `open()` 的
 * 还原路径，用户每浏览一次就把 33× 的磁盘重新吃掉，归档策略等于白做（实测确认过：
 * 一次 `lcode sessions show` 就会让 `.jsonl.zst` 变回 `.jsonl`）。
 *
 * 于是"还原"只发生在**真的要写入**时（`resume` / 追加 / 分叉）。
 */
export function loadReadOnly(file: string): { header: FileHeaderFrame; events: EventFrame[] } {
  const loaded = loadLog(file)
  return { header: loaded.header, events: loaded.events }
}

/**
 * 若路径指向归档件（`.jsonl.zst`），把它还原成 `.jsonl` 并返回**新路径**；
 * 否则原样返回。
 *
 * 还原动作发生在 `open()` 里：会话一旦被打开（要追加），就不能再是压缩形态。
 */
function restoreIfArchived(file: string): string {
  if (!file.endsWith(LOG_EXT_ZST)) return file
  if (!zstdReady()) {
    throw new LcodeErrorImpl({
      code: ERROR_CODES.ES_FORMAT_UNSUPPORTED,
      message: `会话日志是压缩归档（${file}），但本进程尚未初始化 zstd——请先调用 initZstd()`,
      userMessage: '这个对话是压缩归档的，当前环境还不能读取。',
      retryable: true,
    })
  }
  return restoreLogFile(file, zstdDecompress).path
}

/** 事件（强类型）→ 帧（物理编码）。可选字段"有才写"，避免 `undefined` 进 JSON（I5） */
export function eventToFrame(event: SessionEvent): EventFrame {
  return {
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: event.data,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
    ...(event.ignorable === undefined ? {} : { ignorable: event.ignorable }),
  }
}

/** 帧 → 事件。`EventFrame.type` 是 string（插件可扩展），此处是边界断言（06 §2.3） */
export function frameToEvent(frame: EventFrame): SessionEvent {
  return frame as unknown as SessionEvent
}

function sessionNotFound(sessionId: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_SESSION_NOT_FOUND,
    message: `会话未打开或不存在：${sessionId}`,
    userMessage: '这个对话找不到了。',
    retryable: false,
  })
}

/**
 * 按 sessionId 反查会话文件（需要跨桶扫描）。
 * 索引库缺失时（`index rebuild` 之前）靠它建立 sessionId → 路径的映射。
 */
export function findSessionFile(home: string, sessionId: string): string | null {
  const root = sessionsRoot(home)
  if (!existsSync(root)) return null
  for (const bucket of readdirSync(root)) {
    for (const ext of [LOG_EXT, LOG_EXT_ZST]) {
      const candidate = join(root, bucket, `${sessionId}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 列出全部会话文件（重建索引 / 导出 / 保留策略的输入）。
 *
 * **两种扩展名都要认**（22 §9.4）：归档过的会话是 `.jsonl.zst`，落下它等于
 * "压缩之后这个会话就从索引重建与导出里消失了"——那是静默的数据不可见，比报错严重。
 *
 * `state` 让调用方区分"还能追加的活文件"与"已归档的只读文件"：保留策略只压缩前者，
 * 导出与重建则两者都要。
 */
export function listSessionFiles(home: string): {
  sessionId: string
  bucket: string
  file: string
  state: 'live' | 'archived'
}[] {
  const root = sessionsRoot(home)
  if (!existsSync(root)) return []
  const out: { sessionId: string; bucket: string; file: string; state: 'live' | 'archived' }[] = []
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket)
    for (const name of readdirSync(dir)) {
      if (name.endsWith(LOG_EXT_ZST)) {
        out.push({
          sessionId: name.slice(0, -LOG_EXT_ZST.length),
          bucket,
          file: join(dir, name),
          state: 'archived',
        })
      } else if (name.endsWith(LOG_EXT)) {
        out.push({ sessionId: name.slice(0, -LOG_EXT.length), bucket, file: join(dir, name), state: 'live' })
      }
    }
  }
  return out
}

export class JsonlSessionPersistence implements SessionPersistenceService {
  private readonly home: string
  private readonly sink: SessionIndexSink | undefined
  private readonly batchMs: number
  private readonly now: () => number
  private readonly sessions = new Map<string, OpenSession>()
  private readonly externalHandlers = new Set<(sessionId: SessionId) => void>()
  private readonly knownRevisions = new Map<string, string>()

  constructor(opts: JsonlPersistenceOptions) {
    this.home = opts.home
    this.sink = opts.sink
    this.batchMs = opts.batchMs ?? 200
    this.now = opts.now ?? ((): number => nowEpochMs())
  }

  async open(
    sessionId: SessionId,
    opts?: { readonly cwd?: string; readonly parentSession?: string; readonly seedLength?: number },
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return
    const relPath = sessionLogRelPath(opts?.cwd ?? null, sessionId)
    const requested = absFromHome(this.home, relPath)

    let header: FileHeaderFrame
    let existing: { spans: ReturnType<typeof scanSpans>; bytes: number } | undefined
    const events: EventFrame[] = []
    // 实际要续写的文件。归档件会被还原成 `.jsonl`，所以它未必等于 `requested`
    let file = requested

    // 归档件是 `.jsonl.zst`，而 `requested` 只按 `.jsonl` 推——所以**不能**只看 `requested`。
    // 走 `findSessionFile`（它会两种扩展名都找）才不会"压缩过的会话打不开"，那等于
    // 归档把会话变成了不可访问，比不压缩严重得多。
    const located = findSessionFile(this.home, sessionId)
    if (located !== null) {
      // 归档件先还原成 `.jsonl` 再续写（22 §9.2：resume 时先解压回来）。
      // 必须在 `open` 里做而不是在 `load` 里：write-behind 要按**真实文件**追加，
      // 若让归档件保持原样，后续 append 会往一个 zstd 帧后面写明文，把文件写坏。
      file = restoreIfArchived(located)
      const loaded = loadLog(file)
      header = loaded.header
      events.push(...loaded.events)
      existing = { spans: scanSpans(loaded.lines, loaded.frames, this.now()), bytes: fileBytes(file) ?? 0 }
    } else {
      header = {
        kind: 'file-header',
        formatVersion: SUPPORTED_FORMAT_VERSION,
        sessionId,
        createdAt: this.now(),
        cwd: opts?.cwd ?? null,
        // 分叉产出的会话要记住父会话与种子长度（doc 11 §7）
        parentSession: opts?.parentSession ?? null,
        seedLength: opts?.seedLength ?? 0,
        codec: 'none',
        keyId: null,
      }
    }

    const writeBehind = new SessionWriteBehind({
      file,
      header,
      ...(existing === undefined ? {} : { existing }),
      batchMs: this.batchMs,
      now: this.now,
    })
    writeBehind.open()
    this.sessions.set(sessionId, { file, writeBehind, header, events })
    this.knownRevisions.set(sessionId, existsSync(file) ? computeRevision(file).revision : '')
  }

  /** 同步返回、不 await 磁盘（06 §5.3）；打包在此完成，写入交给 write-behind 批处理 */
  async append(sessionId: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s === undefined) throw sessionNotFound(sessionId)
    if (events.length === 0) return
    const frames = events.map(eventToFrame)
    // 连续 chunk 打包（22 §4.2）：只取事件帧，头部帧已在文件第 0 行
    const packed = packFrames(s.header, frames).slice(1)
    s.writeBehind.append(packed)
    s.events.push(...frames)
    // 把打包前的事件语义告诉内存镜像：镜像保存的是"逐条事件"，不是批帧
  }

  /** 持久屏障 + 通知索引侧 */
  async flush(sessionId: SessionId): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s === undefined) throw sessionNotFound(sessionId)
    await s.writeBehind.flush()
    this.notifySink(sessionId, s)
  }

  /** 从**磁盘**读回全部事件（保证"还原出完全相同的追加序列"，22 §4.1） */
  async load(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    const s = this.sessions.get(sessionId)
    if (s !== undefined) {
      // 已打开：先把内存里的写入落盘，再按文件读——语义与"从没打开过"完全一致
      await s.writeBehind.flush()
      const loaded = loadLog(s.file)
      return loaded.events.map(frameToEvent)
    }
    const file = findSessionFile(this.home, sessionId)
    if (file === null) throw sessionNotFound(sessionId)
    return loadLog(file).events.map(frameToEvent)
  }

  /**
   * 校验（文档 15 §2 的不变量）：
   * - I2：`seq` 连续（`load()` 已保证，这里作为独立报告项）
   * - I3：每个 `tool/call` 都有配对的 `tool/result`（未配对的调用是崩溃恢复要处理的）
   * - I4：`surface replace` 区间落在当前表面范围内
   */
  async verify(sessionId: SessionId): Promise<VerificationReport> {
    const events = await this.load(sessionId)
    const issues: string[] = []

    for (let i = 0; i < events.length; i++) {
      if (events[i]!.seq !== i) {
        issues.push(`I2：第 ${i} 条事件的 seq 是 ${events[i]!.seq}，应为 ${i}`)
        break
      }
    }

    const calls = new Set<string>()
    const results = new Set<string>()
    for (const event of events) {
      if (event.type === 'tool/call') calls.add(event.data.callId)
      else if (event.type === 'tool/result') results.add(event.data.message.toolCallId)
    }
    for (const callId of calls) {
      if (!results.has(callId)) issues.push(`I3：tool/call ${callId} 没有配对的 tool/result（未闭合调用）`)
    }

    try {
      deriveSurfaceItems(events)
    } catch (err) {
      issues.push(`I4：${err instanceof Error ? err.message : String(err)}`)
    }

    return { ok: issues.length === 0, issues, eventCount: events.length }
  }

  async close(sessionId: SessionId): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s === undefined) return
    await s.writeBehind.close()
    this.sessions.delete(sessionId)
  }

  /** 关闭全部会话（进程退出 / 测试清理） */
  async closeAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) await this.close(sessionId as SessionId)
  }

  onExternalChange(handler: (sessionId: SessionId) => void): Disposer {
    this.externalHandlers.add(handler)
    return () => {
      this.externalHandlers.delete(handler)
    }
  }

  /**
   * 比对已打开会话的 `revision` 与真实文件（22 §4.3）：不一致即外部改动，
   * 通知订阅方（上层据 `ES-LOG_MODIFIED_EXTERNALLY` 提示重新载入）。
   * 由接入层在窗口聚焦等时机调用；这里不做后台轮询，避免无谓的文件 stat。
   */
  checkExternalChanges(): void {
    for (const [sessionId, known] of this.knownRevisions) {
      const s = this.sessions.get(sessionId)
      if (s === undefined) continue
      let current = ''
      try {
        current = computeRevision(s.file).revision
      } catch {
        continue
      }
      if (current !== known && s.writeBehind.hasPending === false) {
        this.knownRevisions.set(sessionId, current)
        for (const handler of this.externalHandlers) handler(sessionId as SessionId)
      }
    }
  }

  /** 当前已打开会话的日志文件路径（调试/测试用） */
  filePathOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.file ?? null
  }

  private notifySink(sessionId: string, s: OpenSession): void {
    if (this.sink === undefined) return
    const indexedAt = this.now()
    let revision: string
    try {
      revision = computeRevision(s.file).revision
    } catch {
      revision = ''
    }
    this.knownRevisions.set(sessionId, revision)
    const snapshot: SessionLogSnapshot = {
      sessionId,
      header: s.header,
      events: s.events,
      spans: s.writeBehind.spans,
      revision,
      bytes: s.writeBehind.bytes,
      indexedAt,
    }
    try {
      this.sink.onSessionFlushed(snapshot)
    } catch {
      // 索引是派生的、可丢的：通知失败绝不回压会话（22 §1.2）
    }
  }
}

/** 便捷：从 home 直接构造（bundle/CLI 装配点用） */
export function createJsonlPersistence(opts: JsonlPersistenceOptions): JsonlSessionPersistence {
  return new JsonlSessionPersistence(opts)
}
