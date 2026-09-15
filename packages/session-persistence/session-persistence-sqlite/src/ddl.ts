/**
 * SQLite 全量 DDL —— 文档 22 §3 的可执行落地版（15 张表 + 1 视图 + FTS5 + 触发器）。
 *
 * **事实源是 [22 §3]，不是本文件**：本文件逐条对照 docs/22 的 SQL 搬运，
 * 并把 docs/24 §4 列出的 15 处骨架偏差全部修正（旧版 `ddl.ts` 是早期草稿）：
 *
 * | # | 修正 |
 * |---|---|
 * | 1 | `schema_version` → **`schema_migrations(version, name, applied_at, checksum)`**（无 checksum 无法检测迁移脚本漂移） |
 * | 2 | `sessions` 补齐 13 列（workspace / workspace_key / preset / model_provider / model_name / seed_length / log_path / log_codec / log_bytes / log_revision / key_id / archived_at / indexed_at）——缺 `log_revision` 与 `log_bytes` 就无法判断增量重索引 |
 * | 3 | `sessions.status` 默认 `idle` + CHECK 四值（旧版 `active` 与 22 §6.2 不符） |
 * | 4 | `session_log_index` 语义改为**一记录一行**（PK `(session_id, seq)` + byte_offset/byte_length），保住字节级随机 seek |
 * | 5 | `turns` / `steps` 补 start_seq / end_seq / steps / tool_calls / model_provider / model_name / tokens |
 * | 6 | `events` 补 turn / step / call_id / surface_op / repl_start / repl_end / ignorable / data_bytes |
 * | 7 | `messages_projection` 列名与语义对齐（summary/text_bytes/replaced_by_seq/**is_active**） |
 * | 8 | **`tool_calls` 删掉 `arguments`，改 `args_digest`**（原始参数只在 JSONL——安全取舍，不是风格） |
 * | 9 | `file_changes` 补 turn/additions/deletions/tool_call_id/`source`(CHECK 只允许 presentation-meta) |
 * | 10 | `checkpoints` 补 `safe_fork`/`created_at`，kind 枚举对齐 |
 * | 11 | `settings_kv` 换成 namespace/key/value_json/`source_layer`(CHECK 仅 L2/L3/L4)/scope/scope_ref；**`settings_effective` 改 VIEW** |
 * | 12 | `credentials_refs` 补全列（ref_kind/scope/backend/key_id/masked_hint/last_used_at） |
 * | 13 | `plugins`/`jobs` 补齐列 |
 * | 14 | `search_index` 列序改为 `(text, session_id, seq, role)` + **3 个触发器**（旧版只有 1 个） |
 * | 15 | **FTS 中文分词修正**（见下） |
 *
 * ## 关于第 15 项：FTS 中文检索
 *
 * docs/24 §4 实测证明 22 §3.13 指定的 `unicode61 remove_diacritics 2` 对中文**几乎搜不到**
 * （连续汉字被当成一个 token；查「解析」「测试」「通过」命中全为 0）。采纳的方案是
 * **「逐字预分词 + 前缀 AND」**（零依赖，纯字符串切分）。
 *
 * 但 SQL 触发器**无法做分词**，所以本文件在 22 §3.5 的 `messages_projection` 上**增加一列
 * `fts_text`**：应用侧写入 `messages_projection` 时把 `summary` 的**分词形态**放进 `fts_text`，
 * 3 个触发器索引的是 `fts_text` 而非 `summary`。这样：
 * - `summary` 仍是**原样可见文本**（UI 读它，不被污染）；
 * - FTS 拿到的 `text` 是分词后的形态，中文 1/2/3 字查询都能命中；
 * - 触发器个数、语义（`is_active = 1` 才进索引）与 22 §3.13 完全一致。
 *
 * 命中展示不用 `snippet(search_index)`（分词后中文会带空格），而是用 FTS 拿 `(session_id, seq)`
 * 再回 `messages_projection.summary` 取原文——见 `fts.ts` 的查询形状说明。
 *
 * ## 两处刻意与 22 保持一致的取舍
 *
 * - **不使用 `STRICT` 表**：22 §3 明确"本文未用（兼容性优先）"，docs/24 未决项说 v1.0 再定。
 *   驱动（SQLite 3.49.2）支持，但改了列亲和性行为，不在本轮擅自引入。
 * - **`settings_effective` 用 VIEW 而非物化表**：设置读写是低频，22 未决项倾向不物化。
 */

