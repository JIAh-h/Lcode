import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_DIR, EXPORTS_DIR, SESSIONS_DIR, spillRoot, trashRoot } from '@lcode/util'

/**
 * 本地存储维护（22 §9.2 / §9.3；实施计划 T6.3b）。
 *
 * 三件事，都只动"可重建或已显式删除"的东西：
 *
 * | 对象 | 策略 | 依据 |
 * |---|---|---|
 * | `trash/` | 保留 **7 天**，到期硬删 | 22 §9.2 |
 * | `cache/` | 全局 **LRU，上限 2 GB**，按内容 mtime 淘汰 | 22 §9.2 |
 * | `sessions/` | **永不自动删除**（本模块绝不碰它） | 11 §1 非目标 / 22 §9.6 |
 *
 * **绝不静默删会话**是这套代码里最硬的一条：`pruneCache` 只清 `cache/`，
 * 而 `cache/` 里全是可以重算的东西（repo-map / lsp / web / spill）。
 * 空间不够时的正确行为是**提示用户**，不是替他删掉唯一不可重建的会话日志。
 */

/** `trash/` 的保留时长（22 §9.2：7 天） */
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** `cache/` 的全局上限（22 §9.2：2 GB） */
export const CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

export interface StorageUsage {
  readonly sessions: number
  readonly trash: number
  /** `cache/` 全部内容（含 spill） */
  readonly cache: number
  readonly exports: number
  /** `index.db` + `-wal` + `-shm` */
  readonly index: number
  /** 以上各项之和 */
  readonly total: number
}

export interface PruneTrashResult {
  /** 真的删掉的条目 */
  readonly removed: { readonly path: string; readonly bytes: number }[]
  readonly freedBytes: number
  /** `trash/` 里仍保留的条目数 */
  readonly kept: number
}

export interface PruneCacheResult {
  /** 被淘汰的条目（最旧的在前） */
  readonly evicted: { readonly path: string; readonly bytes: number }[]
  readonly freedBytes: number
  readonly remainingBytes: number
  /** 是否仍未降到上限以下（说明再清也清不动，调用方该提示用户） */
  readonly stillOverLimit: boolean
}

/** 目录总字节数；目录不存在返回 0。**不跟随符号链接**（避免指到别处算重） */
export function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirBytes(path)
      else if (entry.isFile()) total += statSync(path).size
    } catch {
      // 权限/竞态：跳过该条目，不因此让整次统计失败
    }
  }
  return total
}

/** 容量统计（M-DATA-04「存储占用可视化」的数据来源） */
export function storageUsage(home: string): StorageUsage {
  const sessions = dirBytes(join(home, SESSIONS_DIR))
  const trash = dirBytes(trashRoot(home))
  const cache = dirBytes(join(home, CACHE_DIR))
  const exports = dirBytes(join(home, EXPORTS_DIR))
  let index = 0
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(home, `index.db${suffix}`)
    try {
      if (existsSync(file)) index += statSync(file).size
    } catch {
      // 同上
    }
  }
  return { sessions, trash, cache, exports, index, total: sessions + trash + cache + exports + index }
}

/** 回收站条目：从文件名解析出的会话 id 与删除时刻 */
export interface TrashEntryInfo {
  readonly session_id: string
  readonly path: string
  readonly deleted_at: number
  readonly bytes: number
  /** 展示用内容标签：purge 时写的元数据，旧条目回落到日志首条用户消息 */
  readonly label: string
}

/** `purge` 时写在回收站文件旁的元数据（`<file>.meta.json`），用于展示内容而非 ID */
export interface TrashMeta {
  readonly label?: string
}

function readTrashMeta(path: string): TrashMeta {
  try {
    return JSON.parse(readFileSync(`${path}.meta.json`, 'utf8')) as TrashMeta
  } catch {
    return {}
  }
}

/**
 * 旧条目没有元数据时，从日志开头 64KB 里找第一条用户消息。
 * 只读前缀：回收站文件可能很大，列表页不该把整份日志读进内存。
 * 压缩日志读不出可读文本时返回空串（渲染层回落「未命名会话」）。
 */
