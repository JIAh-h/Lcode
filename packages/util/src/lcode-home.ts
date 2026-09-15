/**
 * Lcode Home 与路径解析（文档 22 §2 / §7.3；实施计划 T0.2）。
 *
 * **本模块只做纯字符串工作**——不 import `node:fs` / `node:path` / `node:crypto`。
 * 原因：`@lcode/util` 是全仓基础层，被各层（含未来的渲染层）依赖，必须保持可移植；
 * 目录创建与文件读写属于具体持久化实现包（`session-persistence-jsonl` / `-sqlite`）。
 * 需要哈希时用自带的 FNV-1a 64（纯 JS，无依赖）——桶名只要稳定 + 低碰撞，不需要密码学强度。
 */

/** 覆盖 Lcode Home 的环境变量名（22 §2.2：**必须**可覆盖，CI 与测试依赖这一点） */
export const LCODE_HOME_ENV = 'LCODE_HOME'

/** 无 cwd 的会话所落的桶名（22 §2.1） */
export const WORKSPACE_BUCKET_UNKNOWN = '_unknown'

/** Lcode Home 下的标准子路径（22 §2.1） */
export const SESSIONS_DIR = 'sessions'
export const INDEX_DB_FILE = 'index.db'
export const LOG_EXT = '.jsonl'
export const LOG_EXT_ZST = '.jsonl.zst'
/** 软删暂存区（22 §2.1：`trash/<session-id>.jsonl.<ts>`，保留 7 天后硬删） */
export const TRASH_DIR = 'trash'
/** 导出产物目录（`sessions.export` / `sessions.exportAll` 的默认落点） */
export const EXPORTS_DIR = 'exports'
/** 一切可重建、可清空的派生数据（22 §2.1） */
export const CACHE_DIR = 'cache'
/** 超大工具结果的落盘内容（22 §2.1；硬删会话时一并清除） */
export const SPILL_DIR = 'spill'

function processEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && typeof process.env === 'object' && process.env !== null
    ? (process.env as Record<string, string | undefined>)
    : {}
}

/**
 * 路径规范化（22 §7.3）。
 *
 * - 分隔符统一为 `/`（Windows 的 `\` 在入库前转换）
 * - 折叠重复斜杠；去掉末尾斜杠（保留 POSIX `/` 与盘根 `C:/`）
 * - 保留 UNC 前导 `//`
 * - **不对大小写做统一**：macOS/Windows 不敏感而 Linux 敏感，统一小写会破坏 Linux（22 §7.3）
 */
export function normalizePath(input: string): string {
  if (input === '') return ''
  const unc = /^[\\/]{2}[^\\/]/.test(input)
  let p = input.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (unc) p = '/' + p
  if (p.length > 1 && p.endsWith('/')) {
    const stripped = p.replace(/\/+$/g, '')
    // 盘根（'C:/'）与 POSIX 根（'/'）的末尾斜杠要保留；
    // 注意驱动器相对路径 'C:' 不在此列——它不是绝对路径，不做臆造补斜杠（22 §7.3 要求入库为绝对路径）
    p = stripped === '' ? '/' : /^[A-Za-z]:$/.test(stripped) ? stripped + '/' : stripped
  }
  return p
}

/**
 * 解析 Lcode Home（22 §2.2）。
 *
 * 顺序：`LCODE_HOME` → 平台家目录 + `/.lcode`。
 * 路径**不含版本号**，跨版本稳定。取不到家目录时**显式报错**（不猜），
 * 因为静默落到别处会让用户数据"看起来丢了"。
 */
export function resolveLcodeHome(env: Record<string, string | undefined> = processEnv()): string {
  const override = env[LCODE_HOME_ENV]
  if (typeof override === 'string' && override.trim() !== '') {
    return normalizePath(override.trim())
  }
  // Windows 用 USERPROFILE，POSIX 用 HOME（不 import node:os，保持可移植）
  const homeRaw = env['HOME'] ?? env['USERPROFILE']
  if (typeof homeRaw === 'string' && homeRaw.trim() !== '') {
    return normalizePath(homeRaw.trim()) + '/.lcode'
  }
  throw new Error(`无法确定 Lcode Home：请设置环境变量 ${LCODE_HOME_ENV}（22 §2.2）`)
}

const FNV_OFFSET_64 = 0xcbf29ce484222325n
const FNV_PRIME_64 = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/** FNV-1a（64 位）→ 16 位小写十六进制 */
export function fnv1a64Hex(text: string): string {
  let hash = FNV_OFFSET_64
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * FNV_PRIME_64) & MASK_64
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * workspace-key = 规范化 cwd 的 16 hex 短哈希（22 §2.1）。
 * 无 cwd（或空串）→ `_unknown`（22 §2.1 的兜底桶）。
 */
export function workspaceBucket(cwd: string | null | undefined): string {
  if (cwd === null || cwd === undefined) return WORKSPACE_BUCKET_UNKNOWN
  const normalized = normalizePath(cwd)
  if (normalized === '') return WORKSPACE_BUCKET_UNKNOWN
  return fnv1a64Hex(normalized)
}

/** `<home>/sessions` */
export function sessionsRoot(home: string): string {
  return normalizePath(home) + '/' + SESSIONS_DIR
}

/** `<home>/index.db` */
export function indexDbPath(home: string): string {
  return normalizePath(home) + '/' + INDEX_DB_FILE
}

/** `<home>/trash` —— 软删暂存区（22 §2.1） */
export function trashRoot(home: string): string {
  return normalizePath(home) + '/' + TRASH_DIR
}

/** `<home>/exports` —— 导出产物默认落点 */
export function exportsRoot(home: string): string {
  return normalizePath(home) + '/' + EXPORTS_DIR
}

/** `<home>/cache/spill` —— 会话关联的溢出内容（硬删时一并清） */
export function spillRoot(home: string): string {
  return normalizePath(home) + '/' + CACHE_DIR + '/' + SPILL_DIR
}

/**
 * 会话日志相对 Lcode Home 的路径（22 §7.3：`log_path` 存**相对**路径，便于整体迁移）。
 * 形如 `sessions/<workspace-key>/<session-id>.jsonl`。
 */
export function sessionLogRelPath(cwd: string | null | undefined, sessionId: string): string {
  return `${SESSIONS_DIR}/${workspaceBucket(cwd)}/${sessionId}${LOG_EXT}`
}

/** 相对 Lcode Home 的路径 → 绝对路径 */
export function absFromHome(home: string, relPath: string): string {
  return normalizePath(normalizePath(home) + '/' + relPath)
}

/** 绝对路径 → 相对 Lcode Home 的路径；不在 Home 之下返回 null */
export function relativeToHome(home: string, absPath: string): string | null {
  const h = normalizePath(home)
  const a = normalizePath(absPath)
  if (a === h) return ''
  const prefix = h.endsWith('/') ? h : h + '/'
  return a.startsWith(prefix) ? a.slice(prefix.length) : null
}
