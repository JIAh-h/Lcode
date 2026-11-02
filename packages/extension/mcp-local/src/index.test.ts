import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemoryToolRegistry } from '@lcode/tools'
import { createLocalSubprocess } from '../../../subprocess/subprocess-local/src/index.ts'
import { createMcpManager } from './index.ts'

/** 最小 MCP stdio 服务：按行 JSON-RPC，提供 echo 工具 */
const fakeMcpServer = String.raw`
let buffer = ''
const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
      continue
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'fail', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
      ] } })
      continue
    }
    if (message.method === 'tools/call') {
      if (message.params.name === 'fail') {
        send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } })
        continue
      }
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] } })
      continue
    }
    if (typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, result: null })
  }
})
`

async function harness() {
  const ctx = createContext()
  const tools = new InMemoryToolRegistry(ctx)
  const manager = createMcpManager({
    servers: { fake: { command: process.execPath, args: ['-e', fakeMcpServer] } },
    subprocess: createLocalSubprocess(),
    workspaceRoot: process.cwd(),
    tools,
    isReadOnly: () => false,
    requestTimeoutMs: 8_000,
  })
  await manager.connect()
  return { ctx, tools, manager }
}

describe('McpManager', () => {
  it('连接服务、注册工具并转发调用', async () => {
    const h = await harness()
    try {
      expect(h.manager.status()).toEqual([
        { name: 'fake', command: process.execPath, enabled: true, connected: true, tools: 2 },
      ])
      const names = h.tools.schemas().map((schema) => schema.name)
      expect(names).toContain('mcp__fake__echo')
      await expect(
        h.tools.execute(
          { callId: 'c1', name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'hi' }) },
          { signal: new AbortController().signal },
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { server: 'fake', tool: 'echo', isError: false, content: [{ type: 'text', text: 'echo:hi' }] },
      })
      await expect(
        h.tools.execute(
          { callId: 'c2', name: 'mcp__fake__fail', arguments: '{}' },
          { signal: new AbortController().signal },
        ),
      ).resolves.toMatchObject({ ok: true, value: { isError: true } })
    } finally {
      await h.manager.close()
    }
  })

  it('只读预设下拒绝 MCP 工具；reload 后状态更新', async () => {
    const h = await harness()
    try {
      const readOnlyTools = new InMemoryToolRegistry(createContext())
      let readOnly = true
      const manager = createMcpManager({
        servers: {},
        subprocess: createLocalSubprocess(),
        workspaceRoot: process.cwd(),
        tools: readOnlyTools,
        isReadOnly: () => readOnly,
        requestTimeoutMs: 8_000,
      })
      await manager.reload({ fake: { command: process.execPath, args: ['-e', fakeMcpServer] } })
      expect(readOnlyTools.schemas().length).toBe(2)
      await expect(
        readOnlyTools.execute(
          { callId: 'c3', name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'x' }) },
          { signal: new AbortController().signal },
        ),
      ).resolves.toMatchObject({ ok: false, error: { name: 'LcodeError' } })
      readOnly = false
      await manager.reload({})
      expect(manager.status()).toEqual([])
      expect(readOnlyTools.schemas().length).toBe(0)
      await manager.close()
    } finally {
      await h.manager.close()
    }
  })
})
