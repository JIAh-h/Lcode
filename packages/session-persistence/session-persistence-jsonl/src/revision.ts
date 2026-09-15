import { statSync } from 'node:fs'

/**
 * `revision` —— 廉价变更检测令牌（文档 22 §4.3；实施计划 T2.4）。
 *
 * `revision = ${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`
 *
 * - 在 Windows 上 Node 的 `ino` 由 `GetFileInformationByHandle` 的 `fileIndex` 填充，
 *   因此同一个表达式在三平台都成立，不需要分支。
 * - **不是内容哈希、不用于完整性校验**（导出/迁移另算 SHA-256，22 §9.5）。
 *   用途只有一个：`sessions.log_revision` 与真实文件比对，不一致即增量重索引；
 *   也是 `ES-LOG_MODIFIED_EXTERNALLY` 的判据。
 * - 时间戳精度不足时**记录实际精度**（`precision`），别假装是纳秒。
 */

export interface FileRevision {
  readonly revision: string
  readonly size: number
  /** 实际可用的时间戳精度：'ns' 有亚毫秒位，'ms' 只能到毫秒 */
  readonly precision: 'ns' | 'ms'
}

const NS_PER_MS = 1_000_000n

export function computeRevision(file: string): FileRevision {
  const st = statSync(file, { bigint: true })
  const revision = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  const precision: 'ns' | 'ms' = st.mtimeNs % NS_PER_MS === 0n ? 'ms' : 'ns'
  return { revision, size: Number(st.size), precision }
}

/** 文件当前字节数；不存在返回 null（不抛错——调用方多做"缺失即视为不一致"） */
export function fileBytes(file: string): number | null {
  try {
    return statSync(file).size
  } catch {
    return null
  }
}
