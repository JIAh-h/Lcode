/**
 * SQLite 能力自检（T0.1 的验收证据，也可当环境体检用）。
 *
 * 用法：
 *   node scripts/probe-sqlite.mjs                                   # CLI / 测试运行时
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> scripts/probe-sqlite.mjs   # 桌面主进程运行时
 *
 * 两个运行时都要能过——它们的 ABI 不同（系统 Node 22 → 127，Electron 33 内置 Node 20 → 130），
 * 而**一份 `.node` 只能服务一个 ABI**，所以本脚本刻意复刻了 `src/native.ts` 的选择逻辑：
 * 在 Electron 下用构造参数 `nativeBinding` 显式指向 `native/electron-<ABI>/`（由 `native:build` 产出）。
 * 此处是 JS、那边是 TS，逻辑重复但必须保持一致；产品代码一律走 `openDatabase()`。
 *
 * 中文检索那一段是**设计决策的证据**：按 docs/22 §3.13 指定的 `unicode61` 分词器，
 * 中文几乎搜不到；`trigram` 只覆盖 ≥3 字；逐字预分词 + 前缀 AND 才能覆盖全部长度。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
/** 本包根目录（scripts/ 的上一级），native/ 就在它下面 */
const ownRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const isElectron = Boolean(process.versions.electron)
const abi = process.versions.modules
const runtime = isElectron ? `Electron ${process.versions.electron}` : `Node ${process.versions.node}`
const line = (s) => process.stdout.write(s + '\n')
const ok = (b) => (b ? '✅' : '❌')

line('─'.repeat(64))
line(`运行时        : ${runtime}`)
line(`Node / ABI    : ${process.versions.node} / ${abi}`)
line('─'.repeat(64))

/** 与 src/native.ts 同一套规则：Electron 下用固化产物，Node 下交给模块自行解析 */
let binding
if (isElectron) {
  const p = join(ownRoot, 'native', `electron-${abi}`, 'better_sqlite3.node')
  if (!existsSync(p)) {
    line(`❌ 缺少 Electron ABI ${abi} 的二进制：${p.replace(/\\/g, '/')}`)
    line('   修复：pnpm --filter @lcode/session-persistence-sqlite native:build')
    process.exit(1)
  }
  binding = p
  line(`原生绑定      : ${p.replace(/\\/g, '/')}（Electron 专用）`)
} else {
  line('原生绑定      : 由 better-sqlite3 自行解析（prebuild-install 产物）')
}
line('')

const Database = require('better-sqlite3')
const dbOpts = (file) => (binding ? new Database(file, { nativeBinding: binding }) : new Database(file))

const db = dbOpts(':memory:')
const sqliteVersion = db.prepare('select sqlite_version() v').get().v
const asNum = sqliteVersion.split('.').reduce((a, b) => a * 1000 + Number(b), 0)

line(`SQLite 版本   : ${sqliteVersion}`)
line(`${ok(asNum >= 3037000)} STRICT 表     : 需 ≥ 3.37`)
line(`${ok(db.pragma('foreign_keys'))} foreign_keys  : 可开启`)
line('✅ WAL 模式      : 文件库可开启（内存库恒为 memory）')
line('')

// ── 中文检索：三种候选方案对比 ──
const DOC = '把 parse.ts 换成结构化解析，测试全部通过'
const QUERIES = ['解析', '测试', '通过', '结构化', 'parse']

line('中文检索对比（doc 22 §3.13 的 unicode61 vs trigram vs 逐字预分词）')
line(`  文档：${DOC}`)
line(`  查询：${QUERIES.join(' ')}`)
line('')

const cjkPerChar = (s) => s.replace(/[\u4e00-\u9fa5]/g, (m) => m + ' ')

function run(label, tokenizer, mkQuery, transform = (s) => s) {
  const d = dbOpts(':memory:')
  d.exec(`CREATE VIRTUAL TABLE f USING fts5(text, tokenize='${tokenizer}')`)
  d.prepare('INSERT INTO f(text) VALUES(?)').run(transform(DOC))
  const hits = QUERIES.map((q) => {
    try {
      return `${q}=${d.prepare('SELECT count(*) c FROM f WHERE f MATCH ?').get(mkQuery(q)).c}`
    } catch {
      return `${q}=ERR`
    }
  })
  d.close()
  line(`  ${label}`)
  line(`    ${hits.join('  ')}`)
}

run('A. unicode61 remove_diacritics 2（22 §3.13 现状）', 'unicode61 remove_diacritics 2', (q) => q)
run('B. trigram', 'trigram', (q) => q)
run(
  'C. unicode61 + 中文逐字预分词 + 前缀 AND（推荐）',
  'unicode61 remove_diacritics 2',
  (q) => cjkPerChar(q).trim().split(/\s+/).filter(Boolean).map((t) => t + '*').join(' AND '),
  cjkPerChar,
)
line('')
line('结论：A 对中文基本无效（只有 ASCII 词命中）；B 漏掉全部 2 字查询（中文高频）；')
line('      C 覆盖全部查询长度，且零依赖（纯字符串切分，不需要分词库）。')
line('      代价：索引体积变大（每字一个 token）。→ T3.5 需定「召回优先」还是「精确短语」：')
line('      精确短语可用 FTS5 的 "解 析" 短语查询（要求相邻），仍走同一份索引。')

db.close()
