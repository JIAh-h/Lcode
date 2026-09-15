// ── 物理编码（22 §4.1/§4.2） ──
export type { FileHeaderFrame, EventFrame, ChunkBatchFrame, LogFrame } from './jsonl.ts'
export {
  CHUNK_BATCH_MAX_LENGTH,
  packFrames,
  unpackFrames,
  encodeJsonl,
  decodeJsonl,
  isHeaderFrame,
  isChunkBatchFrame,
} from './jsonl.ts'

// ── 原子物化 / 持久追加（22 §4.3；T2.3） ──
export { appendFileSyncDurable, writeFileAtomicSync } from './atomic.ts'

// ── revision（22 §4.3；T2.4） ──
export { computeRevision, fileBytes } from './revision.ts'
export type { FileRevision } from './revision.ts'

// ── 记录级字节定位（22 §3.2；T3.2 的上游） ──
export {
  HEADER_SEQ,
  FRAME_TYPE_HEADER,
  FRAME_TYPE_CHUNK_BATCH,
  lineByteLength,
  scanSpans,
  spanForFrame,
} from './spans.ts'
export type { LogRecordKind, LogRecordSpan } from './spans.ts'

// ── 读取与损坏判定（22 §4.4；T2.2） ──
export { loadLog, loadLogWithSpans, parseLogText, readLogBytes, SUPPORTED_FORMAT_VERSION, eventFramesOf } from './loader.ts'
export type { LoadedLog } from './loader.ts'

// ── 有界批写（11 §5.4；T2.1） ──
export { SessionWriteBehind } from './write-behind.ts'
export type { WriteBehindOptions } from './write-behind.ts'

// ── 索引侧接收口（阶段 3 的接线点） ──
export type { SessionIndexSink, SessionLogSnapshot } from './sink.ts'

// ── 崩溃恢复（11 §6 / 06 §9；T6.1） ──
export {
  ABORTED_BEFORE_DISPATCH,
  ABORTED_RESULT_TEXT,
  ABORTED_TURN_REASON,
  MAX_REPAIR_GAP_MS,
  RECOVERY_REPAIRED,
  appendClosers,
  findOpenStructures,
  framesToEvents,
  planRecovery,
  synthesizeClosers,
} from './recovery.ts'
export type { OpenStructures, RecoveryResult, UnpairedToolCall } from './recovery.ts'

// ── zstd 压缩（22 §9.4；T6.2） ──
export {
  DEFAULT_ZSTD_LEVEL,
  ensureZstdReadySync,
  initZstd,
  looksLikeZstd,
  setZstdForTest,
  zstdCompress,
  zstdDecompress,
  zstdReady,
} from './zstd.ts'
export type { ZstdImpl } from './zstd.ts'

// ── 压缩归档（22 §9.4；T6.2） ──
export {
  archiveLogFile,
  archivedPathOf,
  compressLogText,
  decompressLogBytes,
  restoreLogFile,
  restoredPathOf,
} from './archive.ts'
export type { ArchiveResult, RestoreResult } from './archive.ts'

// ── 保留策略（22 §9.2；T6.2） ──
export { ARCHIVE_IDLE_MS, applyRetention } from './retention.ts'
export type { ArchivedEntry, RetentionOptions, RetentionReport } from './retention.ts'

// ── 契约实现（T2.1–T2.5） ──
export {
  JsonlSessionPersistence,
  createJsonlPersistence,
  eventToFrame,
  frameToEvent,
  findSessionFile,
  listSessionFiles,
} from './session-store.ts'
export type { JsonlPersistenceOptions } from './session-store.ts'
