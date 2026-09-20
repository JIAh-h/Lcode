import { describe, expect, it } from 'vitest'
import { createLocalSubprocess } from '../../../subprocess/subprocess-local/src/index.ts'
import { createLspStdioClient } from './index.ts'

const echoServer = String.raw`
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const length = Number(/^Content-Length:\s*(\d+)/im.exec(header)?.[1])
    const start = headerEnd + 4
    if (!Number.isFinite(length) || buffer.length < start + length) return
    const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'))
    buffer = buffer.subarray(start + length)
    if (typeof request.id !== 'number') continue
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } }))
    process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]))
  }
})
`

describe('LspStdioClient', () => {
  it('经 SubprocessService 与沙箱包装器启动，并收发分块 JSON-RPC 帧', async () => {
    let wrapped = false
    const client = await createLspStdioClient({
      argv: [process.execPath, '-e', echoServer],
      cwd: process.cwd(),
      subprocess: createLocalSubprocess(),
      wrap: async (argv) => {
        wrapped = true
        return { enforced: true, wrappedArgv: [...argv] }
      },
    })

    try {
      await expect(client.request('workspace/symbol', { query: 'Lcode' })).resolves.toEqual({
        method: 'workspace/symbol',
        params: { query: 'Lcode' },
      })
      expect(client.sandbox.enforced).toBe(true)
      expect(wrapped).toBe(true)
    } finally {
      await client.close()
    }
    expect(client.state).toBe('closed')
  })

  it('已中止的请求不会写入 LSP 服务器', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = await createLspStdioClient({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      subprocess: createLocalSubprocess(),
    })
    try {
      await expect(client.request('workspace/symbol', undefined, controller.signal)).rejects.toMatchObject({ code: 'ET-ABORTED' })
    } finally {
      await client.close()
    }
  })
})
