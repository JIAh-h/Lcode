import type {} from '@lcode/context'

export interface SpawnedProcess {
  readonly pid: number
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  /** 受控 stdio 消费者（如 LSP）向子进程写入请求；不支持交互输入的 Provider 可省略。 */
  writeStdin?(data: string | Uint8Array): boolean
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

/** 交互式终端的启动参数；不向消费者泄露 node-pty。 */
export interface PtySpawnOpts {
  readonly shell: string
  readonly args?: readonly string[] | undefined
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly cols: number
  readonly rows: number
}

export interface SpawnedPty {
  readonly pid: number
  write(data: string): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { readonly exitCode: number }) => void): void
}

/** SubprocessService —— 子进程（进程树可整体终止） */
export interface SubprocessService {
  spawn(opts: SpawnOpts): Promise<SpawnedProcess>
  /** Provider 没有受控 PTY 时必须省略，终端层据此拒绝而不裸启动。 */
  spawnPty?(opts: PtySpawnOpts): Promise<SpawnedPty>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    subprocess: SubprocessService
  }
}
