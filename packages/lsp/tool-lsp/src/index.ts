import type { LspService } from '@lcode/lsp'
import type { ToolDefinition } from '@lcode/tools'

export interface LspToolDeps {
  /** 按会话解析工作区根；缺省回落 fallbackWorkspace */
  readonly workspaceOf?: ((sessionId: string) => string | undefined) | undefined
  readonly fallbackWorkspace: string
}

function sessionIdOf(scope: unknown): string | undefined {
  const record = typeof scope === 'object' && scope !== null ? (scope as Record<string, unknown>) : null
  const id = record?.['sessionId']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** LSP 是只读查询工具；进程创建仍由 lsp-stdio provider 经 SubprocessService/Sandbox 完成。 */
export function createLspTools(lsp: LspService, deps: LspToolDeps): readonly ToolDefinition[] {
  const query: ToolDefinition = {
    name: 'lsp_query',
    description:
      '查询语言服务的定义、引用或诊断。definition/references 需要 line + character（1-based，光标位置）；' +
      'diagnostics 返回该文件当前的错误/警告。语言服务不可用时会返回工具错误，不会中断对话。',
    card: 'search',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: '语言标识，如 typescript / javascript / rust / go / python / c / cpp' },
        filePath: { type: 'string', description: '工作区内文件路径' },
        kind: { type: 'string', enum: ['definition', 'references', 'diagnostics'] },
        line: { type: 'number', description: '行号（1-based，definition/references 使用）' },
        character: { type: 'number', description: '列号（1-based，definition/references 使用）' },
      },
      required: ['language', 'filePath', 'kind'],
    },
    describeAction: (parsed) => {
      const value = parsed as { filePath: string; kind: string; line?: number }
      const where = typeof value.line === 'number' ? `:${value.line}` : ''
      return { summary: `查询 ${value.filePath}${where} 的 LSP ${value.kind}`, paths: [{ path: value.filePath, mode: 'read' }] }
    },
    execute: async (call, opts) => {
      const value = call.parsed as {
        language: string
        filePath: string
        kind: 'definition' | 'references' | 'diagnostics'
        line?: number
        character?: number
      }
      const sessionId = sessionIdOf(opts.scope)
      const workspaceRoot = (sessionId === undefined ? undefined : deps.workspaceOf?.(sessionId)) ?? deps.fallbackWorkspace
      return {
        language: value.language,
        filePath: value.filePath,
        kind: value.kind,
        items: await lsp.query({
          language: value.language,
          workspaceRoot,
          filePath: value.filePath,
          kind: value.kind,
          ...(value.line === undefined ? {} : { line: value.line }),
          ...(value.character === undefined ? {} : { character: value.character }),
        }),
      } as never
    },
  }
  return [query]
}
