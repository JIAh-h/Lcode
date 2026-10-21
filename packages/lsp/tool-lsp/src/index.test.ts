import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemoryToolRegistry } from '@lcode/tools'
import { createLspTools } from './index.ts'

describe('tool-lsp', () => {
  it('以只读文件意图走统一工具流水线，再委托已注册 LSP 服务', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    for (const tool of createLspTools({ async query(input) { return [{ uri: input.filePath, kind: input.kind }] } })) tools.register(tool)
    let path = ''
    ctx.on('tools/pre-execute', (payload) => { path = payload.intent?.paths?.[0]?.path ?? '' })
    await expect(tools.execute({ callId: 'l1', name: 'lsp_query', arguments: JSON.stringify({ language: 'typescript', filePath: 'src/a.ts', kind: 'definition' }) }, { signal: new AbortController().signal })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ uri: 'src/a.ts', kind: 'definition' }] },
    })
    expect(path).toBe('src/a.ts')
  })
})
