import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAllIndexDbs, openIndexDb } from './db.ts'
import { SCHEMA_VERSION } from './ddl.ts'
import { buildMatchQuery, searchMessages, segmentForFts } from './fts.ts'
import { applyMigrations, checksumOf, MIGRATIONS, readSchemaVersion } from './migrations.ts'
import { createEmptyIndexDb, describeIndexDb, dropIndexDb, indexDbFiles } from './rebuild.ts'

/**
 * T1 验收（docs/24 §5 阶段 1）：
 * - T1.1：15 表 + 视图 + 3 触发器齐全；`foreign_keys` 生效；`tool_calls` **没有** arguments 列；
 *         FTS5 `MATCH` 能查到中文
 * - T1.2：pragma 按序执行（WAL / busy_timeout / foreign_keys / temp_store）
 * - T1.3：checksum 校验、版本高于程序报错、单事务可重入
 * - T1.4：删库 → 一键重建出空表结构
 */

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-idx-'))
})

afterEach(() => {
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

function tableNames(db: BetterSqlite3.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((r) => r.name)
}

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.map((r) => r.name)
}

function seedSession(db: BetterSqlite3.Database, sessionId: string, title: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, workspace, workspace_key, title, created_at, updated_at, last_seq,
                           log_path, log_codec, log_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', ?)`,
  ).run(sessionId, '/repo/web', 'a1b2c3d4e5f60718', title, 1_757_491_200_000, 1_757_491_200_500, 7,
    `sessions/a1b2c3d4e5f60718/${sessionId}.jsonl`, 2048)
}

/** 按 22 §3.5 写入一条投影行（fts_text 走分词，summary 保原样） */
function seedMessage(
  db: BetterSqlite3.Database,
  sessionId: string,
  surfaceIndex: number,
  seq: number,
  role: string,
  summary: string,
  isActive = 1,
): void {
  db.prepare(
    `INSERT INTO messages_projection
       (session_id, surface_index, seq, role, block_kind, summary, text_bytes, fts_text,
        replaced_by_seq, is_active, created_at)
     VALUES (?, ?, ?, ?, 'text', ?, ?, ?, NULL, ?, ?)`,
  ).run(sessionId, surfaceIndex, seq, role, summary, summary.length, segmentForFts(summary), isActive,
    1_757_491_200_000)
}

