/**
 * CLI 入口（文档 20 §7.2 / 23 §5）。
 *
 * 已接线：数据层的会话日常操作（`sessions` / `export` / `delete` / `restore` /
 * `purge` / `trash`）、`index rebuild` 与 `doctor`（含 `--index` 索引体检、
 * `--storage` 存储维护）。`migrate`、`--dump-config` 的真实装配随批次 ⑦ 落地。
 */
import { runDoctor, type DoctorMode } from './doctor.ts'
import { runIndexCommand, runSessionsCommand } from './sessions.ts'
import { runTaskCommand } from './run.ts'
import { runJobsCommand } from './jobs.ts'
import { runPluginsCommand } from './plugins.ts'
import { createAgentRuntime } from '@lcode/lcode-desktop'
import { resolveLcodeHome } from '@lcode/util'

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
  /** 派生索引维护子命令（当前只支持 `index rebuild`） */
  indexArgv?: string[] | undefined
  /** 无 GUI 完整任务入口的子参数 */
  runArgv?: string[] | undefined
  /** 内存作业查询入口；不跨进程恢复。 */
  jobsArgv?: string[] | undefined
  /** 本地插件管理；真实生命周期仍由共享 Runtime 承担。 */
  pluginsArgv?: string[] | undefined
}

/** 走 `sessions` 实现的顶层命令（第一条参数即命令名） */
const SESSION_COMMANDS = new Set(['sessions', 'export', 'import', 'delete', 'restore', 'purge', 'trash', 'archive'])

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
  if (first === 'index') {
    opts.indexArgv = [...argv.slice(1)]
    return opts
  }
  if (first === 'run') {
    opts.runArgv = [...argv.slice(1)]
    return opts
  }
  if (first === 'jobs') {
    opts.jobsArgv = [...argv.slice(1)]
    return opts
  }
  if (first === 'plugins') {
    opts.pluginsArgv = [...argv.slice(1)]
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
  lcode import <file.jsonl> [--title <name>] 导入为新的本地会话
  lcode delete <id>                软删（文件保留）
  lcode restore <id>               撤销软删
  lcode purge <id> --exported      硬删（先导出；--force 可跳过提示）
  lcode trash [--empty]            查看 / 清空回收站
  lcode archive [--check]          压缩归档空闲 ≥30 天的会话
  lcode index rebuild              从 JSONL 重建并压缩 SQLite 索引

任务（无 GUI，共用桌面端内核）
  lcode run <任务描述> [--cwd <dir>] [--trust-workspace]
  lcode run --session <id> <补充要求> [--trust-workspace]
  lcode jobs list                 查看活动作业的驻留语义
  lcode jobs kill <id>            仅原运行时可执行；新 CLI 会明确拒绝接管

插件（仅本地目录快照；启动必须通过系统沙箱）
  lcode plugins list
  lcode plugins inspect
  lcode plugins install <目录>
  lcode plugins activate|deactivate|uninstall <id> <version>

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
  if (opts.indexArgv !== undefined) {
    process.exitCode = await runIndexCommand(opts.indexArgv)
    return
  }
  if (opts.runArgv !== undefined) {
    process.exitCode = await runTaskCommand(opts.runArgv)
    return
  }
  if (opts.jobsArgv !== undefined) {
    process.exitCode = await runJobsCommand(opts.jobsArgv)
    return
  }
  if (opts.pluginsArgv !== undefined) {
    process.exitCode = await runPluginsCommand(opts.pluginsArgv)
    return
  }
  if (opts.doctor !== undefined) {
    process.exitCode = await runDoctor(opts.doctor)
    return
  }
  if (opts.dumpConfig) {
    process.exitCode = await runDumpConfig(opts.profile)
    return
  }
  console.log(USAGE)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

async function runDumpConfig(requested: string | undefined): Promise<number> {
  const profile = requested ?? 'cli-default'
  if (profile !== 'desktop-default' && profile !== 'cli-default') {
    console.error(`未知 profile：${profile}（可用：desktop-default、cli-default）`)
    return 1
  }
  const runtime = await createAgentRuntime({
    home: resolveLcodeHome(),
    profile,
  })
  try {
    console.log(JSON.stringify(runtime.composition, null, 2))
    return 0
  } finally {
    await runtime.dispose()
  }
}
