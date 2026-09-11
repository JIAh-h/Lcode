/**
 * SQLite 全量 DDL（文档 22 §3，15 张表 + 版本表）。
 * 常量供实现包在连接初始化时按序执行（22 §3.0：先设 pragma，再建版本表）。
 * 列类型与命名以 22 §3 为准；索引已内联。
 */

export const SQLITE_PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`

export const SCHEMA_VERSION = 1

export const DDL_STATEMENTS: readonly string[] = [
  // ── 3.0 版本表 ──
  `CREATE TABLE IF NOT EXISTS schema_version (
    version   INTEGER NOT NULL,
    appliedAt INTEGER NOT NULL,
    note      TEXT
  )`,

  // ── 3.1 sessions 会话元数据 ──
  `CREATE TABLE IF NOT EXISTS sessions (
    sessionId     TEXT PRIMARY KEY,
    title         TEXT,
    cwd           TEXT NOT NULL,
    createdAt     INTEGER NOT NULL,
    updatedAt     INTEGER NOT NULL,
    lastEventSeq  INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',
    parentSession TEXT,
    deletedAt     INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updatedAt DESC)`,

  // ── 3.2 session_log_index 日志文件索引 + revision ──
  `CREATE TABLE IF NOT EXISTS session_log_index (
    sessionId  TEXT PRIMARY KEY REFERENCES sessions(sessionId),
    logPath    TEXT NOT NULL,
    revision   TEXT NOT NULL,
    eventCount INTEGER NOT NULL DEFAULT 0,
    bytes      INTEGER NOT NULL DEFAULT 0,
    indexedAt  INTEGER NOT NULL
  )`,

  // ── 3.3 turns / steps ──
  `CREATE TABLE IF NOT EXISTS turns (
    sessionId TEXT NOT NULL,
    turn      INTEGER NOT NULL,
    startedAt INTEGER NOT NULL,
    endedAt   INTEGER,
    reason    TEXT,
    PRIMARY KEY (sessionId, turn)
  )`,
  `CREATE TABLE IF NOT EXISTS steps (
    sessionId TEXT NOT NULL,
    turn      INTEGER NOT NULL,
    step      INTEGER NOT NULL,
    startedAt INTEGER NOT NULL,
    endedAt   INTEGER,
    PRIMARY KEY (sessionId, turn, step)
  )`,

  // ── 3.4 events 事件平面索引 ──
  `CREATE TABLE IF NOT EXISTS events (
    sessionId TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    type      TEXT NOT NULL,
    time      INTEGER NOT NULL,
    PRIMARY KEY (sessionId, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(sessionId, type, seq)`,

  // ── 3.5 messages_projection 消息投影缓存（可重建） ──
  `CREATE TABLE IF NOT EXISTS messages_projection (
    sessionId TEXT NOT NULL,
    surfaceIdx INTEGER NOT NULL,
    seq       INTEGER NOT NULL,
    role      TEXT NOT NULL,
    content   TEXT NOT NULL,
    hidden    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sessionId, surfaceIdx)
  )`,

  // ── 3.6 tool_calls ──
  `CREATE TABLE IF NOT EXISTS tool_calls (
    sessionId TEXT NOT NULL,
    callId    TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    turn      INTEGER,
    step      INTEGER,
    name      TEXT NOT NULL,
    arguments TEXT NOT NULL,
    resultSeq INTEGER,
    ok        INTEGER,
    errorCode TEXT,
    PRIMARY KEY (sessionId, callId)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_seq ON tool_calls(sessionId, seq)`,

  // ── 3.7 file_changes ──
  `CREATE TABLE IF NOT EXISTS file_changes (
    sessionId TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    path      TEXT NOT NULL,
    kind      TEXT NOT NULL,
    PRIMARY KEY (sessionId, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(sessionId, path)`,

  // ── 3.8 checkpoints 时间轴检查点 ──
  `CREATE TABLE IF NOT EXISTS checkpoints (
    sessionId TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    label     TEXT,
    kind      TEXT NOT NULL DEFAULT 'turn',
    PRIMARY KEY (sessionId, seq)
  )`,

  // ── 3.9 settings_kv / settings_effective ──
  `CREATE TABLE IF NOT EXISTS settings_kv (
    key       TEXT NOT NULL,
    layer     TEXT NOT NULL,
    scope     TEXT,
    value     TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (key, layer, scope)
  )`,
  `CREATE TABLE IF NOT EXISTS settings_effective (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL,
    sourceLayer TEXT NOT NULL
  )`,

  // ── 3.10 credentials_refs（只存引用名，值永不落库，I7） ──
  `CREATE TABLE IF NOT EXISTS credentials_refs (
    refName  TEXT PRIMARY KEY,
    source   TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,

  // ── 3.11 plugins ──
  `CREATE TABLE IF NOT EXISTS plugins (
    pluginId   TEXT PRIMARY KEY,
    manifestPath TEXT NOT NULL,
    version    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    declaredPermissions TEXT NOT NULL DEFAULT '[]'
  )`,

  // ── 3.12 jobs ──
  `CREATE TABLE IF NOT EXISTS jobs (
    jobId     TEXT PRIMARY KEY,
    sessionId TEXT,
    kind      TEXT NOT NULL,
    status    TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    exitCode  INTEGER
  )`,

  // ── 3.13 search_index（FTS5）与触发器 ──
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    sessionId UNINDEXED, content, role UNINDEXED
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_messages_insert AFTER INSERT ON messages_projection
    BEGIN
      INSERT INTO search_index(sessionId, content, role)
      VALUES (new.sessionId, new.content, new.role);
    END`,
]

/** 顺序执行 DDL（迁移脚本形状见 22 §8.3；未知版本报错而非尽力解析，22 §8.2） */
export const DDL = DDL_STATEMENTS.join(';\n') + ';'
