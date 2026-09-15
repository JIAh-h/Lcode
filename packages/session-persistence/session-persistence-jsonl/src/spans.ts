import type { LogFrame } from './jsonl.ts'
import { isChunkBatchFrame, isHeaderFrame } from './jsonl.ts'

/**
 * 记录级字节定位（文档 22 §3.2；实施计划 T3.2 的上游）。
 *
 * `session_log_index` 是**一记录一行**（不是一会话一行），每一行要写清
 * `byte_offset` / `byte_length`，才能让「回放到第 N 步」变成一次随机 seek，
 * 而不是从头扫文件。
 *
 * 两种产生方式必须给出**完全相同**的偏移，否则「实时写入」与「index rebuild」的结果会分叉：
 * - 实时：写入侧知道自己写了哪几行 → `spanForFrame()` 逐条累加；
 * - 重建：读文件后按行切分 → `scanSpans()` 用 `Buffer.byteLength(line) + 1`（含换行）还原。
 *
 * 二者都遵循同一条约定：**一行一帧、行尾一个 `\n`、不含 CRLF**（`encodeJsonl` 的输出形态）。
 */

export type LogRecordKind = 'header' | 'event' | 'chunk-batch'

export interface LogRecordSpan {
  readonly seq: number
  readonly seqLast: number
  readonly kind: LogRecordKind
  readonly type: string
  readonly byteOffset: number
  readonly byteLength: number
  /** 索引行写入时间（非事件时间，22 §3.2） */
  readonly createdAt: number
}

/** 头部帧不覆盖任何事件（会话内 `seq` 从 0 起，`-1` 表示"零事件"） */
export const HEADER_SEQ = -1

export const FRAME_TYPE_HEADER = 'file-header'
export const FRAME_TYPE_CHUNK_BATCH = 'assistant/chunk/batch'

/** 单条记录的定位信息 */
export function spanForFrame(frame: LogFrame, byteOffset: number, byteLength: number, createdAt: number): LogRecordSpan {
  if (isHeaderFrame(frame)) {
    return { seq: HEADER_SEQ, seqLast: HEADER_SEQ, kind: 'header', type: FRAME_TYPE_HEADER, byteOffset, byteLength, createdAt }
  }
  if (isChunkBatchFrame(frame)) {
    return {
      seq: frame.seqFirst,
      seqLast: frame.seqLast,
      kind: 'chunk-batch',
      type: FRAME_TYPE_CHUNK_BATCH,
      byteOffset,
      byteLength,
      createdAt,
    }
  }
  return { seq: frame.seq, seqLast: frame.seq, kind: 'event', type: frame.type, byteOffset, byteLength, createdAt }
}

/** 一行（含行尾换行）的字节长度 */
export function lineByteLength(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1
}

/**
 * 重建路径：从已读出的行与对应帧算出全部定位信息。
 * `lines` 与 `frames` 必须一一对应（`encodeJsonl` 保证一行一帧）。
 */
export function scanSpans(lines: readonly string[], frames: readonly LogFrame[], createdAt: number): LogRecordSpan[] {
  if (lines.length !== frames.length) {
    throw new Error(`行数与帧数不一致：${lines.length} 行 vs ${frames.length} 帧（编码契约被破坏）`)
  }
  const spans: LogRecordSpan[] = []
  let offset = 0
  for (let i = 0; i < frames.length; i++) {
    const length = lineByteLength(lines[i]!)
    spans.push(spanForFrame(frames[i]!, offset, length, createdAt))
    offset += length
  }
  return spans
}
