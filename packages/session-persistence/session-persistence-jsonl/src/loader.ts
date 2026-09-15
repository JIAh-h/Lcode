import { readFileSync } from 'node:fs'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import type { EventFrame, FileHeaderFrame, LogFrame } from './jsonl.ts'
import { isChunkBatchFrame, isHeaderFrame, unpackFrames } from './jsonl.ts'
import { scanSpans, type LogRecordSpan } from './spans.ts'
import { looksLikeZstd, zstdDecompress } from './zstd.ts'

/**
 * 读取与损坏判定（文档 22 §4.4 / 11 §6.1；实施计划 T2.2）。
 *
 * **判定顺序不能变**（22 §4.4）：先读头部帧 → 校验 `formatVersion` → 逐行解包（含 chunk 批）
 * → **只有走到最后一条**时才判定撕裂。这样"中间坏行"不会被误当成撕裂尾吞掉。
 *
 * | 情形 | 判定 | 处理 |
 * |---|---|---|
 * | 最后一条解析失败 / 尾部截断 | 撕裂 | **丢弃**该条（`tornTailDiscarded = true`），不报错 |
 * | 非最后一条不可解析 | 损坏 | `ES-CORRUPTED`——**报错，不猜** |
 * | 头部帧不可解析 | 损坏 | `ES-CORRUPTED`，提示导出抢救 |
 * | `formatVersion` 未知 | 版本 | `ES-FORMAT_UNSUPPORTED`，提示升级——**绝不尽力解析** |
 */

/** 本程序支持的 JSONL `formatVersion`（22 §4.1） */
export const SUPPORTED_FORMAT_VERSION = 1

export interface LoadedLog {
  readonly header: FileHeaderFrame
  readonly events: EventFrame[]
  /** 原始帧序列（含 chunk 批帧与头部帧），供定位/容量分析用 */
  readonly frames: LogFrame[]
  /** 与 `frames` 一一对应的原始行（不含行尾换行） */
  readonly lines: string[]
  /** 是否丢弃了撕裂的尾部记录 */
  readonly tornTailDiscarded: boolean
}

/**
 * 事件帧视图（过滤掉头部帧与 chunk 批帧）。
 *
 * 恢复（11 §6）与索引（§3.2）**只看事件帧**：头部帧按 22 §4.1 用 `kind` 而非 `type`
 * 辨识，chunk 批帧虽带 `type` 却没有 `seq`/`data`，两者都不参与闭合判定，
 * 直接把它们排除比在每个判定处写守卫更不容易漏。
 */
export function eventFramesOf(log: LoadedLog): EventFrame[] {
  return log.frames.filter(
    (frame): frame is EventFrame => !isHeaderFrame(frame) && !isChunkBatchFrame(frame),
  )
}

function corrupted(message: string, cause?: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_CORRUPTED,
    message,
    userMessage: '这个对话的记录损坏了，没法完整还原。可以试试导出已有的部分。',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })
}

function unsupported(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_FORMAT_UNSUPPORTED,
    message,
    userMessage: '这个对话是用更新版本的 Lcode 记录的，请先升级 Lcode 再打开。',
    retryable: false,
  })
}

function parseLine(line: string): unknown {
  return JSON.parse(line) as unknown
}

/**
 * 从 JSONL 文本解析出头部帧与事件序列（纯函数，无 I/O）。
 * 裁剪/损坏判定都发生在这里，便于对"人为截断"做测试。
 */
