import type { ResolvedSandboxPolicy } from '@lcode/sandbox'
import type { ShellBackgroundResult, ShellForegroundResult, ShellRunOpts, ShellResult, ShellService } from '@lcode/shell'
import { ERROR_CODES, LcodeErrorImpl, newSessionId } from '@lcode/util'
import { spawn } from 'node:child_process'

/**
 * `shell-local` —— 本机命令执行（批次⑤）。
 *
 * ## 三件事的顺序不能变
 *
 * 1. **先过沙箱**（`ctx.sandbox.wrap(argv, policy)`）——拿到"要真的 spawn 什么"
 * 2. 再 spawn
 * 3. 结果里如实带上 `sandbox.enforced`
 *
 * 第 3 步是刻意的：**执行器不判断"降级该不该拦"**，那是策略层的事。它只负责把
 * "约束没生效"这个事实**传出去**（12 §4.2 的 fail-closed 分叉在策略层做）。
 *
 * ## 为什么超时用 `killTree` 而不是 `proc.kill()`
 *
 * `kill()` 只杀直接子进程。`npm test` 会拉起一整个进程树，只杀顶层会留下
 * 还在跑的孙进程——它们继续占端口、写文件，而 UI 显示"已完成"。Windows 上尤其明显。
 */

export interface LocalShellOptions {
  /** 工作区根（默认 cwd） */
  readonly workspaceRoot: string
  /**
   * 沙箱包装器。省略 = 无沙箱（等价于 `sandbox-local`），并且结果里如实标 `enforced: false`。
   */
  readonly wrap?: ((argv: readonly string[], policy: ResolvedSandboxPolicy) => Promise<{ enforced: boolean; wrappedArgv: readonly string[] }>) | undefined
  /** 后台作业的登记表（省略则不启用后台模式——直接报错，而不是假装在跑） */
  readonly jobs?: JobRegistry | undefined
}

/** 后台作业登记表（骨架阶段的最小形态：只登记 + 可查/可杀） */
export interface JobRegistry {
  add(entry: { readonly jobId: string; readonly argv: readonly string[]; readonly kill: () => Promise<void> }): void
  get(jobId: string): { readonly argv: readonly string[]; readonly kill: () => Promise<void> } | undefined
}

export interface CreateLocalShellResult {
  readonly shell: ShellService
  /** 本机默认 shell（供工具把命令行串包成 argv；**不在这里做字符串解析**） */
  readonly defaultShell: readonly string[]
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1_000_000

export function createLocalShell(options: LocalShellOptions): CreateLocalShellResult {
  const root = options.workspaceRoot

  const shell: ShellService = {
    async run(argv: readonly string[], opts: ShellRunOpts = {}): Promise<ShellResult> {
      if (argv.length === 0) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_INVALID_ARGS,
          message: 'argv 不能为空',
          userMessage: '没有给出要执行的命令。',
          retryable: false,
        })
      }
      const cwd = opts.cwd ?? root
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

      // ① 沙箱包装（在 spawn **之前**——它决定 spawn 什么）
      const wrapped = await wrapWith(options, argv, {
        mode: 'workspace-write',
        workspaceRoot: root,
        ...(opts.sandboxPolicy === undefined ? {} : opts.sandboxPolicy),
      })

      const background = opts.runInBackground === true

      if (background) return spawnBackground(options, wrapped, cwd, opts)
      return spawnForeground(wrapped, cwd, opts, timeoutMs)
    },
  }

  return { shell, defaultShell: defaultShellArgv() }
}

// ─────────── 前台 ───────────

