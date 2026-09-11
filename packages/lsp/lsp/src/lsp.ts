/** LspService —— 语言服务（崩溃不得杀死会话，重启后重新初始化） */
export interface LspService {
  query(input: { readonly language: string; readonly filePath: string; readonly kind: 'definition' | 'references' | 'diagnostics' }): Promise<readonly unknown[]>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    lsp: LspService
  }
}
