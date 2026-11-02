import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalSubprocess } from '../../../subprocess/subprocess-local/src/index.ts'
import { createLocalLsp } from './index.ts'

const fakeServer = String.raw`
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
let buffer = Buffer.alloc(0)
let root = process.cwd()
const send = (payload) => {
  const body = Buffer.from(JSON.stringify(payload))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]))
}
const uriOf = (rel) => pathToFileURL(join(root, rel)).href
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const length = Number(/^Content-Length:\s*(\d+)/im.exec(header)?.[1])
    const start = headerEnd + 4
    if (!Number.isFinite(length) || buffer.length < start + length) return
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'))
    buffer = buffer.subarray(start + length)
    const range = (line, character) => ({ start: { line, character }, end: { line, character: character + 1 } })
    if (message.method === 'initialize') {
      root = require('node:url').fileURLToPath(message.params.rootUri)
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
      continue
    }
    if (message.method === 'textDocument/definition') {
      send({ jsonrpc: '2.0', id: message.id, result: [{ uri: uriOf('src/b.ts'), range: range(1, 2) }] })
      continue
    }
    if (message.method === 'textDocument/references') {
      send({ jsonrpc: '2.0', id: message.id, result: [
        { uri: uriOf('src/a.ts'), range: range(4, 1) },
        { uri: pathToFileURL(join(root, '..', 'outside.ts')).href, range: range(0, 0) },
      ] })
      continue
    }
    if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange') {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
        uri: message.params.textDocument.uri,
        diagnostics: [{ range: range(3, 0), severity: 1, message: '类型错误', source: 'fake' }],
      } })
      continue
    }
    if (typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, result: null })
  }
})
`

let workspace = ''
afterEach(() => {
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
  workspace = ''
})

describe('LocalLspService', () => {
  const makeWorkspace = (): string => {
    workspace = mkdtempSync(join(tmpdir(), 'lcode-lsp-'))
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'const a = 1\nconst b = a\n')
    writeFileSync(join(workspace, 'src', 'b.ts'), 'export const b = 2\n')
    return workspace
  }

  it('definition / references / diagnostics 映射到工作区相对位置', async () => {
    const ws = makeWorkspace()
    const lsp = createLocalLsp({
      servers: { typescript: { command: process.execPath, args: ['-e', fakeServer] } },
      subprocess: createLocalSubprocess(),
      defaultWorkspace: ws,
      readFile: (path) => readFileSync(path, 'utf8'),
      diagnosticsTimeoutMs: 5_000,
    })
    try {
      const definition = await lsp.query({ language: 'typescript', workspaceRoot: ws, filePath: 'src/a.ts', kind: 'definition', line: 2, character: 1 })
      expect(definition).toEqual([{ path: 'src/b.ts', line: 2, column: 3 }])

      const references = await lsp.query({ language: 'typescript', workspaceRoot: ws, filePath: 'src/a.ts', kind: 'references', line: 1, character: 1 })
      expect(references).toEqual([{ path: 'src/a.ts', line: 5, column: 2 }])

      const diagnostics = await lsp.query({ language: 'typescript', workspaceRoot: ws, filePath: 'src/a.ts', kind: 'diagnostics' })
      expect(diagnostics).toEqual([
        { path: 'src/a.ts', line: 4, column: 1, endLine: 4, endColumn: 2, severity: 'error', message: '类型错误', source: 'fake' },
      ])
    } finally {
      await lsp.dispose()
    }
  })

  it('未配置的语言给出可操作错误；越界路径被拒绝', async () => {
    const ws = makeWorkspace()
    const lsp = createLocalLsp({
      servers: {},
      subprocess: createLocalSubprocess(),
      defaultWorkspace: ws,
      readFile: (path) => readFileSync(path, 'utf8'),
    })
    try {
      await expect(lsp.query({ language: 'python', workspaceRoot: ws, filePath: 'a.py', kind: 'diagnostics' })).rejects.toThrow('没有为语言「python」找到语言服务器')
      await expect(lsp.query({ language: 'python', workspaceRoot: ws, filePath: 'a.py', kind: 'diagnostics' })).rejects.toThrow('pip install python-lsp-server')
      await expect(lsp.query({ language: 'typescript', workspaceRoot: ws, filePath: '../evil.ts', kind: 'diagnostics' })).rejects.toThrow('工作区内')
    } finally {
      await lsp.dispose()
    }
  })
})