async function spawnForeground(
  wrapped: { readonly enforced: boolean; readonly wrappedArgv: readonly string[] },
  cwd: string,
  opts: ShellRunOpts,
  timeoutMs: number,
): Promise<ShellForegroundResult> {
  const child = spawn(wrapped.wrappedArgv[0]!, wrapped.wrappedArgv.slice(1), {
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    windowsHide: true,
    // 不接 stdio：我们要自己收集，见下
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdout = collector()
  const stderr = collector()
  child.stdout?.on('data', stdout.push)
  child.stderr?.on('data', stderr.push)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // killTree 而非 kill：`npm test` 拉起的是一棵进程树，只杀顶层会留下孙进程继续跑
    void killTree(child.pid)
  }, timeoutMs)

  const onAbort = (): void => void killTree(child.pid)
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }))
    child.on('error', () => resolve({ code: null, signal: null }))
  })

  clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)

  return {
    kind: 'foreground',
    // spawn 失败（ENOENT 之类）时 code 是 null：用 -1 表达"进程压根没跑起来"，
    // 而不是 0（那会被读成"成功"）
    exitCode: exited.code ?? -1,
    signal: exited.signal,
    timedOut,
    aborted: opts.signal?.aborted === true,
    timeoutMs,
    stdout: stdout.text(),
    stderr: stderr.text(),
    sandbox: { enforced: wrapped.enforced },
  }
}

// ─────────── 后台 ───────────

async function spawnBackground(
  options: LocalShellOptions,
  wrapped: { readonly enforced: boolean; readonly wrappedArgv: readonly string[] },
  cwd: string,
  opts: ShellRunOpts,
): Promise<ShellBackgroundResult> {
  if (options.jobs === undefined) {
    throw new LcodeErrorImpl({
      code: ERROR_CODES.EC_NOT_READY,
      message: '后台作业未装配（缺 jobs 依赖）',
      userMessage: '当前还不能把命令放到后台跑。',
      retryable: false,
    })
  }
  const jobId = newSessionId()
  const child = spawn(wrapped.wrappedArgv[0]!, wrapped.wrappedArgv.slice(1), {
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    windowsHide: true,
    stdio: 'ignore',
    // 后台进程**不要**继承事件循环的生命周期：父进程退出后它该活着
    detached: true,
  })
  child.unref()
  options.jobs.add({
    jobId,
    argv: wrapped.wrappedArgv,
    kill: async () => {
      await killTree(child.pid)
    },
  })
  return { kind: 'background', jobId }
}

// ─────────── 内部 ───────────

async function wrapWith(
  options: LocalShellOptions,
  argv: readonly string[],
  policy: ResolvedSandboxPolicy,
): Promise<{ enforced: boolean; wrappedArgv: readonly string[] }> {
  if (options.wrap === undefined) {
    // 没装沙箱：如实报告，不假装
    return { enforced: false, wrappedArgv: [...argv] }
  }
  const result = await options.wrap(argv, policy)
  return { enforced: result.enforced, wrappedArgv: [...result.wrappedArgv] }
}

/** 按块收集输出，并按字节数封顶（一条 `yes` 能产出无穷输出） */
function collector(): { push: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk: Buffer): void {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      bytes += chunk.length
      chunks.push(chunk)
    },
    text(): string {
      const text = Buffer.concat(chunks).toString('utf8')
      return truncated ? `${text}\n…（输出过长已截断，上限 ${MAX_OUTPUT_BYTES} 字节）` : text
    },
  }
}

/**
 * 整体终止进程树。
 *
 * Windows 用 `taskkill /T`（`/T` = 连同子进程），其它平台按进程组杀（`-pid`）。
 * 失败**不抛**：调用点在超时回调里，那里抛错没有接收者。
 */
async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  await new Promise<void>((resolve) => {
    const killer =
      process.platform === 'win32'
        ? spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        : spawn('kill', ['-TERM', `-${pid}`], { stdio: 'ignore' })
    killer.on('close', () => resolve())
    killer.on('error', () => resolve())
  })
}

/** 本机默认 shell 的 argv 前缀（`['/bin/bash','-lc']` / `['cmd','/c']`） */
function defaultShellArgv(): readonly string[] {
  if (process.platform === 'win32') {
    return [process.env['COMSPEC'] ?? 'cmd.exe', '/d', '/s', '/c']
  }
  return [process.env['SHELL'] ?? '/bin/sh', '-c']
}
