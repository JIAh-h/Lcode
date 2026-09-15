import { statSync } from 'node:fs'
import type { ArchiveResult } from './archive.ts'
import { archiveLogFile } from './archive.ts'
import { packFrames } from './jsonl.ts'
import { loadLog } from './loader.ts'
import { listSessionFiles } from './session-store.ts'
import { zstdReady } from './zstd.ts'

/**
 * 保留策略：空闲会话的压缩归档（文档 22 §9.2 / 11 §9.2；实施计划 T6.2）。
 *
 * | 规则 | 依据 |
 * |---|---|
 * | 空闲 ≥ **30 天** → `.jsonl` → `.jsonl.zst` | 22 §9.2 |
 * | **开放中**的会话**永不压缩** | 22 §9.2 |
 * | **绝不自动删除**会话 | 11 §1 非目标 / 22 §9.6 |
 * | 压缩后 `load()` 仍能还原（透明解压） | 验收判据 |
 *
 * **"空闲"的口径**：以文件 `mtime` 为准，而不是 `sessions.updated_at`。
 * 理由：`updated_at` 是索引里的派生值、可能落后或缺失，而"这个文件最近有没有被写"
 * 是文件系统的事实。索引可以被删掉重建，保留策略不该依赖它。
 *
 * **"开放中"的口径**：调用方通过 `openSessionIds` 告知。压缩一个正在被追加的文件
 * 会直接破坏它（`.jsonl` 被删、后续 append 写到不存在的路径）。
 */

/** 空闲多久算"可以归档"（22 §9.2：30 天） */
export const ARCHIVE_IDLE_MS = 30 * 24 * 60 * 60 * 1000

export interface RetentionOptions {
  readonly home: string
  /** 当前**打开中**的会话 id——它们永不压缩（22 §9.2） */
  readonly openSessionIds?: readonly string[] | undefined
  /** 空闲阈值，默认 30 天 */
  readonly idleMs?: number | undefined
  /** 现在（可注入，便于测试） */
  readonly now?: number | undefined
  /** 只处理这一个会话 */
  readonly sessionId?: string | undefined
  /** 真跑还是只报告（`--check`） */
  readonly dryRun?: boolean | undefined
}

export interface ArchivedEntry {
  readonly sessionId: string
  readonly file: string
  readonly archivedPath: string
  readonly originalBytes: number
  readonly compressedBytes: number
  readonly ratio: number
}

export interface RetentionReport {
  /** 扫描到的**未归档**会话数（已归档的不参与） */
  readonly scanned: number
  /** 真的归档了多少个（`dryRun` 下是"将会归档"的个数） */
  readonly archived: readonly ArchivedEntry[]
  /** 因空闲时间不够而跳过 */
  readonly skippedIdle: number
  /** 因**正在打开**而跳过（22 §9.2：开放中的会话永不压缩） */
  readonly skippedOpen: number
  /** 归档失败（读取/写入错误），不中断整轮 */
  readonly failed: readonly { readonly sessionId: string; readonly message: string }[]
  /** zstd 是否可用；false 时 `archived` 必为空且 `failed` 记一条说明 */
  readonly zstdAvailable: boolean
}

export function applyRetention(opts: RetentionOptions): RetentionReport {
  const now = opts.now ?? Date.now()
  const idleMs = opts.idleMs ?? ARCHIVE_IDLE_MS
  const open = new Set(opts.openSessionIds ?? [])
  const dryRun = opts.dryRun === true

  const candidates = listSessionFiles(opts.home).filter(
    (entry) => entry.state === 'live' && (opts.sessionId === undefined || entry.sessionId === opts.sessionId),
  )

  const archived: ArchivedEntry[] = []
  const failed: { sessionId: string; message: string }[] = []
  let skippedIdle = 0
  let skippedOpen = 0

  // 没有 zstd 就别装模作样地扫一遍：明确报"这次没压成"（可路由的失败，不是静默跳过）
  if (!zstdReady()) {
    return {
      scanned: candidates.length,
      archived: [],
      skippedIdle: 0,
      skippedOpen: 0,
      zstdAvailable: false,
      failed: [
        {
          sessionId: '*',
          message:
            'zstd 未就绪：压缩归档需要先调用 initZstd()（装配层启动时做）——本轮未归档任何会话。',
        },
      ],
    }
  }

  for (const entry of candidates) {
    if (open.has(entry.sessionId)) {
      skippedOpen += 1
      continue
    }
    let mtimeMs: number
    try {
      mtimeMs = statSync(entry.file).mtimeMs
    } catch {
      continue // 竞态：文件刚被删，跳过
    }
    if (now - mtimeMs < idleMs) {
      skippedIdle += 1
      continue
    }

    try {
      // 归档前**必须**读出完整日志并重新打包：压缩的输入是"打包后的帧序列"，
      // 而磁盘上可能是上次写的逐条形态。走 loadLog 能顺带做一次完整性校验——
      // 压缩一个读不出来的文件，等于把"损坏可发现"变成"损坏被封进归档"。
      const loaded = loadLog(entry.file)
      const frames = packFrames(loaded.header, loaded.events)
      if (dryRun) {
        const before = statSync(entry.file).size
        archived.push({
          sessionId: entry.sessionId,
          file: entry.file,
          archivedPath: `${entry.file}.zst`,
          originalBytes: before,
          compressedBytes: 0, // dryRun 不压缩，故无真实数字
          ratio: 0,
        })
        continue
      }
      const result: ArchiveResult = archiveLogFile(entry.file, frames)
      archived.push({
        sessionId: entry.sessionId,
        file: entry.file,
        archivedPath: result.path,
        originalBytes: result.originalBytes,
        compressedBytes: result.compressedBytes,
        ratio: result.ratio,
      })
    } catch (err) {
      failed.push({ sessionId: entry.sessionId, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { scanned: candidates.length, archived, skippedIdle, skippedOpen, failed, zstdAvailable: true }
}
