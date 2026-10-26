import type { ResolvedSandboxPolicy } from '@lcode/sandbox'
import type { ShellBackgroundResult, ShellForegroundResult, ShellRunOpts, ShellResult, ShellService } from '@lcode/shell'
import type { JobsService } from '@lcode/jobs'
import type { SubprocessService } from '@lcode/subprocess'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

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
  readonly wrap?:
    ((argv: readonly string[], policy: ResolvedSandboxPolicy, scope?: unknown) => Promise<{ enforced: boolean; wrappedArgv: readonly string[] }>) | undefined
  /** 发布即脱离的后台作业服务；省略则后台模式明确报错。 */
  readonly jobs?: JobsService | undefined
  /** 子进程 Provider；桌面运行时显式注入，独立使用时回退到本机 Provider。 */
  readonly subprocess?: SubprocessService | undefined
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
  const subprocess = options.subprocess ?? createLocalSubprocess()

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
      }, opts.scope)

      const background = opts.runInBackground === true

      if (background) return spawnBackground(options, subprocess, wrapped, cwd, opts)
      return spawnForeground(subprocess, wrapped, cwd, opts, timeoutMs)
    },
  }

  return { shell, defaultShell: defaultShellArgv() }
}

// ─────────── 前台 ───────────

async function spawnForeground(
  subprocess: SubprocessService,
  wrapped: {
    readonly enforced: boolean
    readonly wrappedArgv: readonly string[]
  },
  cwd: string,
  opts: ShellRunOpts,
  timeoutMs: number,
): Promise<ShellForegroundResult> {
  const child = await subprocess.spawn({ argv: wrapped.wrappedArgv, cwd, env: mergedEnv(opts.env) })

  const stdout = collector()
  const stderr = collector()
  child.stdout.on('data', stdout.push)
  child.stderr.on('data', stderr.push)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // killTree 而非 kill：`npm test` 拉起的是一棵进程树，只杀顶层会留下孙进程继续跑
    void child.killTree()
  }, timeoutMs)

  const onAbort = (): void => void child.killTree()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const exited = await child.exited

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
  subprocess: SubprocessService,
  wrapped: {
    readonly enforced: boolean
    readonly wrappedArgv: readonly string[]
  },
  cwd: string,
  opts: ShellRunOpts,
): Promise<ShellBackgroundResult> {
  const jobs = options.jobs
  if (jobs === undefined) {
    throw new LcodeErrorImpl({
      code: ERROR_CODES.EC_NOT_READY,
      message: '后台作业未装配（缺 jobs 依赖）',
      userMessage: '当前还不能把命令放到后台跑。',
      retryable: false,
    })
  }
  const started = await jobs.start({
    kind: 'shell',
    label: wrapped.wrappedArgv.join(' '),
    ...(opts.ownerAgentId === undefined ? {} : { ownerAgentId: opts.ownerAgentId }),
    // 这个回调拿到的是 jobs 自己的 AbortSignal：外层工具调用结束或取消之后，
    // 已发布的作业不会受影响；只有 jobs.kill / owner dispose / service dispose 会 abort。
    run: async ({ signal, write }) => await spawnBackgroundProcess(subprocess, wrapped.wrappedArgv, cwd, opts, signal, write),
  })
  return { kind: 'background', jobId: started.jobId }
}

async function spawnBackgroundProcess(
  subprocess: SubprocessService,
  argv: readonly string[],
  cwd: string,
  opts: ShellRunOpts,
  signal: AbortSignal,
  write: (data: string | Uint8Array) => void,
): Promise<{ readonly exitCode: number; readonly signal: string | null }> {
  const child = await subprocess.spawn({ argv, cwd, env: mergedEnv(opts.env) })
  child.stdout.on('data', (chunk: Buffer) => write(chunk))
  child.stderr.on('data', (chunk: Buffer) => write(chunk))
  const onAbort = (): void => { void child.killTree() }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    const exited = await child.exited
    return { exitCode: exited.code ?? -1, signal: exited.signal }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// ─────────── 内部 ───────────

async function wrapWith(
  options: LocalShellOptions,
  argv: readonly string[],
  policy: ResolvedSandboxPolicy,
  scope?: unknown,
): Promise<{ enforced: boolean; wrappedArgv: readonly string[] }> {
  if (options.wrap === undefined) {
    // 没装沙箱：如实报告，不假装
    return { enforced: false, wrappedArgv: [...argv] }
  }
  const result = await options.wrap(argv, policy, scope)
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

/** 本机默认 shell 的 argv 前缀（`['/bin/bash','-lc']` / `['cmd','/c']`） */
function defaultShellArgv(): readonly string[] {
  if (process.platform === 'win32') {
    return [process.env['COMSPEC'] ?? 'cmd.exe', '/d', '/s', '/c']
  }
  return [process.env['SHELL'] ?? '/bin/sh', '-c']
}

/** `process.env` 允许 undefined；子进程契约只允许实际可传递的字符串。 */
function mergedEnv(overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...(overrides ?? {}) }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
