import type { ModelSelection } from '@lcode/agent-default-model'
import type {
  ApprovalAction,
  ApprovalBasis,
  EpochHeader,
  Impact,
  ModelMessage,
  SessionService,
  SessionEvent,
  StreamChunk,
  SurfaceOp,
  ToolResultMessage,
} from '@lcode/session'
import type { JsonValue } from '@lcode/util'

/**
 * `sessions.*` 的对外类型（doc 21 §2.1）。
 *
 * **字段命名沿用 doc 21 的 snake_case**——这些方法最终要经 IPC / JSON-RPC 暴露，
 * 在这里就对齐线格式可以避免上层再写一遍字段改名（改名点越多越容易漏）。
 */

export type { ModelMessage, ModelSelection, SessionEvent, SurfaceOp }

/** 会话状态（doc 22 §6.2；与 `sessions.status` 的 CHECK 一致） */
export type SessionStatus = 'idle' | 'busy' | 'waiting-approval' | 'error'

/**
 * 会话头 —— `sessions.meta` 的返回体，也是 JSONL 头部帧在 API 层的形态。
 * 列与 doc 22 §3.1 的 `sessions` 表一一对应（派生列除外）。
 */
export interface SessionHeader {
  readonly session_id: string
  readonly workspace: string | null
  /** workspace 的 16 hex 短哈希（doc 22 §2.1） */
  readonly workspace_key: string
  readonly title: string
  readonly created_at: number
  readonly updated_at: number
  readonly preset: string | null
  readonly model_provider: string | null
  readonly model_name: string | null
  readonly status: SessionStatus
  readonly parent_session: string | null
  /** 种子长度（分叉出的会话会 > 0，doc 11 §7） */
  readonly seed_length: number
  /** 相对 Lcode Home 的日志路径（doc 22 §7.3） */
  readonly log_path: string
  readonly log_codec: 'none' | 'zstd'
  readonly key_id: string | null
}

/** `sessions.list` 的条目：会话头 + 索引侧才有的事实 */
export interface SessionMeta extends SessionHeader {
  readonly last_seq: number
  readonly log_bytes: number
  readonly log_revision: string | null
  readonly archived_at: number | null
  readonly deleted_at: number | null
}

export interface CreateSessionInput {
  /** 工作区根（必填，doc 21 §2.1） */
  readonly cwd: string
  readonly preset?: string | undefined
  readonly title?: string | undefined
  readonly modelSelection?: ModelSelection | undefined
}

export interface CreateSessionResult {
  readonly session_id: string
  readonly last_seq: number
}

export interface ResumeSessionInput {
  readonly session_id: string
  /** 追加的种子事件（可选；分叉/导入用） */
  readonly seed?: readonly SessionEvent[] | undefined
}

export interface ResumeSessionResult {
  readonly session_id: string
  readonly last_seq: number
  /**
   * 是否发生过修复：撕裂尾被丢弃（`loader`）**或**补了收尾事件（T6.1 崩溃恢复）。
   * 只反映"有没有补过东西"，不告诉补了什么——补记本身在 `closers` 与日志里。
   */
  readonly repaired: boolean
  /**
   * 本次恢复补出来的收尾事件（docs/21 §6.2 `ES-RECOVERY_REPAIRED` 的承载）。
   *
   * **它们已经写回日志**（11 §6.1：补出的事件是持久的、被审计的），此字段只是回执，
   * 供 UI 在时间轴上把这些节点标注为"此处为恢复时补全"（06 §9.4：必须可区分，
   * 不得伪装成真实发生的事件）。无补记时字段缺省。
   */
  readonly closers?: readonly SessionEvent[] | undefined
}

export interface ListSessionsInput {
  readonly workspace?: string | undefined
  readonly includeArchived?: boolean | undefined
  /** 默认 50 */
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
}

export interface ListSessionsResult {
  readonly items: readonly SessionMeta[]
  /** 还有下一页时给出；原样回传给下一次 `list` */
  readonly nextCursor?: string | undefined
}

