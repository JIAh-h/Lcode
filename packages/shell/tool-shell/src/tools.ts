import type { ShellService } from '@lcode/shell'
import type { ToolDefinition } from '@lcode/tools'

/**
 * `shell` 工具（21 §3.6；批次⑤）。
 *
 * ## 命令串 → argv 的转换在这一层
 *
 * `ShellService` 收的是 argv（沙箱要包装的正是 argv，12 §4.7），而模型给的是
 * 一行命令串。所以这里负责"用哪个 shell 把它跑起来"：
 *
 * - POSIX：`/bin/sh -c '<command>'`（或用户的 `$SHELL`）
 * - Windows：`cmd.exe /d /s /c '<command>'`
 *
 * 这个转换**必须在工具层**（而不是执行器层）：只有工具知道模型给的是一整串命令，
 * 而执行器要保持"argv 进、argv 出"的干净形状——把 shell 解析塞进执行器，
 * 就等于在沙箱**之前**引入了一层字符串解析，那正是注入的入口。
 *
 * ## 退出码非 0 是**成功**
 *
 * `grep` 没匹配到返回 1、`git diff --exit-code` 有差异返回 1——这些都是**执行成功、
 * 结果如是**。把它们当失败会让模型以为命令没跑起来，然后反复重试同一件事（08 §2.3）。
 */

export interface ToolShellDeps {
  readonly shell: ShellService
  /** 工作区根（**新会话的默认**；也给"拿不到会话"时兜底） */
  readonly workspaceRoot: string
  /**
   * 按**会话**取工作区根。
   *
   * `shell` 服务同样只认一个默认 cwd，而一个进程里可以开着多个工作区的会话。
   * 少了它，A 项目里跑 `npm test` 会在进程启动目录跑（那可能根本不是个 npm 项目）。
   */
  readonly workspaceOf?: ((sessionId: string) => string | undefined) | undefined
  /** 一次命令的默认超时（默认 120s，21 §3.6） */
  readonly defaultTimeoutMs?: number | undefined
}

const DEFAULT_TIMEOUT_MS = 120_000

export function createShellTool(deps: ToolShellDeps): ToolDefinition {
  const { shell, workspaceRoot } = deps
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: 'shell',
    description:
      '执行一条 shell 命令。默认在 120 秒后超时（整个进程树会被终止，不留孤儿进程）。\n' +
      '**退出码非 0 不代表工具失败** —— 那只是命令的结果（比如 grep 没匹配到会返回 1）。\n' +
      '需要长时间运行的服务用 runInBackground。',
    card: 'terminal',
    timeoutMs: defaultTimeoutMs + 5_000, // 比命令自己的预算略宽，让命令先超时（它给的诊断更好）
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（整行，交给 shell 解析）' },
        description: { type: 'string', description: '一句话说明这条命令要干什么' },
        timeoutMs: { type: 'number', description: `超时（毫秒，默认 ${DEFAULT_TIMEOUT_MS}）` },
        workdir: { type: 'string', description: '在哪跑（默认工作区根）' },
        runInBackground: { type: 'boolean', description: '放到后台跑（立即返回 jobId）' },
      },
      required: ['command', 'description'],
    },
    describeAction: (parsed) => {
      const p = parsed as { command: string; description: string; workdir?: string }
      return {
        summary: p.description,
        // argv 给策略层判断"这是不是一条新命令/破坏性命令"。
        // 用 shell 自己拆一遍是粗略的，但对**判定**够用：它只需要看出
        // 可执行文件与第一个子命令（`git push` vs `git log`）。
        argv: roughArgv(p.command),
        ...(p.workdir === undefined ? {} : { paths: [{ path: p.workdir, mode: 'read' as const }] }),
      }
    },
    execute: async (call, opts) => {
      const p = call.parsed as {
        command: string
        timeoutMs?: number
        workdir?: string
        runInBackground?: boolean
      }
      const argv = shellArgvFor(p.command)
      const result = await shell.run(argv, {
        // 按会话的工作区跑，而不是进程启动目录（见 ToolShellDeps.workspaceOf）
        cwd: p.workdir ?? workspaceOfCall(opts.scope) ?? workspaceRoot,
        timeoutMs: p.timeoutMs ?? defaultTimeoutMs,
        signal: opts.signal,
        ...(p.runInBackground === undefined ? {} : { runInBackground: p.runInBackground }),
      })
      return result as never
    },
  }

  /** 这次调用该以哪个工作区为根 */
  function workspaceOfCall(scope: unknown): string | undefined {
    if (typeof scope !== 'object' || scope === null) return undefined
    const sessionId = (scope as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const root = deps.workspaceOf?.(sessionId)
    return root === undefined || root === '' ? undefined : root
  }
}

/** 本机 shell 的 argv 前缀。与 `shell-local` 的 `defaultShell` 同口径。 */
function shellArgvFor(command: string): readonly string[] {
  if (process.platform === 'win32') {
    return [process.env['COMSPEC'] ?? 'cmd.exe', '/d', '/s', '/c', command]
  }
  return [process.env['SHELL'] ?? '/bin/sh', '-c', command]
}

/**
 * 粗略拆命令串，**只用于策略判定**（不是用来执行的）。
 *
 * 刻意做得很笨：按空白拆、去掉引号。策略层只需要看出"可执行文件 + 第一个子命令"
 * 来判断"是不是项目里见过的命令"。想在这里做正确的 shell 解析是错的——
 * 那正是我们要避免的那层解析，而且**执行**根本不走这条路径。
 */
function roughArgv(command: string): readonly string[] {
  return command
    .split(/\s+/)
    .filter((s) => s !== '')
    .map((s, i) => (i === 0 ? s.replace(/^["']|["']$/g, '') : s))
}
