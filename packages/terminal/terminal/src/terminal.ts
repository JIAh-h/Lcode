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
  /** 由权限钩子按预设写入；缺省时 Provider 按 workspace-write 处理（直接调用/测试）。 */
  readonly sandboxPolicy?: TerminalSandboxPolicy | undefined
}

/** 终端只需要这一小段沙箱契约，避免 terminal 层反向依赖平台 Provider。 */
export interface TerminalSandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly allowNetwork?: boolean | undefined
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
