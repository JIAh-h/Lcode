import { existsSync } from 'node:fs'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { appendFileSyncDurable, writeFileAtomicSync } from './atomic.ts'
import type { FileHeaderFrame, LogFrame } from './jsonl.ts'
import { encodeJsonl } from './jsonl.ts'
import { spanForFrame, type LogRecordSpan } from './spans.ts'

/**
 * 有界批写（文档 11 §5.4 / 06 §5.3；实施计划 T2.1）。
 *
 * 纪律来自"热路径"要求：**`append()` 同步返回、不 `await` 磁盘**（06 §5.3）。
 * 因此这里把"写"拆成两段：
 * - `append()` 只入队 + 排一个 ≤`batchMs` 的定时器（默认 200ms，22 复现"
 *   `SessionWriteBehind` 有界批写"）；
 * - `flush()` 是**持久屏障**：写下去并 `fsync`，之后另一进程一定能读到全部事件。
 *
 * 队列是**有界**的：累计待写字节超过 `maxPendingBytes` 时立即写一次，
 * 避免"日志写得比磁盘快"时把内存吃光（22 §5.4 的退避思想）。
 *
 * **滚动追加不走原子物化**（22 §4.3）：只有「首次创建文件」走 `writeFileAtomicSync`。
 */

export interface WriteBehindOptions {
  readonly file: string
  readonly header: FileHeaderFrame
  /** 续写已有文件时传入（来自 `loadLogWithSpans`）；不传表示新建 */
  readonly existing?: { readonly spans: readonly LogRecordSpan[]; readonly bytes: number } | undefined
  /** 批写窗口，默认 200ms */
  readonly batchMs?: number | undefined
  /** 待写字节上限，默认 1 MiB；超过即立刻落盘 */
  readonly maxPendingBytes?: number | undefined
  readonly now?: (() => number) | undefined
  /** 每次落盘后回调（索引侧据此更新投影） */
  readonly onFlush?: ((info: { readonly spans: readonly LogRecordSpan[]; readonly bytes: number }) => void) | undefined
}

function writeFailed(cause: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_LOG_WRITE_FAILED,
    message: `会话日志写入失败：${cause instanceof Error ? cause.message : String(cause)}`,
    userMessage: '记录这段对话时写盘失败了。请检查磁盘空间与目录权限。',
    retryable: true,
    cause,
  })
}

export class SessionWriteBehind {
  private readonly file: string
  private readonly header: FileHeaderFrame
  private readonly batchMs: number
  private readonly maxPendingBytes: number
  private readonly now: () => number
  private readonly onFlushCallback: WriteBehindOptions['onFlush']

  private pending: LogFrame[] = []
  private pendingBytes = 0
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private started = false

  private readonly allSpans: LogRecordSpan[]
  private fileBytes: number

  constructor(opts: WriteBehindOptions) {
    this.file = opts.file
    this.header = opts.header
    this.batchMs = opts.batchMs ?? 200
    this.maxPendingBytes = opts.maxPendingBytes ?? 1024 * 1024
    this.now = opts.now ?? ((): number => Date.now())
    this.onFlushCallback = opts.onFlush
    this.allSpans = opts.existing ? [...opts.existing.spans] : []
    this.fileBytes = opts.existing ? opts.existing.bytes : 0
  }

  /** 惰性创建：文件不存在时写出第 0 帧（头部帧）；存在则视为续写 */
  open(): void {
    if (this.started) return
    if (this.allSpans.length === 0) {
      if (!existsSync(this.file)) {
        const text = encodeJsonl([this.header])
        try {
          writeFileAtomicSync(this.file, text)
        } catch (cause) {
          throw writeFailed(cause)
        }
        const length = Buffer.byteLength(text, 'utf8')
        this.allSpans.push(spanForFrame(this.header, 0, length, this.now()))
        this.fileBytes = length
      } else {
        throw new Error(
          `SessionWriteBehind.open：文件已存在但未提供 existing 定位信息（${this.file}）——续写必须传 existing`,
        )
      }
    }
    this.started = true
  }

  /** 全部已写记录的定位（含头部帧），供 `session_log_index` 使用 */
  get spans(): readonly LogRecordSpan[] {
    return this.allSpans
  }

  /** 文件当前字节数（等价于 `sessions.log_bytes`） */
  get bytes(): number {
    return this.fileBytes
  }

  get path(): string {
    return this.file
  }

  /** 是否还有未落盘的记录 */
  get hasPending(): boolean {
    return this.pending.length > 0
  }

  /** 同步入队；不接触磁盘（除非队列越界） */
  append(frames: readonly LogFrame[]): void {
    if (this.closed) throw writeFailed(new Error('会话已关闭'))
    if (!this.started) this.open()
    if (frames.length === 0) return
    for (const frame of frames) {
      this.pending.push(frame)
      this.pendingBytes += frameByteLength(frame)
    }
    if (this.pendingBytes >= this.maxPendingBytes) {
      this.cancelTimer()
      this.writePending()
      return
    }
    this.scheduleTimer()
  }

  /** 持久屏障：写下去并 fsync；返回后其它进程能读到全部事件 */
  async flush(): Promise<void> {
    if (this.closed) return
    this.cancelTimer()
    this.writePending()
    this.onFlushCallback?.({ spans: this.allSpans, bytes: this.fileBytes })
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.flush()
    this.closed = true
  }

  private scheduleTimer(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.writePending()
      } catch {
        // 定时器路径上的失败不向上抛（没有调用方接得住）；下一次 flush() 会重试并暴露错误
      }
    }, this.batchMs)
    // 批写定时器不该拖住进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private writePending(): void {
    const frames = this.pending
    if (frames.length === 0) return
    this.pending = []
    this.pendingBytes = 0

    const text = encodeJsonl(frames)
    let written: number
    try {
      written = appendFileSyncDurable(this.file, text)
    } catch (cause) {
      // 写失败 → 记录回到队列，等待下一次 flush 重试（不静默丢数据）
      this.pending = frames.concat(this.pending)
      for (const frame of frames) this.pendingBytes += frameByteLength(frame)
      throw writeFailed(cause)
    }

    const lines = text.split('\n').filter((l) => l.length > 0)
    let offset = this.fileBytes
    const now = this.now()
    for (let i = 0; i < frames.length; i++) {
      const line = lines[i]
      const byteLength = line === undefined ? 0 : Buffer.byteLength(line, 'utf8') + 1
      this.allSpans.push(spanForFrame(frames[i]!, offset, byteLength, now))
      offset += byteLength
    }
    this.fileBytes += written
  }
}

/** 估算一条帧的编码字节数（仅用于队列水位判断，不需要精确） */
function frameByteLength(frame: LogFrame): number {
  return JSON.stringify(frame).length
}
