/**
 * 前缀缓存审计：从会话日志量化「有多少请求本可以命中缓存」。
 *
 * ## 为什么需要这个脚本
 *
 * 供应商按**前缀**命中缓存。我们每次请求都会把 `request/header` 写进日志，
 * 里面带 `systemFingerprint` 与 `toolsFingerprint`——**这两个值一变，
 * 缓存前缀就断了，后面整段历史全价重算**。
 *
 * 这个 bug 真实发生过：系统提示词末尾每一步都注入新的 ISO 时间戳，
 * 导致一个回合里每一次工具续步都在重算历史，最终把免费额度烧光。
 * 当时账单先报警、日志里其实早有指纹变化，只是没人看。
 *
 * 所以把"看指纹"做成一条命令：任何一次注入只要让前缀失效，这里立刻能算出来。
 *
 * 用法：
 *   node scripts/audit-prefix-cache.mjs               # 最近 20 个会话
 *   node scripts/audit-prefix-cache.mjs --limit 50
 *   node scripts/audit-prefix-cache.mjs --session <id>
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) || 20 : 20
const sessionIndex = process.argv.indexOf('--session')
const onlySession = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined

const { createDesktopModelFeature } = await import('../packages/bundle/lcode-desktop/src/index.ts')
const { createAgentRuntime } = await import('../packages/bundle/lcode-desktop/src/agent-runtime.ts')
const { openIndexDb } = await import('../packages/session-persistence/session-persistence-sqlite/src/db.ts')

const home = join(homedir(), '.lcode')
const feature = await createDesktopModelFeature({ home })
const runtime = await createAgentRuntime({ home, services: feature.services })

console.log('=== 前缀缓存审计 ===')
console.log('Lcode Home:', home)
console.log()

/**
 * 从索引库直接统计缓存命中（迁移 v3 起可用）。
 *
 * 比翻日志快，而且**不依赖会话是否还在**——只要行还在就能算。
 * 注意：会话被删除时子表跟着级联删除，所以"删过的会话"这里也看不到。
 */
function cacheStatsFromDb() {
  const db = openIndexDb({ home, readonly: true })
  try {
    const rows = db
      .prepare(
        `SELECT s.session_id, s.title,
                SUM(COALESCE(st.input_tokens, 0)) AS input,
                SUM(COALESCE(st.cache_read_tokens, 0)) AS cache_read,
                COUNT(st.step) AS steps
           FROM sessions s JOIN steps st ON st.session_id = s.session_id
          WHERE st.input_tokens IS NOT NULL
          GROUP BY s.session_id
          ORDER BY input DESC`,
      )
      .all()
    return rows
  } finally {
    db.close()
  }
}

try {
  const items = onlySession === undefined
    ? (await runtime.sessions.list({ limit })).items
    : [{ session_id: onlySession, title: '(指定会话)' }]

  let grandRequests = 0
  let grandReusable = 0

  for (const item of items) {
    let events
    try {
      // 会话要先打开（`meta` 会 ensureOpen）才能读事件；`sessionServiceFor` 对
      // 未打开的会话直接抛 ES-SESSION_NOT_FOUND。
      await runtime.sessions.meta({ session_id: item.session_id })
      events = runtime.sessions.sessionServiceFor(item.session_id).events()
    } catch {
      continue
    }
    const headers = events.filter((e) => e.type === 'request/header')
    if (headers.length === 0) continue

    /*
     * 相邻两次请求的前缀可分三类：
     * - system 指纹相同 → 系统提示词没变（缓存前缀至少在系统段是连续的）
     * - system 变了但 tools 没变 → 系统段里动态注入在变
     * - 两者都变 → 工具表也在变（更糟）
     */
    let systemSame = 0
    let systemChanged = 0
    let toolsChanged = 0
    const changedReasons = []
    for (let i = 1; i < headers.length; i += 1) {
      const prev = headers[i - 1].data.header
      const cur = headers[i].data.header
      const sameSystem = prev.systemFingerprint === cur.systemFingerprint
      const sameTools = prev.toolsFingerprint === cur.toolsFingerprint
      if (sameSystem) systemSame += 1
      else {
        systemChanged += 1
        if (changedReasons.length < 3) changedReasons.push({ prev: prev.systemFingerprint, cur: cur.systemFingerprint })
      }
      if (!sameTools) toolsChanged += 1
    }

    grandRequests += headers.length
    grandReusable += systemSame

    const total = headers.length
    console.log(`会话 ${item.session_id.slice(0, 10)}… | ${String(item.title ?? '').slice(0, 28)}`)
    console.log(`  请求 ${total} 次｜系统提示词未变 ${systemSame}｜变了 ${systemChanged}｜工具表变了 ${toolsChanged}`)
    if (systemChanged > 0) {
      console.log(`  ⚠ 系统提示词在 ${systemChanged}/${total - 1} 个相邻请求之间发生了变化 → 缓存前缀断在这里`)
    }
    console.log()
  }

  console.log(`合计请求 ${grandRequests} 次，其中 ${grandReusable} 次与上一次系统提示词相同`)
  if (grandRequests > 1) {
    const rate = Math.round((grandReusable / (grandRequests - 1)) * 100)
    console.log(`前缀可复用率（系统段）: ${rate}%（修复后应接近 100%，只有 todo/注入变化时才低于它）`)
  }

  // ── 缓存命中量（迁移 v3 起，从索引库直接算） ──
  console.log('\n=== 缓存命中量（来自 steps.cache_read_tokens） ===')
  const stats = cacheStatsFromDb()
  if (stats.length === 0) {
    console.log('索引里还没有带 usage 的步骤（或模型不回传 usage——qwen 系常见）。')
  } else {
    let ti = 0
    let tc = 0
    for (const row of stats.slice(0, 20)) {
      ti += row.input
      tc += row.cache_read
      const pct = row.input === 0 ? 0 : Math.round((row.cache_read / row.input) * 100)
      console.log(
        `  ${String(row.session_id).slice(0, 10)}… | ${String(row.title ?? '').slice(0, 22).padEnd(22)} | 步${String(row.steps).padStart(3)} | 输入${String(row.input).padStart(9)} | 命中${String(row.cache_read).padStart(9)} | ${pct}%`,
      )
    }
    const total = ti === 0 ? 0 : Math.round((tc / ti) * 100)
    console.log(`  合计：输入 ${ti}，命中 ${tc}，命中率 ${total}%`)
    if (total < 50) console.log('  ⚠ 命中率偏低：检查系统提示词是否每步都变（见 docs/09 §3.2.1）')
  }
} finally {
  await runtime.dispose()
  feature.dispose()
}