function readTrashPreview(path: string): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const read = readSync(fd, buf, 0, buf.length, 0)
      if (read <= 0) return ''
      for (const line of buf.subarray(0, read).toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const frame = JSON.parse(line) as { type?: string; data?: { content?: unknown } }
          if (frame.type !== 'user/message') continue
          const content = frame.data?.content
          if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
          if (Array.isArray(content)) {
            return content
              .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null)
              .filter((block) => block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text ?? '')
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim()
          }
        } catch {
          // 撕裂尾或非 JSON 帧：跳过
        }
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // 读不了就当没有预览
  }
  return ''
}

/** 回收站文件名的命名约定（22 §2.1）：`trash/<session-id>.jsonl.<ts>` */
const TRASH_NAME = /^(.*)\.jsonl\.(\d+)$/

/**
 * 解析一条回收站条目。
 *
 * **时间以文件名里的 `deleted_at` 为准，mtime 只作兜底**——这不是吹毛求疵：
 * mtime 是墙钟，而"现在"在应用里是可注入的（测试、以及将来可能的时间旅行调试）。
 * 两者混用会让"7 天"在注入时钟下彻底失效（差出一个数量级）。
 * 文件名里的时间戳是应用自己写下的记录，与 `now` 同一坐标系。
 */
export function readTrashEntry(name: string, path: string): TrashEntryInfo | null {
  let bytes: number
  let mtimeMs: number
  try {
    const stat = statSync(path)
    bytes = stat.isDirectory() ? dirBytes(path) : stat.size
    mtimeMs = stat.mtimeMs
  } catch {
    return null
  }
  const match = TRASH_NAME.exec(name)
  const meta = readTrashMeta(path)
  const label = (meta.label ?? '').trim() !== '' ? String(meta.label).trim() : readTrashPreview(path)
  return {
    session_id: match?.[1] ?? name,
    path,
    deleted_at: match === null ? mtimeMs : Number(match[2]),
    bytes,
    label,
  }
}

