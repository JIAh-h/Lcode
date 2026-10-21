import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_SCHEMA, parsePluginManifest } from '@lcode/plugin-manifest'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import { createPluginHost } from './index.ts'

const utilityHost = String.raw`
const mode = process.argv[1]
let buffer = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const request = (id, method) => send({ jsonrpc: '2.0', id, method })

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let lineEnd = buffer.indexOf('\n')
  while (lineEnd >= 0) {
    const line = buffer.slice(0, lineEnd).trim()
    buffer = buffer.slice(lineEnd + 1)
    if (line) handle(JSON.parse(line))
    lineEnd = buffer.indexOf('\n')
  }
})

function handle(message) {
  if (message.method === 'host/initialize') {
    if (mode === 'hang') return
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocol: mode === 'mismatch' ? 'lcode.rpc/999' : 'lcode.rpc/1',
        plugin: { id: 'com.example.test-plugin', version: '1.0.0' },
      },
    })
    if (mode === 'crash') return setTimeout(() => process.exit(23), 15)
    if (mode === 'denied') return request(8, 'ctx/fs/write')
    return request(7, 'ctx/capabilities')
  }
  if (message.id === 7 && 'result' in message) {
    send({ jsonrpc: '2.0', method: 'test/capabilities', params: message.result })
  }
  if (message.id === 8 && 'error' in message) {
    send({ jsonrpc: '2.0', method: 'test/denied', params: message.error })
  }
  if (message.method === 'host/shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null })
    process.exit(0)
  }
}
`

const manifest = parsePluginManifest({
  $schema: PLUGIN_MANIFEST_SCHEMA,
  id: 'com.example.test-plugin',
  name: 'Test plugin',
  version: '1.0.0',
  engines: { lcode: '>=0.1.0 <1.0.0' },
  entry: './dist/index.js',
  permissions: {
    fs: { read: ['${workspace}/docs/**'] },
    network: { domains: ['api.example.com'] },
  },
  contributes: {},
})

describe('PluginHostClient', () => {
  it('uses a sandboxed utility process and exposes only its manifest capability catalog', async () => {
    let wrapped = false
    const notification = waitForNotification('test/capabilities')
    const client = await createPluginHost(options('ok', (method, params) => notification.observe(method, params), () => {
      wrapped = true
    }))
    try {
      await expect(notification.result).resolves.toEqual({
        fs: { read: ['${workspace}/docs/**'], write: [] },
        network: ['api.example.com'],
        spawn: [],
        env: [],
      })
      expect(client.capabilities.fs.write).toEqual([])
      expect(wrapped).toBe(true)
      expect(client.state).toBe('running')
    } finally {
      await client.close()
    }
    expect(client.state).toBe('closed')
  })

  it('rejects an undeclared ctx call without granting a raw host capability', async () => {
    const notification = waitForNotification('test/denied')
    const client = await createPluginHost(options('denied', (method, params) => notification.observe(method, params)))
    try {
      await expect(notification.result).resolves.toMatchObject({ code: 'EX-UNDECLARED_PERMISSION' })
    } finally {
      await client.close()
    }
  })

  it('rejects incompatible protocol versions before the plugin can run', async () => {
    await expect(createPluginHost(options('mismatch'))).rejects.toMatchObject({ code: 'EX-INCOMPATIBLE' })
  })

  it('isolates utility-process crashes from the caller', async () => {
    const client = await createPluginHost(options('crash'))
    await expect(client.exited).resolves.toMatchObject({ code: 23 })
    expect(client.state).toBe('crashed')
    await expect(client.request('plugin/ping')).rejects.toMatchObject({ code: 'EX-HOST_UNAVAILABLE' })
  })

  it('times out a host that never acknowledges initialization', async () => {
    await expect(createPluginHost(options('hang', undefined, undefined, 80))).rejects.toMatchObject({ code: 'EX-HOST_UNAVAILABLE' })
  })
})

function options(
  mode: string,
  onNotification?: (method: string, params: unknown) => void,
  onWrap?: () => void,
  timeoutMs?: number,
) {
  return {
    manifest,
    argv: [process.execPath, '-e', utilityHost, mode],
    cwd: process.cwd(),
    workspace: { root: process.cwd(), trusted: true },
    subprocess: createLocalSubprocess(),
    sandbox: {
      policy: { kind: 'test' },
      wrap: async (argv: readonly string[]) => {
        onWrap?.()
        return { enforced: true, wrappedArgv: argv }
      },
    },
    ...(onNotification === undefined ? {} : { onNotification }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function waitForNotification(expectedMethod: string) {
  let resolve!: (params: unknown) => void
  const result = new Promise<unknown>((next) => {
    resolve = next
  })
  return {
    result,
    observe(method: string, params: unknown): void {
      if (method === expectedMethod) resolve(params)
    },
  }
}
