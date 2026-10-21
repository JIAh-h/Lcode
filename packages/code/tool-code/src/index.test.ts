import { createContext } from '@lcode/context'
import type { CodeRuntime } from '@lcode/code-runtime'
import { InMemoryToolRegistry } from '@lcode/tools'
import { describe, expect, it } from 'vitest'
import { createCodeTool } from './index.ts'

describe('tool-code', () => {
  it('将 binding 调用重新投递到 ToolRegistry 的审批与守卫流水线', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    let policyCalls = 0
    ctx.on('tools/pre-execute', () => { policyCalls++ })
    tools.register<{ readonly text: string }, { readonly text: string }>({ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, execute: (call) => ({ text: call.parsed.text }) })
    const runtime: CodeRuntime = {
      languages: ['javascript'],
      async run(request) {
        const value = await request.invoke('tools.echo', { text: 'from-code' })
        return { value, logs: [] }
      },
    }
    tools.register(createCodeTool({ runtime, tools }))
    const result = await tools.execute({ callId: 'root', name: 'run_code', arguments: JSON.stringify({ code: 'return await tools.echo({ text: "from-code" })' }) }, { signal: new AbortController().signal, scope: { sessionId: 's1', agentId: 'a1' } })
    expect(policyCalls).toBe(2)
    expect(result).toMatchObject({ ok: true, value: { ok: true, result: { text: 'from-code' }, logs: [] } })
  })
})
