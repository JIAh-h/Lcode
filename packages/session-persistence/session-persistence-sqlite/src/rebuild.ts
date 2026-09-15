import { existsSync, unlinkSync } from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import { indexDbPath } from '@lcode/util'
import { closeIndexDb, openIndexDb } from './db.ts'
import { SCHEMA_VERSION } from './ddl.ts'
import { readSchemaVersion } from './migrations.ts'
import { openDatabase } from './native.ts'

/**
 * 建库 / 删库（文档 22 §1.3；实施计划 T1.4）。
 *
 * 本文件是 `lcode index rebuild` 的**基础件**：删掉索引库永远安全（22 §1.1 硬性推论③），
 * 因为 `index.db` 只是 JSONL 的派生索引。T3.6 会在其上加「JSONL → SQLite 全量重建」。
 */

/** `index.db` 及其 WAL 附属文件；删库必须三个一起删，否则残留 `-wal` 会被当成新库继续用 */
export function indexDbFiles(home: string): string[] {
  const file = indexDbPath(home)
  return [file, `${file}-wal`, `${file}-shm`]
}

/** 删除索引库文件，返回实际删掉的路径 */
export function dropIndexDb(home: string): string[] {
  closeIndexDb(home) // Windows 上被占用的文件删不掉，必须先关连接
  const removed: string[] = []
  for (const file of indexDbFiles(home)) {
    if (existsSync(file)) {
      unlinkSync(file)
      removed.push(file)
    }
  }
  return removed
}

/** 建出一个**空表结构**的索引库（迁移会自动建全部表/索引/触发器/视图） */
export function createEmptyIndexDb(home: string): void {
  openIndexDb({ home })
}

export interface IndexDbStatus {
  readonly exists: boolean
  /** 库内 `schema_migrations` 的最大版本；库不存在为 null，空库为 0 */
  readonly schemaVersion: number | null
  /** 本程序期望的版本（`SCHEMA_VERSION`） */
  readonly expectedVersion: number
}

/**
 * 体检：库是否存在、schema 版本是多少。**不迁移、不抛错**——
 * 版本不匹配的处置（`index rebuild`）由调用方决定（22 §8.2）。
 */
export function describeIndexDb(home: string): IndexDbStatus {
  const file = indexDbPath(home)
  if (!existsSync(file)) return { exists: false, schemaVersion: null, expectedVersion: SCHEMA_VERSION }
  const db: BetterSqlite3.Database = openDatabase(file, { readonly: true, fileMustExist: true })
  try {
    return { exists: true, schemaVersion: readSchemaVersion(db), expectedVersion: SCHEMA_VERSION }
  } finally {
    db.close()
  }
}
