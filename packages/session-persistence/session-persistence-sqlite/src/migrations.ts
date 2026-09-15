import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { ERROR_CODES, LcodeErrorImpl, nowEpochMs } from '@lcode/util'
import { DDL_STATEMENTS, SCHEMA_NAME, SCHEMA_VERSION } from './ddl.ts'

/**
 * 索引结构迁移（文档 22 §8；实施计划 T1.3）。
 *
 * 三条纪律，全部来自 22 §8.2：
 * 1. **未知版本报错而非尽力解析**：`version > 程序` → 抛错并**拒绝写入**
 *    （索引可丢，让用户 `lcode index rebuild` 远比让旧程序悄悄写错数据划算）。
 * 2. **checksum 校验**：已应用迁移的 checksum 与代码内不一致 → 报错（脚本被篡改/漂移）。
 * 3. **单事务 + 可重入**：每步以 `INSERT OR IGNORE` 起头，失败整体回滚，`schema_migrations` 不推进。
 *
 * 注：21 §6.2 没有专给"索引版本/校验失败"的码，这里统一用 `ES-FORMAT_UNSUPPORTED`
 * （语义最接近：「这个格式/版本我处理不了，请升级或重建」），并在 `message` 里区分具体原因。
 */

export interface Migration {
  readonly version: number
  readonly name: string
  /** 该迁移的 SQL 语句（顺序执行）；checksum 即其内容摘要 */
  readonly sql: readonly string[]
}

/** 迁移清单：新增迁移**只追加**，不改已发布的项（22 §8.3「只增不改」） */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: SCHEMA_NAME, sql: DDL_STATEMENTS },
]

/** 迁移脚本内容的 sha256（`schema_migrations.checksum`） */
export function checksumOf(sql: readonly string[]): string {
  return 'sha256:' + createHash('sha256').update(sql.join(';\n')).digest('hex')
}

/** 引导建表：`schema_migrations` 本身不能依赖迁移来创建（先有鸡还是先有蛋） */
export function ensureMigrationsTable(db: BetterSqlite3.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL,
    checksum   TEXT    NOT NULL
  )`)
}

interface MigrationRow {
  readonly version: number
  readonly name: string
  readonly checksum: string
}

/** 当前库的 schema 版本；空库返回 0 */
export function readSchemaVersion(db: BetterSqlite3.Database): number {
  ensureMigrationsTable(db)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined
  return row?.v ?? 0
}

function fail(message: string, userMessage: string): never {
  throw new LcodeErrorImpl({
    code: ERROR_CODES.ES_FORMAT_UNSUPPORTED,
    message,
    userMessage,
    retryable: false,
  })
}

/**
 * 把库迁移到 `target`（默认代码里的 `SCHEMA_VERSION`）。
 * 幂等：已应用过的版本不会重复执行；重复调用安全。
 */
export function applyMigrations(
  db: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): void {
  ensureMigrationsTable(db)
  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as MigrationRow[]
  const current = rows.length > 0 ? (rows[rows.length - 1]?.version ?? 0) : 0

  if (current > target) {
    // 22 §8.2：库由更新版本的 Lcode 写入 → 拒绝，不尽力解析
    fail(
      `索引库的 schema 版本 ${current} 高于本程序支持的 ${target}`,
      '这个索引是由更新版本的 Lcode 写入的。请升级 Lcode，或运行 `lcode index rebuild` 重建索引。',
    )
  }

  for (const row of rows) {
    const spec = migrations.find((m) => m.version === row.version)
    if (spec === undefined) {
      fail(
        `索引库中存在本程序不认识的迁移版本 ${row.version}（${row.name}）`,
        '索引结构与本程序不匹配。请运行 `lcode index rebuild` 重建索引。',
      )
    }
    const expected = checksumOf(spec.sql)
    if (expected !== row.checksum) {
      // 22 §8.2：脚本被篡改 / 漂移 → 拒绝启动迁移
      fail(
        `迁移 ${row.version}（${row.name}）的 checksum 不符：库内 ${row.checksum}，代码内 ${expected}`,
        '索引结构定义与记录不一致（可能被改动过）。请运行 `lcode index rebuild` 重建索引。',
      )
    }
  }

  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
  for (const migration of pending) {
    const step = db.transaction((): void => {
      // ① INSERT OR IGNORE 幂等防护 ② 执行 SQL ③ 同一事务提交（22 §8.3）
      db.prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, nowEpochMs(), checksumOf(migration.sql))
      for (const statement of migration.sql) db.exec(statement)
    })
    step()
  }
}