export interface SessionMetaInput {
  readonly session_id: string
}

export interface SessionMetaResult {
  readonly last_seq: number
  readonly header: SessionHeader
  readonly log_revision: string
}

/**
 * 重命名会话（用户元数据，只落 SQLite，不写 JSONL——11 §6：标题不在权威日志里）。
 * 空标题回 `EC-INVALID_PARAMS`，会话不存在回 `ES-SESSION_NOT_FOUND`。
 */
export interface RenameSessionInput {
  readonly session_id: string
  readonly title: string
}

export interface RenameSessionResult {
  readonly session_id: string
  readonly title: string
}

export interface ForkSessionInput {
  readonly source_session_id: string
  /** 切点（seq）。必须落在已关闭的轮边界上，否则 `ES-FORK_BOUNDARY_INVALID` */
  readonly boundary: number
  readonly child_id?: string | undefined
}

export interface ForkSessionResult {
  readonly session_id: string
  readonly last_seq: number
}

export interface AppendEventInput {
  readonly session_id: string
  readonly type: string
  readonly data: JsonValue
  readonly surface_op?: SurfaceOp | undefined
  readonly source_event_seqs?: readonly number[] | undefined
}

export interface DeriveInput {
  readonly session_id: string
  /** 只派生到该 seq（不含）；省略即整条日志 */
  readonly up_to?: number | undefined
}

export interface DeriveResult {
  readonly messages: readonly ModelMessage[]
}

export interface FlushInput {
  readonly session_id: string
}

export interface FlushResult {
  readonly flushed: true
}

export type ExportFormat = 'jsonl' | 'md'

export interface ExportInput {
  readonly session_id: string
  readonly format: ExportFormat
  /** `md` 下是否内联附件内容（`jsonl` 恒为整份原始日志，该选项无意义） */
  readonly inline_attachments?: boolean | undefined
}

