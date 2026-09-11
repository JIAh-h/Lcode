/** shell 执行结果（规范值，21 §3.6） */
export interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface ShellRunOpts {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** ShellService —— 执行 shell 命令（沙箱约束的是即将 spawn 的 argv） */
export interface ShellService {
  run(command: string, opts?: ShellRunOpts): Promise<ShellResult>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    shell: ShellService
  }
}
