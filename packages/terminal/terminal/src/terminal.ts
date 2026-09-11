/** 终端输出行（规范值） */
export interface TerminalOutput {
  readonly terminalId: string
  readonly data: string
  readonly stream: 'stdout' | 'stderr'
}

export interface TerminalHandle {
  readonly id: string
  write(data: string): Promise<void>
  kill(): Promise<void>
  readonly onOutput: (handler: (out: TerminalOutput) => void) => () => void
}

/** TerminalService —— PTY 终端（输入不经过模型，除非显式引用） */
export interface TerminalService {
  create(opts?: { readonly cwd?: string; readonly shell?: string }): Promise<TerminalHandle>
  get(id: string): TerminalHandle | undefined
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    terminals: TerminalService
  }
}