describe('T1.1 DDL：表、视图、触发器', () => {
  it('建出全部 15 张表 + settings_effective 视图', () => {
    const db = openIndexDb({ home })
    const names = tableNames(db)
    for (const expected of [
      'schema_migrations',
      'sessions',
      'session_log_index',
      'turns',
      'steps',
      'events',
      'messages_projection',
      'tool_calls',
      'file_changes',
      'checkpoints',
      'settings_kv',
      'credentials_refs',
      'plugins',
      'jobs',
      'search_index',
    ]) {
      expect(names, `缺表 ${expected}`).toContain(expected)
    }
    expect(names).toContain('settings_effective')
  })

  it('settings_effective 是 VIEW 而不是 TABLE（偏差 #11）', () => {
    const db = openIndexDb({ home })
    const row = db.prepare("SELECT type FROM sqlite_master WHERE name = 'settings_effective'").get() as
      | { type: string }
      | undefined
    expect(row?.type).toBe('view')
  })

  it('FTS 三个触发器齐全（偏差 #14）', () => {
    const db = openIndexDb({ home })
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_search_index_%' ORDER BY name")
      .all() as { name: string }[]
    expect(rows.map((r) => r.name)).toEqual([
      'trg_search_index_delete',
      'trg_search_index_insert',
      'trg_search_index_update',
    ])
  })

  it('session_log_index 是一记录一行（含 byte_offset/byte_length，偏差 #4）', () => {
    const db = openIndexDb({ home })
    const cols = columnNames(db, 'session_log_index')
    expect(cols).toEqual(['session_id', 'seq', 'seq_last', 'kind', 'type', 'byte_offset', 'byte_length', 'created_at'])
  })

  it('tool_calls 没有 arguments 列，只有 args_digest（偏差 #8，安全红线）', () => {
    const db = openIndexDb({ home })
    const cols = columnNames(db, 'tool_calls')
    expect(cols).not.toContain('arguments')
    expect(cols).toContain('args_digest')
  })

  it('credentials_refs 没有 value 列（I7 的结构层保证）', () => {
    const db = openIndexDb({ home })
    expect(columnNames(db, 'credentials_refs')).not.toContain('value')
  })

  it('settings_kv.source_layer 的 CHECK 只允许 L2/L3/L4', () => {
    const db = openIndexDb({ home })
    const insert = (layer: string): void => {
      db.prepare(
        `INSERT INTO settings_kv (namespace, key, value_json, source_layer, scope, scope_ref, updated_at)
         VALUES ('ui', 'theme', '"dark"', ?, 'user', '', 1)`,
      ).run(layer)
    }
    expect(() => insert('L2')).not.toThrow()
    // L1 是内存层、L5/L6 是代码层——写进持久层就是 bug
    expect(() => insert('L1')).toThrow(/CHECK/)
    expect(() => insert('L6')).toThrow(/CHECK/)
  })

  it('file_changes.source 只允许 presentation-meta（派生而非扫盘，偏差 #9）', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', 't')
    const insert = (source: string): void => {
      db.prepare(
        `INSERT INTO file_changes (session_id, turn, path, change_kind, additions, deletions,
                                   tool_call_id, source, seq, created_at)
         VALUES ('S1', 1, 'src/a.ts', 'modify', 3, 1, 'call_1', ?, 5, 1)`,
      ).run(source)
    }
    expect(() => insert('presentation-meta')).not.toThrow()
    expect(() => insert('filesystem-scan')).toThrow(/CHECK/)
  })

  it('sessions.status 只接受四值（偏差 #3）', () => {
    const db = openIndexDb({ home })
    const insert = (status: string): void => {
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_key, created_at, updated_at, log_path, status)
         VALUES (?, 'k', 1, 1, 'p', ?)`,
      ).run('S-' + status, status)
    }
    expect(() => insert('idle')).not.toThrow()
    expect(() => insert('active')).toThrow(/CHECK/)
  })
})

describe('T1.2 连接与 pragma', () => {
  it('pragma 生效：WAL / foreign_keys / busy_timeout / temp_store', () => {
    const db = openIndexDb({ home })
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.pragma('temp_store', { simple: true })).toBe(2) // MEMORY
  })

  it('外键级联真的生效（删会话 → 子表行一起没）', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', 't')
    seedMessage(db, 'S1', 0, 0, 'user', '你好')
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages_projection').get()).toEqual({ c: 1 })
    db.prepare("DELETE FROM sessions WHERE session_id = 'S1'").run()
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages_projection').get()).toEqual({ c: 0 })
  })

  it('同一 home 复用同一连接（单例）', () => {
    expect(openIndexDb({ home })).toBe(openIndexDb({ home }))
  })
})

describe('T1.3 迁移器', () => {
  it('迁移到 SCHEMA_VERSION 并记录 checksum', () => {
    const db = openIndexDb({ home })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    const row = db.prepare('SELECT version, name, checksum FROM schema_migrations').get() as {
      version: number
      name: string
      checksum: string
    }
    expect(row.version).toBe(SCHEMA_VERSION)
    expect(row.checksum).toBe(checksumOf(MIGRATIONS[0]!.sql))
  })

  it('可重入：重复调用 applyMigrations 不报错也不重复写', () => {
    const db = openIndexDb({ home })
    const before = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()
    applyMigrations(db)
    applyMigrations(db)
    expect(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual(before)
  })

  it('checksum 不符 → 报错，拒绝继续（22 §8.2）', () => {
    const db = openIndexDb({ home })
    db.prepare("UPDATE schema_migrations SET checksum = 'sha256:deadbeef'").run()
    expect(() => applyMigrations(db)).toThrow(/checksum/)
  })

  it('库版本高于程序 → 报错并提示重建（22 §8.2）', () => {
    const db = openIndexDb({ home })
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (99, 'future', 1, 'x')").run()
    expect(() => applyMigrations(db)).toThrow(/高于本程序/)
  })

  it('迁移中途失败 → 整体回滚，版本不推进', () => {
    const db = openIndexDb({ home })
    applyMigrations(db, [{ version: 1, name: 'ok', sql: MIGRATIONS[0]!.sql }], 1)
    const boom: readonly { version: number; name: string; sql: readonly string[] }[] = [
      { version: 1, name: 'ok', sql: MIGRATIONS[0]!.sql },
      { version: 2, name: 'boom', sql: ['CREATE TABLE tmp_ok (a INTEGER)', 'THIS IS NOT SQL'] },
    ]
    expect(() => applyMigrations(db, boom, 2)).toThrow()
    expect(readSchemaVersion(db)).toBe(1)
    // 半成品表也不该留下（单事务回滚）
    const names = tableNames(db)
    expect(names).not.toContain('tmp_ok')
  })
})

describe('T1.4 建库 / 删库', () => {
  it('删掉 index.db* 后可一键重建出空表结构', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', 't')
    expect(describeIndexDb(home)).toEqual({ exists: true, schemaVersion: SCHEMA_VERSION, expectedVersion: SCHEMA_VERSION })

    const removed = dropIndexDb(home)
    expect(removed.length).toBeGreaterThan(0)
    for (const f of indexDbFiles(home)) expect(existsSync(f)).toBe(false)

    createEmptyIndexDb(home)
    expect(describeIndexDb(home).schemaVersion).toBe(SCHEMA_VERSION)
    const fresh = openIndexDb({ home })
    expect((fresh.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0)
  })
})

describe('T3.5 中文全文检索（方案 C：逐字预分词 + 前缀 AND）', () => {
  it('分词把汉字逐字切开，ASCII 词原样', () => {
    expect(segmentForFts('把 parse.ts 换成结构化解析')).toBe('把 parse.ts 换 成 结 构 化 解 析')
  })

  it('查询表达式：汉字单字与 ASCII 词各加 * 前缀，用 AND 连接', () => {
    expect(buildMatchQuery('解析')).toBe('解* AND 析*')
    expect(buildMatchQuery('parse 结构化')).toBe('parse* AND 结* AND 构* AND 化*')
    expect(buildMatchQuery('  ***  ')).toBe('')
  })

  it('2 字与 3 字以上中文都能命中（22 §3.13 原分词器命中 0）', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', '重构解析')
    seedMessage(db, 'S1', 0, 0, 'user', '把 parse.ts 换成结构化解析，测试全部通过')

    for (const q of ['解析', '测试', '通过', '结构化', 'parse']) {
      expect(searchMessages(db, q).length, `查询「${q}」应命中`).toBe(1)
    }
    expect(searchMessages(db, '登录')).toEqual([])
  })

  it('被 replace 遮蔽（is_active = 0）的消息搜不到，且原文仍在（22 §3.13）', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', 't')
    seedMessage(db, 'S1', 0, 0, 'user', '被压缩掉的旧内容')
    expect(searchMessages(db, '压缩').length).toBe(1)

    // 模拟 surface replace：标记 is_active = 0 与 replaced_by_seq
    db.prepare('UPDATE messages_projection SET is_active = 0, replaced_by_seq = 9 WHERE session_id = ? AND surface_index = 0').run('S1')
    expect(searchMessages(db, '压缩')).toEqual([])
    // 原始事实仍在
    expect((db.prepare('SELECT summary FROM messages_projection').get() as { summary: string }).summary).toBe(
      '被压缩掉的旧内容',
    )
  })

  it('summary 保原样、fts_text 保分词形态（UI 文本不被污染）', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', 't')
    seedMessage(db, 'S1', 0, 0, 'user', '结构化解析')
    const row = db.prepare('SELECT summary, fts_text FROM messages_projection').get() as {
      summary: string
      fts_text: string
    }
    expect(row.summary).toBe('结构化解析')
    expect(row.fts_text).toBe('结 构 化 解 析')
  })

  it('默认排除软删会话（22 未决项倾向）', () => {
    const db = openIndexDb({ home })
    seedSession(db, 'S1', 't')
    seedMessage(db, 'S1', 0, 0, 'user', '结构化解析')
    db.prepare('UPDATE sessions SET deleted_at = 1 WHERE session_id = ?').run('S1')
    expect(searchMessages(db, '解析')).toEqual([])
    expect(searchMessages(db, '解析', { includeDeleted: true }).length).toBe(1)
  })
})
