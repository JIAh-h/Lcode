import { statSync } from 'node:fs'
import { computeRevision, listSessionFiles, loadLogWithSpans } from '@lcode/session-persistence-jsonl'
import { isLcodeError, normalizePath, nowEpochMs } from '@lcode/util'
import { closeIndexDb, openIndexDb } from './db.ts'
import { SCHEMA_VERSION } from './ddl.ts'
import { applyProjection, projectSession } from './project.ts'
import { createEmptyIndexDb, dropIndexDb } from './rebuild.ts'

/**
 * `lcode index rebuild`（文档 22 §1.3；实施计划 T3.6）。
 *
 * **只丢弃单会话，其余照常**（22 §1.3）：某个会话日志损坏 → 记 `ES-CORRUPTED` 并跳过，
 * 不影响其它会话；**两条错误路径绝不猜**——结构损坏报 `ES-CORRUPTED`、
 * 版本未知报 `ES-FORMAT_UNSUPPORTED`，都不做"尽力解析"。
 *
 * 重建**不做**的三件事（22 §1.3）：① 不修补损坏日志（修补属 `load()` 路径）；
 * ② 不从 SQLite 反推 JSONL（反向不成立）；③ 不对未知 `formatVersion` 尽力解析。
 *
 * 因为投影与实时写入共用 `projectSession()`，"删库重建后逐行一致"是构造性结果。
 */

export interface RebuildOptions {
  readonly home: string
  /** 只重建一个会话 */
  readonly sessionId?: string | undefined
  /** 只重建某个工作区（按头部帧的 cwd 匹配） */
  readonly workspace?: string | undefined
  /** 只体检：只扫描与报告可读性，**不删库、不写库** */
  readonly check?: boolean | undefined
  readonly now?: (() => number) | undefined
}

export interface SkippedSession {
  readonly sessionId: string
  readonly file: string
  /** 结构化错误的 code；非结构化错误为 null */
  readonly code: string | null
  readonly message: string
}

export interface RebuildReport {
  /** 扫描到的会话文件数 */
  readonly scanned: number
  /** 成功重建（或 `--check` 下判定可读）的会话数 */
  readonly rebuilt: number
  readonly skipped: readonly SkippedSession[]
  readonly schemaVersion: number
  /** 按 `--workspace` 过滤掉、且未计入 `scanned` 之外的会话数 */
  readonly filteredOut: number
}

function describeError(err: unknown): { code: string | null; message: string } {
  if (isLcodeError(err)) return { code: err.code, message: err.message }
  return { code: null, message: err instanceof Error ? err.message : String(err) }
}

