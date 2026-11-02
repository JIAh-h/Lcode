import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemoryToolRegistry } from '@lcode/tools'
import { createLspTools } from './index.ts'

describe('tool-lsp', () => {
  it('以只读文件意图走统一工具流水线，再委托已注册 LSP 服务（带工作区与光标位置）', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    let seen: Record<string, unknown> = {}
    for (const tool of createLspTools(
      { async query(input) { seen = { ...input }; return [{ uri: input.filePath, kind: input.kind }] } },
      { workspaceOf: (id) => (id === 's1' ? '/repo/a' : undefined), fallbackWorkspace: '/repo/fallback' },
    )) tools.register(tool)
    let path = ''
    ctx.on('tools/pre-execute', (payload) => { path = payload.intent?.paths?.[0]?.path ?? '' })
    await expect(
      tools.execute(
        {
          callId: 'l1',
          name: 'lsp_query',
          arguments: JSON.stringify({ language: 'typescript', filePath: 'src/a.ts', kind: 'definition', line: 12, character: 3 }),
        },
        { signal: new AbortController().signal, scope: { sessionId: 's1', agentId: 'a1' } },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { items: [{ uri: 'src/a.ts', kind: 'definition' }] },
    })
    expect(path).toBe('src/a.ts')
    expect(seen).toMatchObject({ workspaceRoot: '/repo/a', line: 12, character: 3 })
  })

  it('没有会话工作区时回落到 fallbackWorkspace', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    let workspaceRoot = ''
    for (const tool of createLspTools(
      { async query(input) { workspaceRoot = input.workspaceRoot; return [] } },
      { fallbackWorkspace: '/repo/fallback' },
    )) tools.register(tool)
    await tools.execute(
      { callId: 'l2', name: 'lsp_query', arguments: JSON.stringify({ language: 'rust', filePath: 'src/main.rs', kind: 'diagnostics' }) },
      { signal: new AbortController().signal },
    )
    expect(workspaceRoot).toBe('/repo/fallback')
  })
})
