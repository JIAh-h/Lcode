import { createContext } from '@lcode/context'
import { createDesktopModelFeature } from '@lcode/lcode-desktop'
import { LocalSessionsApi } from '@lcode/session-api'
import { initZstd } from '@lcode/session-persistence-jsonl'
import { resolveLcodeHome } from '@lcode/util'

/**
 * doctor：环境自检（23 §5 / §12 排障）。
 *
 * `--index` 是**数据层体检**（22 §1.3 / 实施计划 T6.4）：逐会话比对
 * `sessions.log_revision` 与真实日志文件，报出需要重索引的会话。
 * 它是**只读**的——只 stat 文件、只读 `sessions` 表，不改任何东西；处置由用户决定。
 *
 * `--storage` 是**存储占用 + 保留策略维护**（22 §9.2 / T6.2）：报告分项占用，
 * 并清理到期的回收站条目与超限的缓存。**它绝不删会话。**
 *
 * `model` 已复用桌面端模型装配；`sandbox` 仍是占位，等待批次 ⑥ 的三平台实现。
 */

export type DoctorMode = 'basic' | 'model' | 'sandbox' | 'index' | 'storage'

/** `--index` 的退出码约定：0 = 无需处理；1 = 有需要处理的会话（可被脚本判定） */
const EXIT_NEEDS_ATTENTION = 1

/**
 * CLI 的装配入口：初始化 zstd（22 §9.4）。
 *
 * WASM 模块的初始化是异步的，而 `loadLog()` 是同步 API —— 所以必须在**用之前**
 * 显式 await 一次。这就是"装配层负责把异步前置条件解决掉，让底下保持同步"的落点。
 * 失败**不抛**：没有 zstd 时压缩/读取归档会各自给出可路由的错误，不该让整个 CLI 起不来。
 */
async function initCliRuntime(): Promise<void> {
  try {
    await initZstd()
  } catch (err) {
    console.error(`⚠ zstd 初始化失败：${err instanceof Error ? err.message : String(err)}\n  压缩归档与会话还原将不可用。`)
  }
}