export interface ExportResult {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** 从用户选择的 JSONL 分享文件导入为新的本地会话；Markdown 不可逆，不支持导入。 */
export interface ImportSessionInput {
  readonly path: string
  readonly title?: string | undefined
}

export interface ImportSessionResult {
  readonly session_id: string
  readonly last_seq: number
  readonly imported_events: number
}

/** 会话全文检索（FTS5，逐字预分词 + 前缀 AND；22 §3.13）。 */
export interface SearchSessionsInput {
  readonly query: string
  readonly limit?: number | undefined
  /** 默认不包含已软删会话（22 未决项倾向：删了就不该还能搜到） */
  readonly include_deleted?: boolean | undefined
}

export interface SearchSessionHit {
  readonly session_id: string
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool'
  /** 命中原样文本；不用 `snippet()`——分词后中文会带空格（fts.ts 的查询形状说明） */
  readonly summary: string
  readonly title: string
  readonly workspace: string | null
  readonly updated_at: number
}

export interface SearchSessionsResult {
  readonly items: readonly SearchSessionHit[]
}

/**
 * 全量导出（22 §9.5 的 `lcode export --all`）。
 * `manifest.json` 记每个会话文件的大小与 SHA-256，供用户自行校验完整性
 * ——这是"`revision` 不用于完整性校验"的补充（22 §4.3）。
 */
export interface ExportAllInput {
  /** 输出目录；省略则落在 `<Lcode Home>/exports/<时间戳>/` */
  readonly out?: string | undefined
  readonly format?: ExportFormat | undefined
  /** 是否含已软删（在回收站语义上仍存在的）会话；默认 false */
  readonly includeDeleted?: boolean | undefined
}

export interface ExportAllEntry {
  readonly session_id: string
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface ExportAllResult {
  readonly dir: string
  readonly manifest_path: string
  readonly entries: readonly ExportAllEntry[]
  readonly skipped: readonly { readonly session_id: string; readonly reason: string }[]
}

/** 软删（22 §9.3：从列表隐藏，数据保留；**文件不动**） */
export interface DeleteSessionInput {
  readonly session_id: string
}

export interface DeleteSessionResult {
  readonly deleted_at: number
}

export interface RestoreSessionInput {
  readonly session_id: string
}

export interface RestoreSessionResult {
  readonly restored: true
}

/**
 * 硬删（22 §9.3：文件移入 `trash/`，到期连同索引行与 spill 一起清除）。
 *
 * `exported: false` 时**拒绝执行**并回 `EC-CONFLICT`——"删除在任何情况下都先提示导出"
 * 是产品宪法第二条的硬要求（11 §9.3）。要真正跳过，调用方必须显式传 `force: true`，
 * 表示"用户已确认明知不可导出也要删"。
 */
export interface PurgeSessionInput {
  readonly session_id: string
  /** 用户是否已就"导出后再删除"做过选择（通常是刚跑完 `sessions.export`） */
  readonly exported?: boolean | undefined
  /** 显式跳过导出提示（危险；需 UI 二次确认后传入） */
  readonly force?: boolean | undefined
}

export interface PurgeSessionResult {
  readonly trashed_path: string
  /** `cache/spill` 下清掉的字节数 */
  readonly spill_freed_bytes: number
}

/** 回收站条目（`trash/<session-id>.jsonl.<ts>`） */
export interface TrashEntry {
  readonly session_id: string
  readonly path: string
  readonly bytes: number
  readonly deleted_at: number
  /** 距到期被硬删还剩多少毫秒；已过期则为 0 */
  readonly expires_in_ms: number
}

export interface ListTrashResult {
  readonly items: readonly TrashEntry[]
  readonly total_bytes: number
}

/** 存储占用（M-DATA-04「存储占用可视化」的数据来源） */
export interface StorageUsageResult {
  readonly sessions: number
  readonly trash: number
  readonly cache: number
  readonly exports: number
  readonly index: number
  readonly total: number
}

export interface PruneStorageInput {
  /** 清理到期的回收站条目（7 天）；默认 true */
  readonly trash?: boolean | undefined
  /** 按 LRU 把 `cache/` 压到上限以下；默认 true */
  readonly cache?: boolean | undefined
  /** 清空整棵 `cache/`（比 LRU 更彻底）；默认 false */
  readonly purgeCache?: boolean | undefined
  /** 清空回收站（跳过 7 天窗口，立即硬删）；默认 false */
  readonly emptyTrash?: boolean | undefined
}

export interface PruneStorageResult {
  readonly trash: { readonly removed: number; readonly freedBytes: number; readonly kept: number }
  readonly cache: {
    readonly evicted: number
    readonly freedBytes: number
    readonly remainingBytes: number
    readonly stillOverLimit: boolean
  }
  readonly usage: StorageUsageResult
}

/**
 * 压缩归档（22 §9.2/§9.4）：把空闲 ≥ 30 天的会话从 `.jsonl` 转成 `.jsonl.zst`。
 *
 * `openSessionIds` 由装配层给出——**开放中的会话永不压缩**（22 §9.2）。
 * `dryRun` 只报告不写盘（`lcode archive --check`）。
 */
export interface ArchiveInput {
  /** 只处理这一个会话 */
  readonly session_id?: string | undefined
  readonly openSessionIds?: readonly string[] | undefined
  readonly dryRun?: boolean | undefined
  /** 空闲阈值（毫秒），默认 30 天 */
  readonly idleMs?: number | undefined
}

export interface ArchiveEntry {
  readonly session_id: string
  readonly file: string
  readonly archived_path: string
  readonly original_bytes: number
  readonly compressed_bytes: number
  readonly ratio: number
}

export interface ArchiveResult {
  readonly scanned: number
  readonly archived: readonly ArchiveEntry[]
  readonly skipped_idle: number
  readonly skipped_open: number
  readonly failed: readonly { readonly session_id: string; readonly message: string }[]
  readonly zstd_available: boolean
}

/**
 * 索引体检的判定（22 §1.3 `lcode doctor --index`）。
 *
 * 判定依据只有 `sessions.log_revision` 与真实文件的对齐情况（22 §4.3）——
 * 它是个廉价令牌，所以体检不必读日志内容。
 */
export type IndexFindingReason = 'missing' | 'changed' | 'not-indexed' | 'no-revision'

export interface IndexFinding {
  readonly sessionId: string
  /** 日志绝对路径；`missing` 且文件确实不在时为 null */
  readonly logPath: string | null
  readonly reason: IndexFindingReason
}

export interface IndexDoctorReport {
  /** true = 没有需要处理的会话，且索引库存在可读 */
  readonly ok: boolean
  readonly dbExists: boolean
  /** 索引库的 schema 版本；库不存在为 null */
  readonly schemaVersion: number | null
  readonly findings: readonly IndexFinding[]
  /** 前三类里"重建能解决"的数量（不含 `missing`——那多半需要人工看一眼） */
  readonly needsReindex: number
  /** 给人看的一句话说明（可选） */
  readonly note?: string | undefined
}

/** `history.replay`：目标 seq 可以是请求头本身或该请求步骤中的任一事件。 */
export interface HistoryReplayInput {
  readonly session_id: string
  readonly up_to_seq: number
}

export interface ReplayToolCall {
  readonly call: {
    readonly seq: number
    readonly call_id: string
    readonly name: string
    readonly card?: string | undefined
    /** 原始 JSON 字符串，保持与 `tool/call.arguments` 一致。 */
    readonly arguments: string
  }
  readonly result?: ToolResultMessage | undefined
}

export interface ReplayDecision {
  readonly kind: string
  readonly basis: string
  readonly at: number
}

/** `history.replay` 的只读请求快照（06 §10.2）。 */
export interface ReplaySnapshot {
  readonly header: EpochHeader
  /** 请求头之前的表面投影，恰好是这次请求发送给模型的历史。 */
  readonly messages: readonly ModelMessage[]
  readonly chunks: readonly StreamChunk[]
  readonly toolCalls: readonly ReplayToolCall[]
  readonly decisions: readonly ReplayDecision[]
}

/** `history.why` 以工具调用事件的 seq 作为稳定锚点，而不是容易跨轮重复的 callId。 */
export interface HistoryWhyInput {
  readonly session_id: string
  readonly call_seq: number
}

export interface HistoryCheckpointsInput {
  readonly session_id: string
}

/** 只读取一个事件的 payload；前端先持有时间轴元数据，需要时才调用。 */
export interface HistoryBodyInput {
  readonly session_id: string
  readonly seq: number
}

export interface HistoryBodyResult {
  /** UTF-8 编码后的 JSON payload 字节数，供 UI 决定是否展开。 */
  readonly bytes: number
  /** 不透明且由 payload 内容绑定的标识；会话被清除后自然失效。 */
  readonly ref: string
  /** 只返回目标事件的无损 JSON 载荷，不返回整条会话或相邻事件。 */
  readonly data: JsonValue
}

export interface DecisionTrace {
  readonly call: {
    readonly seq: number
    readonly call_id: string
    readonly name: string
  }
  /**
   * 没有策略落盘时必须明确返回 `not-recorded`，不能把沉默解释成允许。
   * `basis` 是实际发生审批时策略给出的解释。
   */
  readonly policy: {
    readonly status: 'not-recorded' | 'recorded'
    readonly basis?: ApprovalBasis | undefined
  }
  readonly approval: {
    readonly status: 'not-requested' | 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    readonly action?: ApprovalAction | undefined
    readonly basis?: ApprovalBasis | undefined
    readonly impact?: Impact | undefined
    readonly asked_at?: number | undefined
    readonly decided_at?: number | undefined
    readonly decided_by?: 'human' | 'auto-denied' | 'cancelled' | undefined
  }
  /** 沙箱事件同样是事实记录；没写入即不对其强制能力作任何推断。 */
  readonly sandbox: {
    readonly status: 'not-recorded' | 'profiled' | 'degraded'
    readonly mode?: string | undefined
    readonly reason?: string | undefined
    readonly mechanism?: string | undefined
  }
}

/** 已闭合轮的只读锚点；它不是文件快照，也不承诺可回滚。 */
export interface Checkpoint {
  readonly turn: number
  readonly end_seq: number
  readonly ended_at: number
  readonly reason: 'completed' | 'cancelled' | 'interrupted' | 'error'
}

/** `history.*` 属于 session-api 边界，而非 persistence 服务域（21 §2.12）。 */
export interface HistoryApi {
  replay(input: HistoryReplayInput): Promise<ReplaySnapshot>
  why(input: HistoryWhyInput): Promise<DecisionTrace>
  checkpoints(input: HistoryCheckpointsInput): Promise<readonly Checkpoint[]>
  body(input: HistoryBodyInput): Promise<HistoryBodyResult>
}

/**
 * `sessions.*` 的进程内形态（doc 21 §2.1）。
 * 方向 `P→K`：插件/能力包调用内核。
 */
export interface SessionsApi {
  create(input: CreateSessionInput): Promise<CreateSessionResult>
  resume(input: ResumeSessionInput): Promise<ResumeSessionResult>
  list(input?: ListSessionsInput): Promise<ListSessionsResult>
  meta(input: SessionMetaInput): Promise<SessionMetaResult>
  rename(input: RenameSessionInput): Promise<RenameSessionResult>
  fork(input: ForkSessionInput): Promise<ForkSessionResult>
  append(input: AppendEventInput): Promise<SessionEvent>
  derive(input: DeriveInput): Promise<DeriveResult>
  flush(input: FlushInput): Promise<FlushResult>
  export(input: ExportInput): Promise<ExportResult>
  /** 导入 JSONL 分享副本；永远生成新 session_id，不覆盖已有会话。 */
  import(input: ImportSessionInput): Promise<ImportSessionResult>
  /** 全文检索：按会话去重，保留排名最高的一条命中。 */
  search(input: SearchSessionsInput): Promise<SearchSessionsResult>
  /** 全量导出 + `manifest.json`（22 §9.5；对应 `lcode export --all`） */
  exportAll(input?: ExportAllInput): Promise<ExportAllResult>
  /** 软删：从列表隐藏，文件不动（22 §9.3） */
  delete(input: DeleteSessionInput): Promise<DeleteSessionResult>
  /** 撤销软删 */
  restore(input: RestoreSessionInput): Promise<RestoreSessionResult>
  /** 硬删：移入 `trash/`（7 天后由 `prune` 清除） */
  purge(input: PurgeSessionInput): Promise<PurgeSessionResult>
  /** 回收站清单 */
  listTrash(): Promise<ListTrashResult>
  /** 存储占用统计 */
  storageUsage(): Promise<StorageUsageResult>
  /** 保留策略维护：回收站到期清理 + `cache/` LRU */
  prune(input?: PruneStorageInput): Promise<PruneStorageResult>
  /** 压缩归档空闲会话（22 §9.4；开放中的会话永不压缩） */
  archive(input?: ArchiveInput): Promise<ArchiveResult>
  /** 索引体检（22 §1.3；`lcode doctor --index` 的进程内入口，T6.4） */
  doctorIndex(): Promise<IndexDoctorReport>
}

/**
 * 运行时会话 provider。它保留 `SessionsApi` 的进程内边界，并补上 Agent Loop
 * 与策略层需要的已打开会话句柄和按会话工作区解析能力。
 *
 * 这是受发行包信任的内置服务契约；第三方插件不会从 Context 取得它。
 */
export interface RuntimeSessionsService extends SessionsApi {
  sessionServiceFor(sessionId: string): SessionService
  workspaceOf(sessionId: string): string | undefined
  close(): Promise<void>
}
