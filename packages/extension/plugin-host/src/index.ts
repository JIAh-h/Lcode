import type { PluginManifest } from '@lcode/plugin-manifest'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_RPC_PROTOCOL,
  capabilityCatalogFor,
  type PluginCapabilityCatalog,
  type PluginHostInitializeParams,
  type PluginHostInitializeResult,
  type PluginRpcFailure,
  type PluginRpcMessage,
  type PluginRpcRequest,
} from '@lcode/plugin-sdk'
import type { SpawnedProcess, SubprocessService } from '@lcode/subprocess'
import { ERROR_CODES, LcodeErrorImpl, isLcodeError, type ErrorCode } from '@lcode/util'

export * from './lifecycle.js'

/**
 * Trusted bootstrap owned by this package, never supplied by a plugin manifest.
 * In an Electron bundle the desktop build copies this file next to `main.js`.
 */
export const pluginUtilityRunnerPath = fileURLToPath(new URL('./utility-runner.mjs', import.meta.url))

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 1_048_576

export type PluginHostState = 'starting' | 'running' | 'crashed' | 'closed'

export interface PluginHostExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface PluginHostSandbox {
  readonly policy: unknown
  readonly wrap: (argv: readonly string[], policy: unknown) => Promise<{
    readonly wrappedArgv: readonly string[]
    readonly enforced: boolean
  }>
}

