/**
 * CLI 入口（文档 20 §7.2 / 23 §5）。
 *
 * 已接线：数据层的会话日常操作（`sessions` / `export` / `delete` / `restore` /
 * `purge` / `trash`）与 `doctor`（含 `--index` 索引体检、`--storage` 存储维护）。
 * 其余子命令（`index rebuild` 的独立入口、`migrate`、`--dump-config` 的真实装配）
 * 随批次 ⑦ 落地。
 */
import { runDoctor, type DoctorMode } from './doctor.ts'
import { runSessionsCommand } from './sessions.ts'

/**
 * 解析结果。这里**不用 `readonly`**：`parseArgs` 是逐参数增量构造它的，
 * 而 `exactOptionalPropertyTypes` 下可选属性要显式带 `| undefined` 才能接收
 * 「可能取不到」的索引值（`argv[++i]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`）。
 */
export interface CliOptions {
  profile?: string | undefined
  dumpConfig?: boolean | undefined
  doctor?: DoctorMode | undefined
  /** 会话类命令的子参数（原样转发给 runSessionsCommand） */
  sessionsArgv?: string[] | undefined
}

/** 走 `sessions` 实现的顶层命令（第一条参数即命令名） */
const SESSION_COMMANDS = new Set(['sessions', 'export', 'delete', 'restore', 'purge', 'trash', 'archive'])

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {}
  const first = argv[0]

  // 会话类命令整体转发：它们有自己的参数文法（位置参数 + 长选项），
  // 在这里逐条 switch 只会把 parseSessionArgs 抄一遍。
  // `lcode sessions list` 里的 `sessions` 只是一个命名空间前缀，转发时要去掉——
  // 否则子命令解析会把 'sessions' 当成命令名。
  if (first !== undefined && SESSION_COMMANDS.has(first)) {
    opts.sessionsArgv = first === 'sessions' ? [...argv.slice(1)] : [...argv]
    return opts
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--profile':
        opts.profile = argv[++i]
        break
      case '--dump-config':
        opts.dumpConfig = true
        break
      case 'doctor':
        opts.doctor = 'basic'
        break
      case '--model':
        opts.doctor = 'model'
        break
      case '--sandbox':
        opts.doctor = 'sandbox'
        break
      case '--index':
        opts.doctor = 'index'
        break
      case '--storage':
        opts.doctor = 'storage'
        break
      default:
        break
    }
  }
  return opts
}

const USAGE = `Lcode CLI — 可用命令：

会话（数据层，可独立使用）
  lcode sessions list              列出会话
  lcode sessions show <id>         查看一个会话
  lcode export <id> [--format jsonl|md]
  lcode export --all [--out <dir>] 全量导出 + manifest.json
  lcode delete <id>                软删（文件保留）
  lcode restore <id>               撤销软删
  lcode purge <id> --exported      硬删（先导出；--force 可跳过提示）
  lcode trash [--empty]            查看 / 清空回收站
  lcode archive [--check]          压缩归档空闲 ≥30 天的会话

自检
  lcode doctor                     环境自检
  lcode doctor --index             索引体检（比对 log_revision 与真实日志）
  lcode doctor --storage           存储占用 + 保留策略维护
  lcode doctor --model             模型配置来源（批次 ④）
  lcode doctor --sandbox           沙箱状态（批次 ⑥）

其它
  lcode --dump-config [--profile <name>]`

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.sessionsArgv !== undefined) {
    process.exitCode = await runSessionsCommand(opts.sessionsArgv)
    return
  }
  if (opts.doctor !== undefined) {
    process.exitCode = await runDoctor(opts.doctor)
    return
  }
  if (opts.dumpConfig) {
    // TODO(批次⑦)：打印最终插件装配（含层级与来源）
    console.log(JSON.stringify({ profile: opts.profile ?? 'default', bundles: [] }, null, 2))
    return
  }
  console.log(USAGE)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
