import type { StreamChunk } from '@lcode/session'
import type { JsonValue } from '@lcode/util'
import { assertLosslessJson, serializeLossless } from '@lcode/util'

/**
 * JSONL 物理编码的帧类型（文档 22 §4）。
 * 第 0 帧是头部帧；其后是事件帧或 chunk 批帧。
 */

/** 头部帧（22 §4.1） */
export interface FileHeaderFrame {
  readonly kind: 'file-header'
  readonly formatVersion: number
  readonly sessionId: string
  readonly createdAt: number
  /** 工作区根（无 cwd 的会话为 null，落 `_unknown/` 桶，22 §2.1） */
  readonly cwd: string | null
  readonly parentSession: string | null
  readonly seedLength: number
  /** 与 `sessions.log_codec` 的 CHECK 对齐（22 §3.1 / §3.13） */
  readonly codec: 'none' | 'zstd'
  readonly keyId: string | null
}

/** 事件帧（22 §4.1：seq/time/data/surfaceOp/sourceEventSeqs/ignorable） */
export interface EventFrame {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number }
  readonly sourceEventSeqs?: readonly number[]
  readonly ignorable?: boolean
}

/** chunk 批帧（22 §4.2：极大连续 chunk 段打包为一条记录） */
export interface ChunkBatchFrame {
  readonly type: 'assistant/chunk/batch'
  readonly seqFirst: number
  readonly seqLast: number
  readonly time: number
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly chunks: readonly { readonly dt: number; readonly c: StreamChunk }[]
  }
}

export type LogFrame = FileHeaderFrame | EventFrame | ChunkBatchFrame

/** 打包参数（22 §4.2） */
export const CHUNK_BATCH_MAX_LENGTH = 4096 as const

/**
 * 把连续 chunk 段打包为批帧；非 chunk 事件原样保留。
 * 纯函数：解包后与逐条写入完全一致（还原时 seq = seqFirst + i）。
 */
export function packFrames(header: FileHeaderFrame, events: readonly EventFrame[]): LogFrame[] {
  const out: LogFrame[] = [header]
  let i = 0
  while (i < events.length) {
    const ev = events[i]!
    if (ev.type !== 'assistant/chunk') {
      out.push(ev)
      i++
      continue
    }
    // 收集极大连续 chunk 段
    const run: EventFrame[] = [ev]
    let j = i + 1
    while (
      j < events.length &&
      events[j]!.type === 'assistant/chunk' &&
      run.length < CHUNK_BATCH_MAX_LENGTH
    ) {
      run.push(events[j]!)
      j++
    }
    // 只打包极大段（≥2 条才有收益；1 条按普通事件保留）
    if (run.length < 2) {
      out.push(ev)
      i = j
      continue
    }
    const first = run[0]!
    const last = run[run.length - 1]!
    const firstData = first.data as { turn: number; step: number; chunk: StreamChunk }
    const turn = firstData.turn
    const step = firstData.step
    const batch: ChunkBatchFrame = {
      type: 'assistant/chunk/batch',
      seqFirst: first.seq,
      seqLast: last.seq,
      time: first.time,
      data: {
        turn,
        step,
        chunks: run.map((r) => {
          const d = r.data as { turn: number; step: number; chunk: StreamChunk }
          return { dt: r.time - first.time, c: d.chunk }
        }),
      },
    }
    out.push(batch)
    i = j
  }
  return out
}

/**
 * 帧类型判定。
 * `LogFrame` 是联合，但**无法用单个字段辨识**：头部帧按 22 §4.1 用 `kind`，
 * 而事件帧 / 批帧用 `type`。因此提供两个显式守卫，避免调用处到处写断言。
 */
export function isHeaderFrame(frame: LogFrame): frame is FileHeaderFrame {
  return (frame as { kind?: string }).kind === 'file-header'
}

export function isChunkBatchFrame(frame: LogFrame): frame is ChunkBatchFrame {
  return (frame as { type?: string }).type === 'assistant/chunk/batch'
}

/** 解包：把批帧还原为逐条事件帧（纯函数，seq 重新连续） */
export function unpackFrames(frames: readonly LogFrame[]): { header: FileHeaderFrame; events: EventFrame[] } {
  const header = frames[0]
  if (!header || !isHeaderFrame(header)) {
    throw new Error('JSONL 首帧必须是 file-header（22 §4.1）')
  }
  const events: EventFrame[] = []
  for (let f = 1; f < frames.length; f++) {
    const frame = frames[f]!
    if (isChunkBatchFrame(frame)) {
      const batch = frame
      // 批帧必须自洽：seqLast 是 seqFirst + 条数 - 1。
      // 少了这一条校验，"批帧声称覆盖 0..9 但只剩 3 条"（尾部被截断）会被静默解包成
      // 一个 seq 恰好连续的短序列——损坏被吞掉，正是 22 §4.4 禁止的"猜"。
      const expectedLast = batch.seqFirst + batch.data.chunks.length - 1
      if (batch.seqLast !== expectedLast) {
        throw new Error(
          `chunk 批帧跨度与条数不符：声称 ${batch.seqFirst}..${batch.seqLast}，实际只有 ${batch.data.chunks.length} 条（编码损坏）`,
        )
      }
      let seq = batch.seqFirst
      for (const item of batch.data.chunks) {
        events.push({
          type: 'assistant/chunk',
          seq,
          time: batch.time + item.dt,
          data: { turn: batch.data.turn, step: batch.data.step, chunk: item.c },
        })
        seq++
      }
    } else {
      events.push(frame as EventFrame)
    }
  }
  // I2 校验：解包后 seq 必须连续
  for (let s = 0; s < events.length; s++) {
    if (events[s]!.seq !== s) {
      throw new Error(`seq 不连续（I2 违规）：期望 ${s}，实际 ${events[s]!.seq}`)
    }
  }
  return { header, events }
}

/** 把帧序列化为 JSONL 文本（每行一帧；写入前校验无损，I5） */
export function encodeJsonl(frames: readonly LogFrame[]): string {
  return frames.map((f) => serializeLossless(assertFrame(f))).join('\n') + '\n'
}

/** 从 JSONL 文本解析帧（逐行；行级解析失败抛出，由调用方按撕裂/损坏规则处理，22 §4.4） */
export function decodeJsonl(text: string): LogFrame[] {
  if (text.length === 0) return []
  const lines = text.split('\n').filter((l) => l.length > 0)
  return lines.map((line) => {
    try {
      return JSON.parse(line) as LogFrame
    } catch {
      throw new Error(`JSONL 行解析失败（22 §4.4：最后一条为撕裂可丢弃，其余为损坏）`)
    }
  })
}

/**
 * 写入前的无损校验收口。
 * 断言成 `JsonValue` 是**边界转换**：`LogFrame` 的成员都是 interface，
 * 而 TS 的 interface 不带隐式索引签名，无法直接赋给 `JsonValue`。
 * 真正的运行时保障是紧随其后的 `assertLosslessJson`（拒绝 BigInt/NaN/循环引用，I5）。
 */
function assertFrame(frame: LogFrame): JsonValue {
  const value = frame as unknown as JsonValue
  assertLosslessJson(value)
  return value
}