export function rebuildIndex(opts: RebuildOptions): RebuildReport {
  const now = opts.now ?? ((): number => nowEpochMs())
  const wantedWorkspace = opts.workspace === undefined ? null : normalizePath(opts.workspace)

  const candidates = listSessionFiles(opts.home).filter(
    (entry) => opts.sessionId === undefined || entry.sessionId === opts.sessionId,
  )

  // 全量重建先删库：删掉 index.db 永远安全（22 §1.1 硬性推论③）
  // `--check` 是**只体检**：既不删库也不写库，连连接都不开（库可能根本不存在）
  if (opts.check === true) {
    return checkOnly(candidates, wantedWorkspace)
  }
  // 删库前先把**只存在索引里的用户元数据**抢救下来——`title` 不在 JSONL 里（22 §3.1/§4.1），
  // 不先存一份就会被连库一起删掉、"重建后标题全没了"。这与"删库永远安全"不矛盾：
  // 那条说的是**派生数据**可丢，而 title 是用户输入、不是派生物。
  const userMeta = opts.sessionId === undefined ? readUserMetadata(opts.home) : readUserMetadata(opts.home, opts.sessionId)

  closeIndexDb(opts.home)
  dropIndexDb(opts.home)
  createEmptyIndexDb(opts.home)
  const db = openIndexDb({ home: opts.home })

  const skipped: SkippedSession[] = []
  let scanned = 0
  let rebuilt = 0
  let filteredOut = 0

  for (const entry of candidates) {
    scanned += 1
    try {
      const indexedAt = now()
      const { log, spans } = loadLogWithSpans(entry.file, indexedAt)
      if (wantedWorkspace !== null && normalizePath(log.header.cwd ?? '') !== wantedWorkspace) {
        filteredOut += 1
        continue
      }
      const saved = userMeta.get(entry.sessionId)
      applyProjection(
        db,
        projectSession({
          sessionId: entry.sessionId,
          header: log.header,
          events: log.events,
          spans,
          revision: computeRevision(entry.file).revision,
          bytes: statSync(entry.file).size,
          indexedAt,
          ...(saved?.title === undefined || saved.title === '' ? {} : { title: saved.title }),
        }),
      )
      rebuilt += 1
    } catch (err) {
      const { code, message } = describeError(err)
      skipped.push({ sessionId: entry.sessionId, file: entry.file, code, message })
    }
  }

  // 回填软删/归档标记（也不在 JSONL 里）。只回填"仍然存在的会话"——被删掉的条目不该复活。
  const restoreMeta = db.prepare('UPDATE sessions SET deleted_at = ?, archived_at = ? WHERE session_id = ?')
  const backfill = db.transaction((entries: readonly (readonly [string, { deletedAt: number | null; archivedAt: number | null }])[]) => {
    for (const [sessionId, meta] of entries) {
      if (meta.deletedAt !== null || meta.archivedAt !== null) {
        restoreMeta.run(meta.deletedAt, meta.archivedAt, sessionId)
      }
    }
  })
  backfill([...userMeta.entries()])

  if (rebuilt > 0) {
    // 22 §1.3：重建收尾做一次 VACUUM + ANALYZE（索引可丢，体积与统计值得收拾）
    db.exec('VACUUM')
    db.exec('ANALYZE')
  }

  return { scanned, rebuilt, skipped, schemaVersion: SCHEMA_VERSION, filteredOut }
}

interface SavedUserMetadata {
  readonly title: string
  readonly deletedAt: number | null
  readonly archivedAt: number | null
}

/**
 * 读出索引里**只存在于索引**的用户元数据（22 §3.1）。
 *
 * 目前是三项：`title`（用户命名）、`deleted_at`（软删）、`archived_at`（压缩归档时间）。
 * 它们都不在 JSONL 的头部帧里，所以"删库 → 重建"会丢——必须在删库前存一份。
 *
 * 库不存在或读不动时返回空表（**不抛**）：重建的意义正是让坏索引重新可用，
 * 不该因为"抢救元数据失败"而整条命令失败。
 */
function readUserMetadata(home: string, sessionId?: string): Map<string, SavedUserMetadata> {
  const out = new Map<string, SavedUserMetadata>()
  let db: ReturnType<typeof openIndexDb>
  try {
    db = openIndexDb({ home })
  } catch {
    return out
  }
  try {
    const sql =
      'SELECT session_id, title, deleted_at, archived_at FROM sessions' +
      (sessionId === undefined ? '' : ' WHERE session_id = ?')
    const rows = (sessionId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(sessionId)) as {
      session_id: string
      title: string | null
      deleted_at: number | null
      archived_at: number | null
    }[]
    for (const row of rows) {
      out.set(row.session_id, {
        title: row.title ?? '',
        deletedAt: row.deleted_at,
        archivedAt: row.archived_at,
      })
    }
  } catch {
    // 表结构缺失/损坏：当作"没抢救到"，让重建继续
  }
  return out
}

/** `--check`：只读扫描，报告哪些可读、哪些损坏或版本未知；不碰索引库 */
function checkOnly(
  candidates: readonly { sessionId: string; file: string }[],
  wantedWorkspace: string | null,
): RebuildReport {
  const skipped: SkippedSession[] = []
  let scanned = 0
  let readable = 0
  let filteredOut = 0
  for (const entry of candidates) {
    scanned += 1
    try {
      const loaded = loadLogWithSpans(entry.file, 0)
      if (wantedWorkspace !== null && normalizePath(loaded.log.header.cwd ?? '') !== wantedWorkspace) {
        filteredOut += 1
        continue
      }
      readable += 1
    } catch (err) {
      const { code, message } = describeError(err)
      skipped.push({ sessionId: entry.sessionId, file: entry.file, code, message })
    }
  }
  return { scanned, rebuilt: readable, skipped, schemaVersion: SCHEMA_VERSION, filteredOut }
}
