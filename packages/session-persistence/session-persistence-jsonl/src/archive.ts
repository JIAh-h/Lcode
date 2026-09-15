import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { LOG_EXT_ZST } from '@lcode/util'
import { writeFileAtomicSync } from './atomic.ts'
import type { LogFrame } from './jsonl.ts'
import { decodeJsonl, encodeJsonl, isHeaderFrame } from './jsonl.ts'
import { looksLikeZstd, zstdCompress } from './zstd.ts'

/**
 * 会话日志的压缩归档（文档 22 §9.4 / 11 §9.2；实施计划 T6.2）。
 *
 * | 规则 | 依据 |
 * |---|---|
 * | 空闲 ≥ 30 天 → `.jsonl` 转 `.jsonl.zst` | 22 §9.2 |
 * | **先打包（chunk 批）再整体 zstd** | 11 §未决问题（已定倾向） |
 * | 一文件一 `codec`，**不** per-record 混用 | 同上 |
 * | 走**原子物化**（tmp → fsync → rename） | 22 §4.3 |
 * | 开放中的会话**永不压缩** | 22 §9.2 |
 *
 * **压缩是"整文件重写"，所以必须原子的**：压缩途中崩溃留下一个半截 `.zst` 会被
 * 当成损坏归档——比不压缩严重得多（那是用户唯一不可重建的数据）。
 *
 * **压缩不清除原始文件直到新文件已落盘**：顺序是"写 `.zst` → fsync → 删 `.jsonl`"，
 * 任一步失败都还能退回未压缩形态。
 */

/** `.jsonl` → `.jsonl.zst` 的内容变换（纯函数） */
export function compressLogText(text: string): Uint8Array {
  return zstdCompress(new TextEncoder().encode(text))
}

/** `.jsonl.zst` → `.jsonl` 的内容变换（纯函数） */
export function decompressLogBytes(bytes: Uint8Array, decompress: (input: Uint8Array) => Uint8Array): string {
  return new TextDecoder().decode(decompress(bytes))
}

/** `.jsonl` → `.jsonl.zst` 的路径变换（22 §2.1 的命名约定：在原文件名后加 `.zst`） */
export function archivedPathOf(jsonlPath: string): string {
  return `${jsonlPath}.zst`
}

/**
 * `.jsonl.zst` → `.jsonl` 的路径变换。
 *
 * 注意是去掉 **`.zst`** 而不是 `.jsonl.zst`——归档件是在原文件名后**追加** `.zst`，
 * 所以 `a.jsonl.zst` 的还原目标是 `a.jsonl`（不是 `a`）。
 */
export function restoredPathOf(archivedPath: string): string {
  return archivedPath.endsWith(LOG_EXT_ZST) ? archivedPath.slice(0, -'.zst'.length) : archivedPath
}

export interface ArchiveResult {
  /** 归档后的文件路径（`.jsonl.zst`） */
  readonly path: string
  readonly compressedBytes: number
  /** 压缩前的原始字节数 */
  readonly originalBytes: number
  /** 压缩比 `original / compressed` */
  readonly ratio: number
}

/**
 * 把一个 `.jsonl` 归档为 `.jsonl.zst`（22 §9.4）。
 *
 * `frames` 是**已打包**的帧序列（调用方负责先做 chunk 打包；压缩本身不碰语义）。
 * 这里不读原文件、只写新文件，是为了让"打包 + 压缩"共用同一份内存表示——
 * 只有一条数据路径，就不会出现"打包形态与压缩输入不一致"。
 */
export function archiveLogFile(jsonlPath: string, frames: readonly LogFrame[]): ArchiveResult {
  const text = encodeJsonl(frames)
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const packed = compressLogText(text)
  const target = archivedPathOf(jsonlPath)

  // 原子物化：写 `.zst` 成功后才删 `.jsonl`。反过来会让中途失败变成"两边都不完整"
  writeFileAtomicSync(target, packed)
  if (existsSync(jsonlPath)) unlinkSync(jsonlPath)

  return {
    path: target,
    compressedBytes: packed.length,
    originalBytes,
    ratio: packed.length === 0 ? 0 : originalBytes / packed.length,
  }
}

export interface RestoreResult {
  /** 还原后的文件路径（`.jsonl`） */
  readonly path: string
  readonly bytes: number
  readonly frames: LogFrame[]
}

/**
 * 把 `.jsonl.zst` 还原回 `.jsonl`（22 §9.2「会话被 resume 时先解压回 `.jsonl`」）。
 *
 * **这是压缩的逆**，两者配对使用：`archiveLogFile(restoreLogFile(f).path, f.frames)`
 * 应当得到与原来等价的文件。测试里就按这条不变量验。
 */
export function restoreLogFile(archivedPath: string, decompress: (input: Uint8Array) => Uint8Array): RestoreResult {
  const bytes = readFileSync(archivedPath)
  if (!looksLikeZstd(bytes)) {
    throw new Error(`${archivedPath} 不是 zstd 帧（魔数不符）——拒绝按压缩件解压`)
  }
  const text = decompressLogBytes(bytes, decompress)
  const frames = decodeJsonl(text)
  if (frames.length === 0 || !isHeaderFrame(frames[0]!)) {
    throw new Error(`${archivedPath} 解压后首帧不是 file-header（22 §4.1）`)
  }
  const target = restoredPathOf(archivedPath)
  writeFileAtomicSync(target, text)
  unlinkSync(archivedPath)
  return { path: target, bytes: Buffer.byteLength(text, 'utf8'), frames }
}