/** 连接前设（22 §3.0；顺序有意义：WAL 必须在其它写操作之前设） */
export const SQLITE_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL', // 索引可丢，会话不可丢（11 §2）
  'PRAGMA synchronous = NORMAL', // WAL 下足够安全，写放大可控
  'PRAGMA foreign_keys = ON', // 依赖外键级联清理，避免手工扫孤儿行
  'PRAGMA busy_timeout = 5000', // 多进程（desktop + CLI）并发写等待窗口
  'PRAGMA temp_store = MEMORY',
]

/**
 * 索引结构版本（22 §8.1）。与 `schema_migrations.version` 一一对应；
 * 与 JSONL 的 `formatVersion` 是**两套独立演进**的版本空间。
 */
export const SCHEMA_VERSION = 1

/** 本版本迁移的可读名（写进 `schema_migrations.name`，用于日志） */
export const SCHEMA_NAME = '0001-initial-schema'

export const DDL_STATEMENTS: readonly string[] = [
  // ══════════════════════ 3.0 版本表 ══════════════════════
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL,
    checksum   TEXT    NOT NULL
  )`,

  // ══════════════════════ 3.1 sessions ══════════════════════
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id     TEXT    PRIMARY KEY,
    workspace      TEXT,
    workspace_key  TEXT    NOT NULL,
    title          TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_seq       INTEGER NOT NULL DEFAULT -1,
    preset         TEXT,
    model_provider TEXT,
    model_name     TEXT,
    status         TEXT    NOT NULL DEFAULT 'idle'
                   CHECK (status IN ('idle','busy','waiting-approval','error')),
    parent_session TEXT,
    seed_length    INTEGER NOT NULL DEFAULT 0,
    log_path       TEXT    NOT NULL,
    log_codec      TEXT    NOT NULL DEFAULT 'none' CHECK (log_codec IN ('none','zstd')),
    log_bytes      INTEGER NOT NULL DEFAULT 0,
    log_revision   TEXT,
    key_id         TEXT,
    archived_at    INTEGER,
    deleted_at     INTEGER,
    indexed_at     INTEGER,
    FOREIGN KEY (parent_session) REFERENCES sessions(session_id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at     ON sessions (updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_workspace_upd  ON sessions (workspace, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_alive          ON sessions (updated_at DESC) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent         ON sessions (parent_session) WHERE parent_session IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_archive_scan   ON sessions (archived_at, updated_at)
     WHERE deleted_at IS NULL AND archived_at IS NULL`,

  // ══════════════════════ 3.2 session_log_index ══════════════════════
  // 一**记录**一行（不是一会话一行）：保住「回放到第 N 步」的字节级随机 seek（22 §3.2）
  `CREATE TABLE IF NOT EXISTS session_log_index (
    session_id   TEXT    NOT NULL,
    seq          INTEGER NOT NULL,
    seq_last     INTEGER NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('header','event','chunk-batch')),
    type         TEXT    NOT NULL,
    byte_offset  INTEGER NOT NULL,
    byte_length  INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_log_index_type ON session_log_index (session_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_log_index_kind ON session_log_index (kind)`,

  // ══════════════════════ 3.3 turns / steps ══════════════════════
  `CREATE TABLE IF NOT EXISTS turns (
    session_id  TEXT    NOT NULL,
    turn        INTEGER NOT NULL,
    start_seq   INTEGER NOT NULL,
    end_seq     INTEGER,
    reason      TEXT,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    steps       INTEGER NOT NULL DEFAULT 0,
    tool_calls  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, turn),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS steps (
    session_id     TEXT    NOT NULL,
    turn           INTEGER NOT NULL,
    step           INTEGER NOT NULL,
    start_seq      INTEGER NOT NULL,
    end_seq        INTEGER,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    model_provider TEXT,
    model_name     TEXT,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    PRIMARY KEY (session_id, turn, step),
    FOREIGN KEY (session_id, turn) REFERENCES turns(session_id, turn) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_turns_open  ON turns (session_id) WHERE end_seq IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_steps_open  ON steps (session_id) WHERE end_seq IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_turns_time  ON turns (session_id, started_at)`,

  // ══════════════════════ 3.4 events ══════════════════════
  // 投影表、不是真相：不含 assistant/chunk 行（chunk 只在 session_log_index 里按批出现）
  `CREATE TABLE IF NOT EXISTS events (
    session_id   TEXT    NOT NULL,
    seq          INTEGER NOT NULL,
    type         TEXT    NOT NULL,
    time         INTEGER NOT NULL,
    turn         INTEGER,
    step         INTEGER,
    call_id      TEXT,
    surface_op   TEXT    CHECK (surface_op IN ('append','replace')),
    repl_start   INTEGER,
    repl_end     INTEGER,
    ignorable    INTEGER NOT NULL DEFAULT 0,
    data_bytes   INTEGER,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events (session_id, type, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_events_call ON events (session_id, call_id) WHERE call_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_events_turn ON events (session_id, turn, step)`,
  `CREATE INDEX IF NOT EXISTS idx_events_time ON events (session_id, time)`,

  // ══════════════════════ 3.5 messages_projection ══════════════════════
  // surface_index（表面位置）与 seq（事件序号）**必须分开**——这是本子系统最易混淆处
  // fts_text 是本实现的补充列（见文件头「第 15 项」）：存放 summary 的中文分词形态
  `CREATE TABLE IF NOT EXISTS messages_projection (
    session_id      TEXT    NOT NULL,
    surface_index   INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    role            TEXT    NOT NULL CHECK (role IN ('user','assistant','tool')),
    block_kind      TEXT    NOT NULL,
    summary         TEXT    NOT NULL DEFAULT '',
    text_bytes      INTEGER NOT NULL DEFAULT 0,
    fts_text        TEXT    NOT NULL DEFAULT '',
    replaced_by_seq INTEGER,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (session_id, surface_index),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_active ON messages_projection (session_id, surface_index) WHERE is_active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_messages_seq    ON messages_projection (session_id, seq)`,

  // ══════════════════════ 3.6 tool_calls ══════════════════════
  // 注意：**没有 arguments 列**，只有 args_digest。原始参数只存在于权威 JSONL（22 §3.6）
  `CREATE TABLE IF NOT EXISTS tool_calls (
    session_id   TEXT    NOT NULL,
    call_id      TEXT    NOT NULL,
    seq          INTEGER NOT NULL,
    result_seq   INTEGER,
    turn         INTEGER NOT NULL,
    step         INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    args_digest  TEXT    NOT NULL,
    args_bytes   INTEGER NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','denied','cancelled')),
    started_at   INTEGER,
    ended_at     INTEGER,
    duration_ms  INTEGER,
    error_code   TEXT,
    result_bytes INTEGER,
    PRIMARY KEY (session_id, call_id),
    UNIQUE (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_name   ON tool_calls (session_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls (session_id, status)
     WHERE status IN ('failed','denied','cancelled')`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_open   ON tool_calls (session_id) WHERE result_seq IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_turn   ON tool_calls (session_id, turn, step)`,

  // ══════════════════════ 3.7 file_changes ══════════════════════
  // source 只允许 'presentation-meta'：把「变更集合是可重放派生、不许扫盘」钉在表结构里
  `CREATE TABLE IF NOT EXISTS file_changes (
    session_id   TEXT    NOT NULL,
    turn         INTEGER NOT NULL,
    path         TEXT    NOT NULL,
    change_kind  TEXT    NOT NULL CHECK (change_kind IN ('add','modify','delete','rename')),
    additions    INTEGER NOT NULL DEFAULT 0,
    deletions    INTEGER NOT NULL DEFAULT 0,
    tool_call_id TEXT    NOT NULL,
    source       TEXT    NOT NULL DEFAULT 'presentation-meta'
                 CHECK (source = 'presentation-meta'),
    seq          INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_call_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_changes_turn ON file_changes (session_id, turn)`,
  `CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes (session_id, path)`,
  `CREATE INDEX IF NOT EXISTS idx_file_changes_tool ON file_changes (session_id, tool_call_id)`,

  // ══════════════════════ 3.8 checkpoints ══════════════════════
  `CREATE TABLE IF NOT EXISTS checkpoints (
    session_id  TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('turn-end','step-end','session-end-seed','manual')),
    safe_fork   INTEGER NOT NULL DEFAULT 0,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq, kind),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoints_fork ON checkpoints (session_id, seq) WHERE safe_fork = 1`,

  // ══════════════════════ 3.9 settings_kv + settings_effective ══════════════════════
  // CHECK 刻意不含 L1/L5/L6：那三层是内存与代码，写进持久层就是 bug（22 §3.9）
  `CREATE TABLE IF NOT EXISTS settings_kv (
    namespace    TEXT    NOT NULL,
    key          TEXT    NOT NULL,
    value_json   TEXT    NOT NULL,
    source_layer TEXT    NOT NULL CHECK (source_layer IN ('L2','L3','L4')),
    scope        TEXT    NOT NULL DEFAULT 'user' CHECK (scope IN ('user','workspace','session')),
    scope_ref    TEXT    NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (namespace, key, source_layer, scope, scope_ref)
  )`,
  `CREATE VIEW IF NOT EXISTS settings_effective AS
   SELECT namespace, key, value_json AS value, source_layer AS source
   FROM (
     SELECT namespace, key, value_json, source_layer,
            ROW_NUMBER() OVER (PARTITION BY namespace, key
              ORDER BY CASE source_layer WHEN 'L2' THEN 1 WHEN 'L3' THEN 2 WHEN 'L4' THEN 3 ELSE 9 END
            ) AS rn
     FROM settings_kv
   )
   WHERE rn = 1`,
  `CREATE INDEX IF NOT EXISTS idx_settings_ns    ON settings_kv (namespace, key)`,
  `CREATE INDEX IF NOT EXISTS idx_settings_scope ON settings_kv (scope, scope_ref)`,

  // ══════════════════════ 3.10 credentials_refs ══════════════════════
  // 本表没有、也永远不会有 value 列（I7 的结构层保证）
  `CREATE TABLE IF NOT EXISTS credentials_refs (
    ref          TEXT    NOT NULL,
    ref_kind     TEXT    NOT NULL CHECK (ref_kind IN ('env-ref','record')),
    scope        TEXT    NOT NULL DEFAULT 'llm'
                 CHECK (scope IN ('llm') OR scope LIKE 'plugin:%' OR scope LIKE 'sandbox:%'),
    backend      TEXT    NOT NULL CHECK (backend IN ('keychain','file-0600','env','session')),
    key_id       TEXT,
    masked_hint  TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (ref, scope)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credential_scope     ON credentials_refs (scope, ref_kind)`,
  `CREATE INDEX IF NOT EXISTS idx_credential_last_used ON credentials_refs (last_used_at DESC)
     WHERE last_used_at IS NOT NULL`,

  // ══════════════════════ 3.11 plugins ══════════════════════
  `CREATE TABLE IF NOT EXISTS plugins (
    id               TEXT    NOT NULL,
    version          TEXT    NOT NULL,
    manifest_hash    TEXT    NOT NULL,
    content_hash     TEXT    NOT NULL,
    permissions_json TEXT    NOT NULL,
    contributes_json TEXT    NOT NULL DEFAULT '{}',
    enabled          INTEGER NOT NULL DEFAULT 0,
    install_path     TEXT    NOT NULL,
    source           TEXT    NOT NULL CHECK (source IN ('builtin','local','market')),
    engines_lcode    TEXT    NOT NULL,
    granted_at       INTEGER,
    installed_at     INTEGER NOT NULL,
    activated_at     INTEGER,
    PRIMARY KEY (id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins (enabled) WHERE enabled = 1`,
  `CREATE INDEX IF NOT EXISTS idx_plugins_source  ON plugins (source)`,

  // ══════════════════════ 3.12 jobs ══════════════════════
  `CREATE TABLE IF NOT EXISTS jobs (
    job_id        TEXT    PRIMARY KEY,
    kind          TEXT    NOT NULL,
    label         TEXT    NOT NULL,
    owner_session TEXT,
    status        TEXT    NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','stopping','completed','killed','failed')),
    progress      REAL,
    output_bytes  INTEGER NOT NULL DEFAULT 0,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    error_code    TEXT,
    FOREIGN KEY (owner_session) REFERENCES sessions(session_id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_owner   ON jobs (owner_session, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_running ON jobs (status) WHERE status IN ('running','stopping')`,

  // ══════════════════════ 3.13 search_index（FTS5）与触发器 ══════════════════════
  // tokenize 仍是 22 §3.13 的 unicode61；中文靠**写入侧预分词**（fts_text）解决，不改分词器
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    text,
    session_id UNINDEXED,
    seq        UNINDEXED,
    role       UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_search_index_insert
   AFTER INSERT ON messages_projection
   WHEN NEW.is_active = 1 AND NEW.fts_text <> ''
   BEGIN
     INSERT INTO search_index(rowid, text, session_id, seq, role)
     VALUES (NEW.rowid, NEW.fts_text, NEW.session_id, NEW.seq, NEW.role);
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_search_index_delete
   AFTER DELETE ON messages_projection
   BEGIN
     DELETE FROM search_index WHERE rowid = OLD.rowid;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_search_index_update
   AFTER UPDATE OF fts_text, is_active ON messages_projection
   BEGIN
     DELETE FROM search_index WHERE rowid = OLD.rowid;
     INSERT INTO search_index(rowid, text, session_id, seq, role)
     SELECT NEW.rowid, NEW.fts_text, NEW.session_id, NEW.seq, NEW.role
     WHERE NEW.is_active = 1 AND NEW.fts_text <> '';
   END`,
]

/** 顺序执行用的一次性 SQL 文本（`db.exec` 可正确解析触发器体内的分号） */
export const DDL: string = DDL_STATEMENTS.join(';\n') + ';'
