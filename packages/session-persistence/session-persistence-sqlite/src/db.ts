import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { indexDbPath } from '@lcode/util'
import { SQLITE_PRAGMAS } from './ddl.ts'
import { applyMigrations } from './migrations.ts'
import { openDatabase } from './native.ts'

/**
 * 索引库的连接与初始化（文档 22 §3.0；实施计划 T1.2）。
 *
 * 三件事：① 目录按需创建 ② pragma **按序**执行（WAL 必须在其它写操作前）③ 迁移到当前版本。
 * 单例复用：同一 `index.db` 路径共用一个连接——SQLite 同一进程内多连接会放大
 * `SQLITE_BUSY`，而 desktop 与 CLI 之间靠 `busy_timeout = 5000` 协调。
 */

export interface OpenIndexDbOptions {
  /** Lcode Home（22 §2） */
  readonly home: string
  /** 只读打开：跳过 journal_mode/synchronous（只读库上设 WAL 会报错），也跳过迁移 */
  readonly readonly?: boolean | undefined
}

const connections = new Map<string, BetterSqlite3.Database>()

/** pragma 执行：`better-sqlite3` 的 `pragma()` 不接受 `PRAGMA ` 前缀与结尾分号，需剥掉 */
function pragmaBody(statement: string): string {
  return statement
    .replace(/^\s*PRAGMA\s+/i, '')
    .replace(/;\s*$/, '')
    .trim()
}

/** 按 22 §3.0 的顺序应用 pragma */
export function applyPragmas(db: BetterSqlite3.Database, opts: { readonly?: boolean } = {}): void {
  for (const statement of SQLITE_PRAGMAS) {
    const body = pragmaBody(statement)
    // 只读连接不能改 journal_mode / synchronous（SQLite 会拒绝）
    if (opts.readonly === true && /^journal_mode|^synchronous/i.test(body)) continue
    db.pragma(body)
  }
}

/**
 * 打开（必要时创建）索引库。**产品代码一律走这里**——它保证 pragma 与迁移都已就绪。
 */
export function openIndexDb(opts: OpenIndexDbOptions): BetterSqlite3.Database {
  const file = indexDbPath(opts.home)
  const cached = connections.get(file)
  if (cached !== undefined && cached.open) return cached
  connections.delete(file)

  if (opts.readonly !== true) mkdirSync(dirname(file), { recursive: true })
  const db = openDatabase(file, opts.readonly === true ? { readonly: true, fileMustExist: true } : {})
  applyPragmas(db, opts.readonly === true ? { readonly: true } : {})
  if (opts.readonly !== true) applyMigrations(db)
  connections.set(file, db)
  return db
}

/** 关闭并移出单例表（进程退出 / 测试清理用） */
export function closeIndexDb(home: string): void {
  const file = indexDbPath(home)
  const db = connections.get(file)
  if (db === undefined) return
  connections.delete(file)
  if (db.open) db.close()
}

/** 关闭全部连接（测试隔离用） */
export function closeAllIndexDbs(): void {
  for (const [file, db] of connections) {
    connections.delete(file)
    if (db.open) db.close()
  }
}
