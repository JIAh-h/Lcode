import type { LspService } from '@lcode/lsp'
import type { ToolDefinition } from '@lcode/tools'

/** LSP 是只读查询工具；进程创建仍由 lsp-stdio provider 经 SubprocessService/Sandbox 完成。 */
export function createLspTools(lsp: LspService): readonly ToolDefinition[] {
  const query: ToolDefinition = {
    name: 'lsp_query',
    description: '查询语言服务的定义、引用或诊断。语言服务不可用时会返回工具错误，不会中断对话。',
    card: 'search',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: '语言标识，如 typescript' },
        filePath: { type: 'string', description: '工作区内文件路径' },
        kind: { type: 'string', enum: ['definition', 'references', 'diagnostics'] },
      },
      required: ['language', 'filePath', 'kind'],
    },
    describeAction: (parsed) => {
      const value = parsed as { filePath: string; kind: string }
      return { summary: `查询 ${value.filePath} 的 LSP ${value.kind}`, paths: [{ path: value.filePath, mode: 'read' }] }
    },
    execute: async (call) => {
      const value = call.parsed as { language: string; filePath: string; kind: 'definition' | 'references' | 'diagnostics' }
      return { language: value.language, filePath: value.filePath, kind: value.kind, items: await lsp.query(value) } as never
    },
  }
  return [query]
}