export function parseLogText(text: string): LoadedLog {
  const lines = text.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) throw corrupted('JSONL 文件为空：连头部帧都没有')

  const headerLine = lines[0]!
  let headerRaw: unknown
  try {
    headerRaw = parseLine(headerLine)
  } catch (cause) {
    throw corrupted('头部帧不可解析（22 §4.4：头部帧损坏 → ES-CORRUPTED，不做抢救式解析）', cause)
  }
  if (!isHeaderFrame(headerRaw as LogFrame)) {
    throw corrupted('JSONL 首帧不是 file-header')
  }
  const header = headerRaw as FileHeaderFrame

  if (header.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    const newer = header.formatVersion > SUPPORTED_FORMAT_VERSION
    throw unsupported(
      `JSONL formatVersion = ${header.formatVersion}，本程序只支持 ${SUPPORTED_FORMAT_VERSION}` +
        (newer ? '（日志来自更新版本）' : '（日志过旧，请先运行 lcode migrate）'),
    )
  }
  if (header.codec !== 'none' && header.codec !== 'zstd') {
    throw unsupported(`未知的日志编码：${String(header.codec)}`)
  }
  // 注意：`codec: 'zstd'` **不是**在这里解码的——解码发生在 `readLogBytes()`，
  // 那一步已经把字节还原成明文。走到这里说明拿到的已是明文，而头部帧仍如实记着
  // "这份日志是压缩归档的"（那是关于**文件**的事实，不该被读路径改写）。

  const frames: LogFrame[] = [header]
  const linesKept: string[] = [headerLine]
  let tornTailDiscarded = false

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    let parsed: unknown
    try {
      parsed = parseLine(line)
    } catch (cause) {
      if (i === lines.length - 1) {
        // 只有最后一条可以是撕裂尾（22 §4.4）
        tornTailDiscarded = true
        break
      }
      throw corrupted(`第 ${i + 1} 行不可解析，且它不是最后一条（中间行损坏 → 报错，不猜）`, cause)
    }
    if (parsed === null || typeof parsed !== 'object') {
      if (i === lines.length - 1) {
        tornTailDiscarded = true
        break
      }
      throw corrupted(`第 ${i + 1} 行不是 JSON 对象`)
    }
    frames.push(parsed as LogFrame)
    linesKept.push(line)
  }

  let events: EventFrame[]
  try {
    events = unpackFrames(frames).events
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (message.includes('seq 不连续')) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ES_SEQ_DISCONTINUOUS,
        message,
        userMessage: '这个对话的记录不连续，没法完整还原。',
        retryable: false,
        cause,
      })
    }
    throw corrupted(message, cause)
  }

  return { header, events, frames, lines: linesKept, tornTailDiscarded }
}

/**
 * 读文件字节并按需解压（22 §9.4）。
 *
 * 判定用**魔数**而不是扩展名：`.jsonl.zst` 被改名不该让加载器去按明文解析
 * （那会报一堆莫名其妙的"行解析失败"，而真正的原因是它是压缩件）。
 *
 * 导入路径（`ImportService`）复用这里的判定——它们同样只拿到路径、不知道内容。
 */
export function readLogBytes(file: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch (cause) {
    throw corrupted(`会话日志文件不可读：${file}`, cause)
  }
  if (!looksLikeZstd(bytes)) return bytes.toString('utf8')
  try {
    return new TextDecoder().decode(zstdDecompress(new Uint8Array(bytes)))
  } catch (cause) {
    // 压缩件解不开是**损坏**（或本进程没有 zstd），不是"未知格式"：
    // `zstd.ts` 在未就绪时抛的是 `ES-FORMAT_UNSUPPORTED`，这里保留它的 code。
    if (cause instanceof LcodeErrorImpl) throw cause
    throw corrupted(`会话日志是 zstd 压缩件但解压失败：${file}`, cause)
  }
}

/** 读文件 + 解析（I/O 版） */
export function loadLog(file: string): LoadedLog {
  return parseLogText(readLogBytes(file))
}

/** 读文件后顺带算出各记录的字节定位（`session_log_index` 的重建输入） */
export function loadLogWithSpans(file: string, createdAt: number): { log: LoadedLog; spans: LogRecordSpan[] } {
  const log = loadLog(file)
  return { log, spans: scanSpans(log.lines, log.frames, createdAt) }
}
