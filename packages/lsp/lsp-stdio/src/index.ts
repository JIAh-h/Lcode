import type { SpawnedProcess, SubprocessService } from '@lcode/subprocess'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/** 与 `@lcode/sandbox` 的 ResolvedSandboxPolicy 结构兼容，避免传输 Provider 反向依赖沙箱实现。 */
export interface LspSandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly writableRoots?: readonly string[] | undefined
  readonly allowNetwork?: boolean | undefined
}

export interface LspStdioClientOptions {
  /** 语言服务器的 argv，不接受 shell 字符串。 */
  readonly argv: readonly string[]
  readonly cwd: string
  /** 唯一的进程入口；实现包不直接调用 `child_process`。 */
  readonly subprocess: SubprocessService
  /** 由运行时注入；用于将 LSP 进程放进与 shell 相同的沙箱边界。 */
  readonly wrap?: ((argv: readonly string[], policy: LspSandboxPolicy) => Promise<{ readonly enforced: boolean; readonly wrappedArgv: readonly string[] }>) | undefined
  readonly sandboxPolicy?: LspSandboxPolicy | undefined
}

export interface LspStdioClient {
  readonly pid: number
  readonly sandbox: { readonly enforced: boolean }
  readonly state: 'running' | 'closed'
  request<TResult = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult>
  notify(method: string, params?: unknown): void
  close(): Promise<void>
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly removeAbort: () => void
}

interface JsonRpcResponse {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | undefined
}

/**
 * 建立一个 LSP stdio JSON-RPC 2.0 客户端。
 *
 * 这是语言服务器的传输 Provider，而非具体语言的配置器：调用方显式提供 argv，未来
 * `tool-lsp` 再把 definition/references/diagnostics 映射到这些 RPC 方法。服务器退出、
 * 非法帧、请求中止都会收束未完成请求，并通过 `killTree` 保证不会留下后台进程。
 */
export async function createLspStdioClient(options: LspStdioClientOptions): Promise<LspStdioClient> {
  if (options.argv.length === 0 || options.argv[0]?.trim() === '') {
    throw invalidArgs('LSP argv 不能为空。')
  }

  const policy = options.sandboxPolicy ?? { mode: 'workspace-write' as const, workspaceRoot: options.cwd }
  const wrapped = options.wrap === undefined
    ? { enforced: false, wrappedArgv: [...options.argv] }
    : await options.wrap(options.argv, policy)
  if (wrapped.wrappedArgv.length === 0) throw notReady('LSP 沙箱没有返回可执行命令。')

  const child = await options.subprocess.spawn({ argv: wrapped.wrappedArgv, cwd: options.cwd })
  if (child.writeStdin === undefined) {
    await child.killTree()
    throw notReady('当前子进程 Provider 不支持受控 stdin，不能启动 LSP。')
  }

  return bindClient(child, wrapped.enforced)
}

function bindClient(child: SpawnedProcess, enforced: boolean): LspStdioClient {
  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let state: 'running' | 'closed' = 'running'
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  const close = async (): Promise<void> => {
    if (state === 'closed') return
    state = 'closed'
    rejectAll(pending, new Error('LSP 客户端已关闭。'))
    await child.killTree()
  }

  const fail = (reason: Error): void => {
    if (state === 'closed') return
    state = 'closed'
    rejectAll(pending, reason)
    void child.killTree()
  }

  child.stdout.on('data', (chunk: Buffer | Uint8Array | string) => {
    try {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      buffer = consumeFrames(buffer, (message) => settleResponse(message, pending))
    } catch (cause) {
      fail(new Error(`LSP stdio 帧无效：${cause instanceof Error ? cause.message : String(cause)}`))
    }
  })
  child.exited.then((exit) => {
    if (state === 'closed') return
    state = 'closed'
    rejectAll(pending, new Error(`LSP 服务器已退出（code=${String(exit.code)}，signal=${String(exit.signal)}）。`))
  })

  const send = (message: unknown): void => {
    if (state !== 'running') throw new Error('LSP 客户端已经关闭。')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
    const accepted = child.writeStdin?.(frame)
    if (accepted !== true) fail(new Error('LSP stdin 已关闭，无法发送请求。'))
  }

  return {
    pid: child.pid,
    sandbox: { enforced },
    get state() { return state },
    request<TResult = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<TResult> {
      if (method.trim() === '') return Promise.reject(invalidArgs('LSP method 不能为空。'))
      if (signal?.aborted === true) return Promise.reject(aborted())
      const id = nextId++
      return new Promise<TResult>((resolve, reject) => {
        const onAbort = (): void => {
          pending.delete(id)
          reject(aborted())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve: (value) => resolve(value as TResult),
          reject,
          removeAbort: () => signal?.removeEventListener('abort', onAbort),
        })
        try {
          send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        } catch (cause) {
          pending.delete(id)
          signal?.removeEventListener('abort', onAbort)
          reject(cause)
        }
      })
    },
    notify(method: string, params?: unknown): void {
      if (method.trim() === '') throw invalidArgs('LSP method 不能为空。')
      send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
    },
    close,
  }
}

function consumeFrames(buffer: Buffer<ArrayBufferLike>, onMessage: (message: JsonRpcResponse) => void): Buffer<ArrayBufferLike> {
  let rest = buffer
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd === -1) return rest
    const header = rest.subarray(0, headerEnd).toString('ascii')
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header)
    if (match?.[1] === undefined) throw new Error('缺少 Content-Length。')
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length < 0 || length > 10 * 1024 * 1024) throw new Error('Content-Length 超出限制。')
    const bodyStart = headerEnd + 4
    if (rest.length < bodyStart + length) return rest
    const body = rest.subarray(bodyStart, bodyStart + length)
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('JSON-RPC 消息必须是对象。')
    onMessage(parsed as JsonRpcResponse)
    rest = rest.subarray(bodyStart + length)
  }
}

function settleResponse(message: JsonRpcResponse, pending: Map<number, PendingRequest>): void {
  if (message.jsonrpc !== '2.0' || typeof message.id !== 'number') return
  const request = pending.get(message.id)
  if (request === undefined) return
  pending.delete(message.id)
  request.removeAbort()
  if (message.error !== undefined) {
    request.reject(new Error(`LSP 请求失败：${typeof message.error.message === 'string' ? message.error.message : '未知错误'}。`))
    return
  }
  request.resolve(message.result)
}

function rejectAll(pending: Map<number, PendingRequest>, reason: Error): void {
  for (const request of pending.values()) {
    request.removeAbort()
    request.reject(reason)
  }
  pending.clear()
}

function invalidArgs(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.ET_INVALID_ARGS, message, userMessage: message, retryable: false })
}

function notReady(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EC_NOT_READY, message, userMessage: message, retryable: false })
}

function aborted(): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.ET_ABORTED, message: 'LSP 请求已取消。', userMessage: 'LSP 请求已取消。', retryable: false })
}