/** 列出回收站条目（`listTrash` 与 `pruneTrash` 共用同一个解析） */
export function listTrashEntries(home: string): TrashEntryInfo[] {
  const root = trashRoot(home)
  if (!existsSync(root)) return []
  const out: TrashEntryInfo[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // 元数据 sidecar 不是会话条目
    if (entry.name.endsWith('.meta.json')) continue
    const parsed = readTrashEntry(entry.name, join(root, entry.name))
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * 清理到期的回收站条目（22 §9.2：7 天后硬删）。
 *
 * 判定用条目自己的 `deleted_at`（见 `readTrashEntry`），**不用 mtime**。
 */
export function pruneTrash(home: string, opts?: { readonly now?: number; readonly retentionMs?: number }): PruneTrashResult {
  const now = opts?.now ?? Date.now()
  const retention = opts?.retentionMs ?? TRASH_RETENTION_MS
  const cutoff = now - retention

  const removed: { path: string; bytes: number }[] = []
  let kept = 0
  for (const entry of listTrashEntries(home)) {
    if (entry.deleted_at > cutoff) {
      kept += 1
      continue
    }
    try {
      rmSync(entry.path, { recursive: true, force: true })
      rmSync(`${entry.path}.meta.json`, { force: true })
      removed.push({ path: entry.path, bytes: entry.bytes })
    } catch {
      kept += 1 // 删不掉（占用中）就留着，宁可多留一次也不误报
    }
  }
  return { removed, freedBytes: removed.reduce((sum, item) => sum + item.bytes, 0), kept }
}

/** `cache/` 下的顶层条目及其用量（LRU 排序的输入） */
function cacheEntries(home: string): { path: string; bytes: number; mtimeMs: number }[] {
  const root = join(home, CACHE_DIR)
  if (!existsSync(root)) return []
  const out: { path: string; bytes: number; mtimeMs: number }[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    try {
      const stat = statSync(path)
      out.push({
        path,
        bytes: entry.isDirectory() ? dirBytes(path) : stat.size,
        mtimeMs: stat.mtimeMs,
      })
    } catch {
      // 跳过读不到的条目
    }
  }
  return out
}

/**
 * 按 LRU 把 `cache/` 压到上限以下（22 §9.2：总上限 2 GB，超出时按 LRU 清）。
 *
 * **淘汰单位是 `cache/` 的顶层条目**（`repo-map` / `lsp` / `web` / `spill`），
 * 而不是单个文件——按文件淘汰会把一个大缓存目录切成"删了一半"的状态。
 * 顺序是"最久没被写过的最先走"（mtime 升序）。
 *
 * `spill/` 名义上"随所属会话删"，但它同样是可重建/可丢的派生内容（22 §2.1 把整棵
 * `cache/` 标为"可清空，绝不影响正确性"），所以在这里一视同仁地参与 LRU。
 */
export function pruneCache(
  home: string,
  opts?: { readonly limitBytes?: number },
): PruneCacheResult {
  const limit = opts?.limitBytes ?? CACHE_LIMIT_BYTES
  const entries = cacheEntries(home).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const evicted: { path: string; bytes: number }[] = []

  for (const entry of entries) {
    if (total <= limit) break
    try {
      rmSync(entry.path, { recursive: true, force: true })
      total -= entry.bytes
      evicted.push({ path: entry.path, bytes: entry.bytes })
    } catch {
      // 删不掉（占用中）：跳过，继续试下一个
    }
  }

  return {
    evicted,
    freedBytes: evicted.reduce((sum, item) => sum + item.bytes, 0),
    remainingBytes: Math.max(0, total),
    stillOverLimit: total > limit,
  }
}

/** 清空整棵 `cache/`（22 §2.1：可清空，绝不影响正确性；`lcode doctor --storage --purge-cache` 用） */
export function purgeCache(home: string): number {
  const root = join(home, CACHE_DIR)
  const bytes = dirBytes(root)
  rmSync(root, { recursive: true, force: true })
  return bytes
}

/**
 * 把文件移入回收站（22 §9.3 硬删的第一步）。
 *
 * 用 `rename` 而不是"复制再删"：同一文件系统内 rename 是原子的，
 * 于是不存在"复制到一半失败 → 源已删、目标不全"的窗口。
 */
export function moveToTrash(home: string, file: string, sessionId: string, at: number): string {
  const root = trashRoot(home)
  mkdirSync(root, { recursive: true })
  const target = join(root, `${sessionId}.jsonl.${at}`)
  renameSync(file, target)
  return target
}

/** 清空回收站（22 §9.3「清空回收站 = 立即硬删，跳过 7 天窗口」） */
export function emptyTrash(home: string): PruneTrashResult {
  const root = trashRoot(home)
  if (!existsSync(root)) return { removed: [], freedBytes: 0, kept: 0 }
  const removed: { path: string; bytes: number }[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const isMeta = entry.name.endsWith('.meta.json')
    const bytes = entry.isDirectory() ? dirBytes(path) : statSync(path).size
    rmSync(path, { recursive: true, force: true })
    // sidecar 是条目的附属文件，不单独算一项
    if (!isMeta) removed.push({ path, bytes })
  }
  return { removed, freedBytes: removed.reduce((sum, item) => sum + item.bytes, 0), kept: 0 }
}

/** 清掉某会话在 `cache/spill/` 下的条目（硬删时调用，22 §9.5） */
export function purgeSpillFor(home: string, sessionId: string): number {
  const root = spillRoot(home)
  if (!existsSync(root)) return 0
  let freed = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // spill 文件的命名约定是 `<sessionId>…`（见 09 §5 的溢出落盘）
    if (!entry.name.startsWith(sessionId)) continue
    const path = join(root, entry.name)
    try {
      freed += entry.isDirectory() ? dirBytes(path) : statSync(path).size
      rmSync(path, { recursive: true, force: true })
    } catch {
      // 删不掉就留着；硬删的主流程不该因此失败
    }
  }
  return freed
}

/** 把一份导出清单写成 `manifest.json`（22 §9.5：逐文件 SHA-256，供用户自行校验） */
export function writeManifest(dir: string, manifest: unknown): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'manifest.json')
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return path
}
