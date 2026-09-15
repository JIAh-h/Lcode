import { LocalSessionsApi } from '@lcode/session-api'
import type { ExportFormat, SessionMeta } from '@lcode/session-api'
import { initZstd } from '@lcode/session-persistence-jsonl'
import { resolveLcodeHome } from '@lcode/util'
import { formatBytes } from './doctor.ts'

/**
 * `lcode sessions …` / `lcode export` / `lcode delete|restore|purge|trash`
 * ——会话的日常操作（22 §9.3 / §9.5）。
 *
 * 这一组命令存在的意义：**在桌面端 IPC（docs/24 T5.3）接线之前，数据层也要能被真的用起来**。
 * 它们全部走与桌面端**同一套** `sessions.*` 契约，所以这里验过的行为，桌面端接线后自动成立。
 *
 * 一条贯穿的纪律：**删除前先提示导出**。`purge` 不带 `--exported` / `--force` 会被拒。
 */

const USAGE = `lcode sessions — 会话操作

  lcode sessions list [--workspace <dir>] [--archived]
  lcode sessions show <id>
  lcode export <id> [--format jsonl|md] [--out <dir>]
  lcode export --all [--format jsonl|md] [--out <dir>]
  lcode delete <id>            软删（从列表隐藏，文件保留）
  lcode restore <id>           撤销软删
  lcode purge <id> --exported  硬删（移入回收站，7 天后清除）
  lcode purge <id> --force     硬删且明确不要备份（危险）
  lcode trash [--empty]        查看回收站 / 清空回收站
  lcode archive [--check]      压缩归档空闲 ≥30 天的会话（22 §9.2）`

interface Parsed {
  readonly command: string
  readonly positional: string[]
  readonly flags: Map<string, string | true>
}

export function parseSessionArgs(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    // 只有"后面还跟着一个非 -- 开头的词"时才当取值，否则视为布尔开关
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      i++
    } else {
      flags.set(name, true)
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags }
}

/** 一行的会话摘要（列表与 show 共用） */
function summarize(meta: SessionMeta): string {
  const when = new Date(meta.updated_at).toISOString().replace('T', ' ').slice(0, 19)
  const title = meta.title === '' ? '(无标题)' : meta.title
  const flags = [
    meta.deleted_at === null ? '' : '已删除',
    meta.archived_at === null ? '' : '已归档',
  ]
    .filter((f) => f !== '')
    .join(',')
  return `${meta.session_id}  ${when}  ${String(meta.last_seq + 1).padStart(5)} 步  ${title}${flags === '' ? '' : `  [${flags}]`}`
}

