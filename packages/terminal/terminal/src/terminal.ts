/**
 * 持久终端的描述。`offset` 是已收集输出的 UTF-8 字节总数；它可直接作为下一次
 * `read.sinceOffset` 的值。终端输入和输出留在终端能力层，不会自动进入模型上下文。
 */
export interface TerminalInfo {
  readonly terminalId: string
  readonly ownerAgentId: string
  readonly cwd: string
  readonly shell: string
  readonly offset: number
  readonly exited: boolean
  readonly exitCode?: number | undefined
}

export interface TerminalOpenInput {
  readonly ownerAgentId: string
  readonly cwd?: string | undefined
  readonly shell?: string | undefined
}

export interface TerminalReadResult {
  readonly data: string
  readonly offset: number
  readonly exited: boolean
  readonly exitCode?: number | undefined
}

/** TerminalService —— owner 隔离的 PTY 注册表（文档 21 §2.9）。 */
export interface TerminalService {
  open(input: TerminalOpenInput): Promise<{ readonly terminalId: string }>
  send(input: { readonly ownerAgentId: string; readonly terminalId: string; readonly data: string }): Promise<{ readonly written: number }>
  read(input: { readonly ownerAgentId: string; readonly terminalId: string; readonly sinceOffset?: number | undefined }): Promise<TerminalReadResult>
  signal(input: { readonly ownerAgentId: string; readonly terminalId: string; readonly signal: string }): Promise<{ readonly sent: true }>
  close(input: { readonly ownerAgentId: string; readonly terminalId: string }): Promise<{ readonly closed: true }>
  list(input?: { readonly ownerAgentId?: string | undefined }): readonly TerminalInfo[]
  /** Agent 释放时关闭其仍存活的终端。 */
  disposeOwner(ownerAgentId: string): Promise<void>
  dispose(): Promise<void>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    terminals: TerminalService
  }
}
