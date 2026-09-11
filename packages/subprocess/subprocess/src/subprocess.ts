export interface SpawnedProcess {
  readonly pid: number
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  /** 整体终止进程树（不留孤儿进程） */
  killTree(): Promise<void>
  readonly exited: Promise<{ code: number | null; signal: string | null }>
}

export interface SpawnOpts {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** SubprocessService —— 子进程（进程树可整体终止） */
export interface SubprocessService {
  spawn(opts: SpawnOpts): Promise<SpawnedProcess>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    subprocess: SubprocessService
  }
}
