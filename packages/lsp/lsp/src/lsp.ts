/** LspService —— 语言服务（崩溃不得杀死会话，重启后重新初始化） */
export interface LspQueryInput {
  readonly language: string
  /** 查询所属的工作区根（多工作区时由工具按会话解析） */
  readonly workspaceRoot: string
  readonly filePath: string
  readonly kind: 'definition' | 'references' | 'diagnostics'
  /** 1-based；definition / references 使用，diagnostics 忽略 */
  readonly line?: number | undefined
  readonly character?: number | undefined
}

export interface LspService {
  query(input: LspQueryInput): Promise<readonly unknown[]>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    lsp: LspService
  }
}
