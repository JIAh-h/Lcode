// T7.3 / T7.4：真实 Lcode Home 的索引体积与日志体积基线。
// 该脚本只读文件系统和 SQLite，不会执行迁移或写入，适合本地和 CI 使用。
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const home = process.env['LCODE_HOME']?.trim() || join(process.env['USERPROFILE'] || process.env['HOME'] || process.cwd(), '.lcode')
const sessionsRoot = join(home, 'sessions')
const indexPath = join(home, 'index.db')
const MIN_LOG_BYTES_FOR_RATIO = 1024 * 1024
const BOOTSTRAP_INDEX_MAX_BYTES = 512 * 1024

function bytesOf(path) {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (stat.isFile()) return stat.size
  return readdirSync(path).reduce((total, name) => total + bytesOf(join(path, name)), 0)
}

const logBytes = bytesOf(sessionsRoot)
const indexArtifacts = ['index.db', 'index.db-wal', 'index.db-shm'].map((name) => ({
  name,
  bytes: bytesOf(join(home, name)),
}))
// WAL/SHM 是运行中的暂存文件，不代表 checkpoint 后的长期索引容量；单独报告，不纳入长期容量门禁。
const indexBytes = indexArtifacts.find((item) => item.name === 'index.db')?.bytes ?? 0
const ratio = logBytes === 0 ? 0 : indexBytes / logBytes
console.log(`Lcode Home: ${home}`)
console.log(`日志体积：${logBytes} bytes`)
console.log(
  `索引体积：${indexBytes} bytes（稳定主库 index.db；${
    indexArtifacts
      .filter((item) => item.name !== 'index.db' && item.bytes > 0)
      .map((item) => `${item.name}=${item.bytes}，运行中暂存`)
      .join(', ') || '无 WAL/SHM'
  }）`,
)
console.log(`索引/日志：${(ratio * 100).toFixed(2)}%`)

if (existsSync(indexPath)) printSqliteBreakdown(indexPath)

if (logBytes > 0) {
  if (logBytes < MIN_LOG_BYTES_FOR_RATIO) {
    console.log(`小样本门槛：日志 < ${MIN_LOG_BYTES_FOR_RATIO} bytes，稳定主库预算 <= ${BOOTSTRAP_INDEX_MAX_BYTES} bytes`)
    if (indexBytes > BOOTSTRAP_INDEX_MAX_BYTES) {
      console.error(`✗ T7.3 失败：小样本稳定主库超过 ${BOOTSTRAP_INDEX_MAX_BYTES} bytes 预算`)
      process.exit(1)
    }
  } else if (ratio > 0.15) {
    console.error('✗ T7.3 失败：索引体积超过日志体积的 15%')
    process.exit(1)
  }
}
console.log('✓ T7.3/T7.4 体积门禁通过（无日志时仅记录空基线）')

function printSqliteBreakdown(path) {
  const Database = loadDatabase()
  if (Database === undefined) {
    console.log('SQLite 容量明细：未找到 better-sqlite3，跳过表级分解')
    return
  }
  let db
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    const pageCount = Number(db.pragma('page_count')[0]?.page_count ?? 0)
    const pageSize = Number(db.pragma('page_size')[0]?.page_size ?? 0)
    const freelistCount = Number(db.pragma('freelist_count')[0]?.freelist_count ?? 0)
    console.log(
      `SQLite 容量：pages=${pageCount}, page_size=${pageSize}, freelist_pages=${freelistCount}, allocated=${pageCount * pageSize} bytes`,
    )
    const rows = db.prepare('select name, sum(pgsize) as bytes from dbstat group by name order by bytes desc limit 8').all()
    console.log(`SQLite 最大对象：${rows.map((row) => `${row.name}=${row.bytes} bytes`).join(', ') || '无'}`)
  } catch (error) {
    console.log(`SQLite 容量明细：读取失败（${error instanceof Error ? error.message : String(error)}）`)
  } finally {
    db?.close()
  }
}

function loadDatabase() {
  const require = createRequire(import.meta.url)
  const candidates = [
    resolve(process.cwd(), 'apps/desktop/node_modules/better-sqlite3'),
    resolve(import.meta.dirname, '../apps/desktop/node_modules/better-sqlite3'),
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // 当前环境可能只安装了不含桌面依赖的包，容量比例检查仍可用。
    }
  }
  return undefined
}