export async function runSessionsCommand(argv: readonly string[]): Promise<number> {
  const { command, positional, flags } = parseSessionArgs(argv)
  if (command === '') {
    console.log(USAGE)
    return 0
  }

  // zstd 的初始化是异步的，而下面的读写都是同步 API——必须在进业务前 await 一次
  await initZstd()
  const home = resolveLcodeHome()
  const api = new LocalSessionsApi({ home })
  try {
    switch (command) {
      // ── 列表 / 详情 ──
      case 'list': {
        const workspace = flags.get('workspace')
        const result = await api.list({
          ...(typeof workspace === 'string' ? { workspace } : {}),
          ...(flags.get('archived') === true ? { includeArchived: true } : {}),
        })
        if (result.items.length === 0) {
          console.log('没有会话。')
          return 0
        }
        for (const meta of result.items) console.log(summarize(meta))
        return 0
      }

      case 'show': {
        const id = positional[0]
        if (id === undefined) return usageError('sessions show 需要一个会话 id')
        const meta = await api.meta({ session_id: id })
        console.log(`${meta.header.session_id}  ${meta.header.title || '(无标题)'}`)
        console.log(`  工作区：  ${meta.header.workspace ?? '(未指定)'}`)
        console.log(`  日志：    ${meta.header.log_path}`)
        console.log(`  步数：    ${meta.last_seq + 1}`)
        console.log(`  revision：${meta.log_revision}`)
        const { messages } = await api.derive({ session_id: id })
        console.log(`  模型可见消息：${messages.length} 条`)
        return 0
      }

      // ── 导出 ──
      case 'export': {
        const format = (flags.get('format') ?? 'jsonl') as ExportFormat
        if (format !== 'jsonl' && format !== 'md') return usageError(`不支持的格式：${format}`)
        const out = flags.get('out')

        if (flags.get('all') === true) {
          const result = await api.exportAll({
            format,
            ...(typeof out === 'string' ? { out } : {}),
          })
          console.log(`已导出 ${result.entries.length} 个会话 → ${result.dir}`)
          console.log(`清单：${result.manifest_path}`)
          if (result.skipped.length > 0) {
            console.log(`\n跳过 ${result.skipped.length} 个（已记入清单）：`)
            for (const item of result.skipped) console.log(`  ${item.session_id}  ${item.reason}`)
          }
          return 0
        }

        const id = positional[0]
        if (id === undefined) return usageError('export 需要会话 id，或用 --all 全量导出')
        const result = await api.export({ session_id: id, format })
        console.log(`已导出 → ${result.path}`)
        console.log(`  ${formatBytes(result.bytes)}  sha256=${result.sha256}`)
        return 0
      }

      // ── 删除语义 ──
      case 'delete': {
        const id = positional[0]
        if (id === undefined) return usageError('delete 需要一个会话 id')
        const result = await api.delete({ session_id: id })
        console.log(`已软删 ${id}（文件保留，可用 lcode restore 撤回）`)
        void result
        return 0
      }

      case 'restore': {
        const id = positional[0]
        if (id === undefined) return usageError('restore 需要一个会话 id')
        await api.restore({ session_id: id })
        console.log(`已恢复 ${id}`)
        return 0
      }

      case 'purge': {
        const id = positional[0]
        if (id === undefined) return usageError('purge 需要一个会话 id')
        const exported = flags.get('exported') === true
        const force = flags.get('force') === true
        if (!exported && !force) {
          console.error(
            '拒绝硬删：删除前请先导出一份备份（产品宪法第二条）。\n' +
              `  lcode export ${id} --format jsonl\n` +
              '确认不需要备份，再用 lcode purge ' +
              id +
              ' --force',
          )
          return 1
        }
        const result = await api.purge({ session_id: id, exported, force })
        console.log(`已硬删 ${id}`)
        console.log(`  已移入回收站：${result.trashed_path}`)
        if (result.spill_freed_bytes > 0) {
          console.log(`  清理关联缓存：${formatBytes(result.spill_freed_bytes)}`)
        }
        console.log('  7 天后会自动清除；想立刻清除用 lcode trash --empty')
        return 0
      }

      case 'trash': {
        if (flags.get('empty') === true) {
          const result = await api.prune({ emptyTrash: true, cache: false })
          console.log(`已清空回收站：${result.trash.removed} 项，释放 ${formatBytes(result.trash.freedBytes)}`)
          return 0
        }
        const trash = await api.listTrash()
        if (trash.items.length === 0) {
          console.log('回收站是空的。')
          return 0
        }
        console.log(`回收站（共 ${formatBytes(trash.total_bytes)}）：`)
        for (const item of trash.items) {
          const days = (item.expires_in_ms / 86_400_000).toFixed(1)
          console.log(`  ${item.session_id}  ${formatBytes(item.bytes).padStart(9)}  剩余 ${days} 天`)
        }
        return 0
      }

      case 'archive': {
        // 22 §9.2：空闲 ≥ 30 天 → `.jsonl.zst`；开放中的会话永不压缩。
        // CLI 是短进程，没有"打开中"的会话，故不传 openSessionIds。
        const dryRun = flags.get('check') === true
        // "压缩前"的占用必须在**归档之前**读——归档之后读到的已经是压缩后的数字，
        // 报告会变成"1015 B → 1015 B（释放 25.9 KB）"这种自相矛盾的输出。
        const before = await api.storageUsage()
        const report = await api.archive({ dryRun })
        if (!report.zstd_available) {
          console.error('压缩归档不可用：zstd 未就绪。')
          for (const item of report.failed) console.error(`  ${item.message}`)
          return 1
        }

        console.log(
          `扫描 ${report.scanned} 个会话：` +
            `${dryRun ? '可归档' : '已归档'} ${report.archived.length}，` +
            `未到期 ${report.skipped_idle}，打开中（跳过） ${report.skipped_open}`,
        )
        for (const entry of report.archived) {
          const ratio = entry.ratio > 0 ? `${entry.ratio.toFixed(1)}×` : '—'
          console.log(
            `  ${entry.session_id}  ${formatBytes(entry.original_bytes)} → ` +
              `${entry.compressed_bytes === 0 ? '（未压缩）' : formatBytes(entry.compressed_bytes)}  ${ratio}`,
          )
        }
        if (report.archived.length > 0) {
          const after = await api.storageUsage()
          console.log(
            `\n会话日志占用：${formatBytes(before.sessions)} → ${formatBytes(after.sessions)}` +
              (dryRun ? '（dry-run，未写盘）' : ''),
          )
        }
        for (const item of report.failed) console.error(`  ✗ ${item.session_id}：${item.message}`)
        return report.failed.length > 0 ? 1 : 0
      }

      default:
        console.error(`未知命令：${command}\n`)
        console.log(USAGE)
        return 1
    }
  } catch (err) {
    // 领域错误按人话呈现（21 §6：错误按 code 路由，不按文本）
    const code = (err as { code?: string }).code
    const userMessage = (err as { userMessage?: string }).userMessage
    console.error(code === undefined ? String(err) : `${code} — ${userMessage ?? String(err)}`)
    return 1
  } finally {
    await api.close()
  }
}

function usageError(message: string): number {
  console.error(message)
  return 1
}