export interface PluginHostOptions {
  readonly manifest: PluginManifest
  /** A trusted utility-host bootstrap command. P6-04 owns entry activation. */
  readonly argv: readonly string[]
  readonly cwd: string
  readonly workspace: Readonly<{
    root: string
    trusted: boolean
  }>
  readonly subprocess: SubprocessService
  readonly sandbox: PluginHostSandbox
  readonly timeoutMs?: number
  readonly onNotification?: (method: string, params: unknown) => void
  /** The core-owned bridge for declared plugin registrations. */
  readonly onRequest?: (method: string, params: unknown) => Promise<unknown>
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class PluginHostClient {
  readonly capabilities: PluginCapabilityCatalog
  readonly exited: Promise<PluginHostExit>

  #state: PluginHostState = 'starting'
  #nextRequestId = 1
  #buffer = ''
  #pending = new Map<number, PendingRequest>()
  #resolveExit!: (value: PluginHostExit) => void

  constructor(
    private readonly process: SpawnedProcess,
    private readonly options: PluginHostOptions,
  ) {
    this.capabilities = capabilityCatalogFor(options.manifest.permissions)
    this.exited = new Promise<PluginHostExit>((resolve) => {
      this.#resolveExit = resolve
    })
    this.process.stdout.on('data', (chunk: Buffer | string) => this.#consume(chunk.toString()))
    this.process.exited.then(({ code, signal }) => this.#finish({ code, signal }))
  }

  get state(): PluginHostState {
    return this.#state
  }

  async initialize(): Promise<void> {
    const params: PluginHostInitializeParams = {
      protocol: PLUGIN_RPC_PROTOCOL,
      plugin: {
        id: this.options.manifest.id,
        version: this.options.manifest.version,
        entry: this.options.manifest.entry,
      },
      workspace: this.options.workspace,
      capabilities: this.capabilities,
    }
    const result = await this.request<PluginHostInitializeResult>('host/initialize', params)
    if (result.protocol !== PLUGIN_RPC_PROTOCOL) {
      await this.close()
      throw failure(ERROR_CODES.EX_INCOMPATIBLE, `Plugin host uses unsupported protocol: ${result.protocol}`)
    }
    if (result.plugin.id !== this.options.manifest.id || result.plugin.version !== this.options.manifest.version) {
      await this.close()
      throw failure(ERROR_CODES.EX_INCOMPATIBLE, 'Plugin host identity does not match its verified manifest')
    }
    this.#state = 'running'
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#state === 'crashed' || this.#state === 'closed') {
      return Promise.reject(failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin utility host is not running'))
    }
    const id = this.#nextRequestId++
    const message: PluginRpcRequest = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(failure(ERROR_CODES.EX_HOST_UNAVAILABLE, `Plugin host timed out while handling ${method}`))
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.#send(message)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : failure(ERROR_CODES.EX_HOST_UNAVAILABLE, String(error)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return
    const wasRunning = this.#state === 'running'
    if (wasRunning) {
      try {
        await this.request('host/shutdown')
      } catch {
        // A crashed plugin cannot acknowledge shutdown. Killing its process is enough.
      }
    }
    this.#state = 'closed'
    await this.process.killTree()
  }

  #consume(chunk: string): void {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer) > MAX_MESSAGE_BYTES) {
      void this.#abort(failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin host emitted an oversized RPC message'))
      return
    }
    let lineEnd = this.#buffer.indexOf('\n')
    while (lineEnd >= 0) {
      const line = this.#buffer.slice(0, lineEnd).trim()
      this.#buffer = this.#buffer.slice(lineEnd + 1)
      if (line) this.#receive(line)
      lineEnd = this.#buffer.indexOf('\n')
    }
  }

  #receive(line: string): void {
    const message = parseRpcMessage(line)
    if (message === undefined) {
      void this.#abort(failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin host wrote non-RPC data to stdout'))
      return
    }
    if ('method' in message && 'id' in message) {
      void this.#handlePluginRequest(message)
      return
    }
    if ('method' in message) {
      this.options.onNotification?.(message.method, message.params)
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if ('error' in message) pending.reject(remoteFailure(message))
    else pending.resolve(message.result)
  }

  async #handlePluginRequest(request: PluginRpcRequest): Promise<void> {
    if (request.method === 'ctx/capabilities') {
      this.#send({ jsonrpc: '2.0', id: request.id, result: this.capabilities })
      return
    }
    if (this.options.onRequest !== undefined) {
      try {
        const result = await this.options.onRequest(request.method, request.params)
        this.#send({ jsonrpc: '2.0', id: request.id, result })
      } catch (error) {
        const lcode = isLcodeError(error)
          ? error
          : failure(ERROR_CODES.EX_ACTIVATION_FAILED, 'Plugin registration failed')
        this.#send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: lcode.code, message: lcode.message },
        })
      }
      return
    }
    this.#send({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: ERROR_CODES.EX_UNDECLARED_PERMISSION,
        message: `Plugin host is not allowed to call ${request.method}`,
      },
    })
  }

  #send(message: PluginRpcMessage): void {
    if (!this.process.writeStdin?.(`${JSON.stringify(message)}\n`)) {
      throw failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin host stdin is unavailable')
    }
  }

  async #abort(error: Error): Promise<void> {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    await this.process.killTree()
  }

  #finish(exit: PluginHostExit): void {
    if (this.#state !== 'closed') this.#state = 'crashed'
    this.#resolveExit(exit)
    const error = failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin utility host exited')
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

export async function createPluginHost(options: PluginHostOptions): Promise<PluginHostClient> {
  if (options.argv.length === 0) {
    throw failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin utility host command is required')
  }
  const sandboxed = await options.sandbox.wrap(options.argv, options.sandbox.policy)
  if (!sandboxed.enforced) {
    throw failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Refusing to start a plugin utility host without an enforced sandbox')
  }
  const process = await options.subprocess.spawn({ argv: sandboxed.wrappedArgv, cwd: options.cwd })
  if (!process.writeStdin) {
    await process.killTree()
    throw failure(ERROR_CODES.EX_HOST_UNAVAILABLE, 'Plugin utility host does not provide stdin')
  }
  const client = new PluginHostClient(process, options)
  try {
    await client.initialize()
    return client
  } catch (error) {
    await process.killTree()
    throw error
  }
}

function remoteFailure(message: PluginRpcFailure): Error {
  const code = Object.values(ERROR_CODES).includes(message.error.code as ErrorCode)
    ? message.error.code as ErrorCode
    : ERROR_CODES.EX_HOST_UNAVAILABLE
  return failure(
    code,
    message.error.message,
    message.error.data,
  )
}

function parseRpcMessage(line: string): PluginRpcMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.jsonrpc !== '2.0') return undefined
  if (typeof value.method === 'string') {
    if (value.id === undefined) {
      return value.params === undefined
        ? { jsonrpc: '2.0', method: value.method }
        : { jsonrpc: '2.0', method: value.method, params: value.params }
    }
    if (typeof value.id !== 'number') return undefined
    return value.params === undefined
      ? { jsonrpc: '2.0', id: value.id, method: value.method }
      : { jsonrpc: '2.0', id: value.id, method: value.method, params: value.params }
  }
  if (typeof value.id !== 'number') return undefined
  if ('result' in value && !('error' in value)) return { jsonrpc: '2.0', id: value.id, result: value.result }
  if (
    !('result' in value) &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  ) {
    return value.error.data === undefined
      ? { jsonrpc: '2.0', id: value.id, error: { code: value.error.code, message: value.error.message } }
      : { jsonrpc: '2.0', id: value.id, error: { code: value.error.code, message: value.error.message, data: value.error.data } }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failure(code: ErrorCode, message: string, details?: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code,
    message,
    userMessage: message,
    retryable: false,
    ...(details === undefined ? {} : { details: details as never }),
  })
}