export async function runDoctor(mode: DoctorMode): Promise<number> {
  await initCliRuntime()
  if (mode === 'index') return runIndexDoctor()
  if (mode === 'storage') return runStorageDoctor()
  if (mode === 'model') return runModelDoctor()
  return runEnvironmentDoctor(mode)
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/**
 * `doctor --storage`：存储占用 + 保留策略维护（22 §9.2；M-DATA-04 存储占用可视化）。
 *
 * **它绝不删会话**：`prune` 只清 `trash/` 里到期的条目与 `cache/`，而这两者
 * 都是"可重建或已被用户显式删除"的东西。会话日志只会在用户**显式** `lcode delete` 时移动。
 */
async function runStorageDoctor(): Promise<number> {
  const home = resolveLcodeHome()
  console.log(`Lcode doctor · 存储占用 · Lcode Home = ${home}`)

  const api = new LocalSessionsApi({ home })
  try {
    const before = await api.storageUsage()
    const trash = await api.listTrash()

    console.log('\n分项占用：')
    console.log(`  会话日志   ${formatBytes(before.sessions).padStart(10)}   （不自动删除，只由你显式删除）`)
    console.log(`  索引       ${formatBytes(before.index).padStart(10)}   （可重建：lcode index rebuild）`)
    console.log(`  回收站     ${formatBytes(before.trash).padStart(10)}   ${trash.items.length} 项，7 天后自动清除`)
    console.log(`  缓存       ${formatBytes(before.cache).padStart(10)}   （可清空，丢了也能重建）`)
    console.log(`  导出       ${formatBytes(before.exports).padStart(10)}`)
    console.log(`  ────────────────────`)
    console.log(`  合计       ${formatBytes(before.total).padStart(10)}`)

    const prune = await api.prune()
    const changed =
      prune.trash.removed > 0 || prune.cache.evicted > 0 || prune.cache.freedBytes > 0
    if (changed) {
      console.log('\n保留策略已执行：')
      if (prune.trash.removed > 0) {
        console.log(`  清理了 ${prune.trash.removed} 个到期回收站条目，释放 ${formatBytes(prune.trash.freedBytes)}`)
      }
      if (prune.cache.evicted > 0) {
        console.log(`  按 LRU 淘汰 ${prune.cache.evicted} 个缓存条目，释放 ${formatBytes(prune.cache.freedBytes)}`)
      }
      console.log(`  清理后合计 ${formatBytes(prune.usage.total)}`)
    } else {
      console.log('\n✓ 无需清理（回收站无到期条目，缓存未超上限）。')
    }
    if (prune.cache.stillOverLimit) {
      console.log(
        `\n⚠ 缓存清理后仍有 ${formatBytes(prune.cache.remainingBytes)}，超过 2GB 上限——` +
          '可用 `lcode doctor --storage --purge-cache` 彻底清空（绝不影响会话）。',
      )
    }
    return 0
  } finally {
    await api.close()
  }
}

async function runIndexDoctor(): Promise<number> {
  const home = resolveLcodeHome()
  console.log(`Lcode doctor · 索引体检 · Lcode Home = ${home}`)

  const api = new LocalSessionsApi({ home })
  try {
    const report = await api.doctorIndex()

    if (!report.dbExists) {
      console.log('\n索引库不存在。')
      if (report.note !== undefined) console.log(`  ${report.note}`)
      console.log(`  未索引的会话：${report.findings.length}`)
      return EXIT_NEEDS_ATTENTION
    }

    console.log(`索引 schema 版本：${report.schemaVersion ?? '未知'}`)
    if (report.findings.length === 0) {
      console.log('\n✓ 索引与全部会话日志一致，无需处理。')
      return 0
    }

    console.log(`\n发现 ${report.findings.length} 个会话与索引不一致：\n`)
    for (const finding of report.findings) {
      console.log(`  [${finding.reason}] ${finding.sessionId}`)
      if (finding.logPath !== null) console.log(`          ${finding.logPath}`)
    }

    // 按判定分组给建议。"missing" 单独说：重建救不回它，多半要人工看一眼。
    const counts = new Map<string, number>()
    for (const finding of report.findings) counts.set(finding.reason, (counts.get(finding.reason) ?? 0) + 1)
    console.log('\n建议：')
    if (report.findings.some((f) => f.reason !== 'missing')) {
      console.log('  运行 `lcode index rebuild` 重建索引（幂等；JSONL 是权威真相，重建永远安全）。')
    }
    if (counts.get('missing') !== undefined) {
      console.log(
        `  有 ${counts.get('missing')} 个会话在索引里有行、但日志文件已不在——` +
          '重建不会恢复它们，请确认是手工删除还是文件被移走。',
      )
    }
    if (report.note !== undefined) console.log(`  ${report.note}`)
    return EXIT_NEEDS_ATTENTION
  } finally {
    await api.close()
  }
}

async function runEnvironmentDoctor(mode: 'basic' | 'model' | 'sandbox'): Promise<number> {
  const ctx = createContext()
  console.log(`Lcode doctor · Node ${process.version} · ${process.platform} ${process.arch}`)

  if (mode === 'sandbox') {
    console.log('\n[sandbox] 骨架阶段：沙箱实现随批次 ⑥ 落地')
    console.log(
      `  平台机制：${process.platform === 'darwin' ? 'sandbox config' : process.platform === 'linux' ? 'Landlock+seccomp' : 'AppContainer'}`,
    )
  }

  void ctx
  return 0
}

/** 模型诊断与设置页共用同一套装配；只输出来源和引用，不输出凭据值。 */
async function runModelDoctor(): Promise<number> {
  const feature = await createDesktopModelFeature({ home: resolveLcodeHome() })
  try {
    const custom = await feature.listCustom()
    const current = await feature.api.getDefault()
    console.log(`Lcode doctor · 模型 · 配置来源：本机设置`)
    console.log(`  已注册供应商：${custom.length}`)
    for (const item of custom) {
      const selected = current?.provider === item.name && current.model === item.model ? '（当前默认）' : ''
      console.log(`  ${item.label} · ${item.model}${selected}`)
      console.log(`    地址：${item.base_url}`)
      console.log(`    密钥：引用 ${item.api_key_ref}（值不会显示）`)
    }
    if (current === undefined) {
      console.log('  默认模型：未设置')
      return 1
    }
    console.log(`  默认模型：${current.provider} / ${current.model}（来源：本机设置）`)
    return 0
  } finally {
    feature.dispose()
  }
}
