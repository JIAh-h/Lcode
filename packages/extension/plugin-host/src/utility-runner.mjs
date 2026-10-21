import { pathToFileURL } from 'node:url'

const entryPath = process.argv[2]
if (typeof entryPath !== 'string' || entryPath.length === 0) {
  process.stderr.write('plugin entry path is required\n')
  process.exit(64)
}

let buffer = ''
let nextRequestId = 1
const pending = new Map()
const tools = new Map()
const listeners = new Map()
let nextListenerId = 1
let activationDispose

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let lineEnd = buffer.indexOf('\n')
  while (lineEnd >= 0) {
    const line = buffer.slice(0, lineEnd).trim()
    buffer = buffer.slice(lineEnd + 1)
    if (line) void receive(line)
    lineEnd = buffer.indexOf('\n')
  }
})

async function receive(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write('invalid core RPC message\n')
    process.exit(65)
  }
  if (message?.jsonrpc !== '2.0') return
  if (typeof message.id === 'number' && typeof message.method === 'string') {
    await requestFromCore(message)
    return
  }
  if (typeof message.id === 'number') {
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if ('error' in message) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    else waiter.resolve(message.result)
  }
}

async function requestFromCore(message) {
  try {
    if (message.method === 'host/initialize') {
      await activate(message.params)
      return sendResult(message.id, {
        protocol: 'lcode.rpc/1',
        plugin: { id: message.params.plugin.id, version: message.params.plugin.version },
      })
    }
    if (message.method === 'plugin/tool.execute') {
      const { name, args, callId } = message.params ?? {}
      const execute = tools.get(name)
      if (typeof name !== 'string' || execute === undefined) throw new Error(`unknown plugin tool: ${String(name)}`)
      return sendResult(message.id, await execute(args, { callId }))
    }
    if (message.method === 'plugin/event') {
      const { listenerId, payload } = message.params ?? {}
      const handler = listeners.get(listenerId)
      if (handler !== undefined) await handler(payload)
      return sendResult(message.id, null)
    }
    if (message.method === 'host/shutdown') {
      await activationDispose?.()
      sendResult(message.id, null)
      process.exit(0)
    }
    throw new Error(`unsupported core method: ${message.method}`)
  } catch (error) {
    sendError(message.id, error)
  }
}

async function activate(params) {
  const module = await import(pathToFileURL(entryPath).href)
  if (typeof module.activate !== 'function') throw new Error('plugin entry must export activate(context)')
  const dispose = await module.activate(createContext(params.capabilities))
  if (dispose !== undefined && typeof dispose !== 'function') throw new Error('plugin activate() must return a disposer when it returns a value')
  activationDispose = dispose
}

function createContext(capabilities) {
  return {
    capabilities,
    request,
    async registerTool(spec, execute) {
      if (typeof execute !== 'function') throw new Error('tool execute must be a function')
      await request('ctx/registerTool', spec)
      tools.set(spec.name, execute)
    },
    async registerPromptSection(id, content, order) {
      await request('ctx/registerPromptSection', { id, content, ...(order === undefined ? {} : { order }) })
    },
    async on(event, handler) {
      if (typeof handler !== 'function') throw new Error('event handler must be a function')
      const listenerId = `${event}:${nextListenerId++}`
      await request('ctx/registerListener', { event, listenerId })
      listeners.set(listenerId, handler)
    },
  }
}

function request(method, params) {
  const id = nextRequestId++
  send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, error) {
  send({ jsonrpc: '2.0', id, error: { code: error?.code ?? 'EX-ACTIVATION_FAILED', message: error instanceof Error ? error.message : String(error) } })
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
