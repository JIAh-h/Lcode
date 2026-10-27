import type {} from '@lcode/context'
import { canonicalPath, isInsideWorkspace, normalizePath } from '@lcode/fs'
import type {
  FsEditInput,
  FsEditResult,
  FsGlobOpts,
  FsGlobResult,
  FsGrepOpts,
  FsGrepResult,
  FsMutationAuthority,
  FsReadOpts,
  FsReadResult,
  FsService,
  FsStat,
  FsWriteOpts,
  FsWriteResult,
} from '@lcode/fs'
import type { SandboxMode, SandboxService } from '@lcode/sandbox'
import type { SpawnedProcess, SubprocessService } from '@lcode/subprocess'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'

/**
 * 受 OS 沙箱约束的文件服务。
 *
 * 工作区内的读写交给一个受 AppContainer/Seatbelt 约束的持久 worker；工作区外仍走
 * `base`（已按策略审批的路径），避免“批准了工作区外写、却被工作区 ACL 拒绝”的行为回退。
 * worker 只接受本文件内定义的协议，模型不能让它执行任意代码。
 */
export interface SandboxedFsOptions {
  /** 本地实现；工作区外操作与沙箱不可用时使用。必须配置 mutationAuthority。 */
  readonly base: FsService
  readonly sandbox: SandboxService
  readonly subprocess: SubprocessService
  readonly workspaceRoot: string
  /** `fs-worker.cjs` 的源码；由装配层从安装包读取。 */
  readonly workerSource: string
  /** 当前权限预设对应的沙箱档位；变化时重启 worker。 */
  readonly mode: () => SandboxMode
  readonly mutationAuthority?: FsMutationAuthority | undefined
  /** worker 无法启动时的诊断回调（只回调一次）。 */
  readonly onUnavailable?: ((reason: string) => void) | undefined
}

export interface SandboxedFs extends FsService {
  dispose(): Promise<void>
}

/** 按会话工作区取 fs；工具层用它，避免单例 fs 把 A 会话的路径当成默认工作区。 */
export type SandboxedFsResolver = (workspaceRoot: string) => FsService

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    fsFor: SandboxedFsResolver
  }
}

interface WorkerSession {
  readonly proc: SpawnedProcess
  readonly mode: SandboxMode
  readonly pending: Map<number, {
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>
  buffer: string
  closed: boolean
  stderr: string
}

interface WorkerReply {
  readonly id?: number
  readonly type?: string
  readonly ok?: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: string; readonly message?: string; readonly userMessage?: string }
}

const readySettlers = new WeakMap<WorkerSession, { resolve: () => void; reject: (error: Error) => void }>()

export function createSandboxedFs(options: SandboxedFsOptions): SandboxedFs {
  const root = normalizePath(resolve(options.workspaceRoot))
  let worker: WorkerSession | undefined
  let starting: Promise<WorkerSession | undefined> | undefined
  let requestId = 0
  let unavailableReported = false
  /** Provider 声称可用、但 worker 起不来：不能静默回退到无 OS 边界的 fs-local。 */
  let hardFailure = false
  const unavailable = (reason: string): undefined => {
    if (!unavailableReported) {
      unavailableReported = true
      options.onUnavailable?.(reason)
    }
    return undefined
  }
  const workerUnavailable = (): LcodeErrorImpl => new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_READY,
    message: '受控文件执行器不可用',
    userMessage: '当前安全沙箱无法启动文件执行器，已拒绝执行文件操作。',
    retryable: false,
  })

  const closeWorker = async (): Promise<void> => {
    const current = worker
    worker = undefined
    if (current === undefined) return
    current.closed = true
    rejectPending(current, new Error('受控文件执行器已关闭'))
    await current.proc.killTree().catch(() => undefined)
  }

  const ensureWorker = async (): Promise<WorkerSession | undefined> => {
    const mode = options.mode()
    if (mode === 'danger-full-access') {
      await closeWorker()
      hardFailure = false
      return undefined
    }
    if (worker !== undefined && !worker.closed && worker.mode === mode) return worker
    if (starting !== undefined) {
      const pending = await starting
      if (pending !== undefined && !pending.closed && pending.mode === mode) return pending
    }
    starting = startWorker(mode)
    try {
      return await starting
    } finally {
      starting = undefined
    }
  }

  const startWorker = async (mode: SandboxMode): Promise<WorkerSession | undefined> => {
    await closeWorker()
    const status = await options.sandbox.status().catch(() => undefined)
    if (status?.providerAvailable === false) {
      hardFailure = false
      return unavailable(status.reason ?? '沙箱 Provider 不可用')
    }

    const bootstrap = workerBootstrap(options.workerSource)
    const wrapped = await options.sandbox.wrap(
      [process.execPath, '--eval', bootstrap],
      { mode, workspaceRoot: root, allowNetwork: false },
    ).catch(() => undefined)
    if (wrapped === undefined || !wrapped.enforced) {
      hardFailure = true
      return unavailable(wrapped?.degradationReason ?? '沙箱包装失败')
    }

    const env = environmentForWorker(root)
    const proc = await options.subprocess.spawn({
      argv: wrapped.wrappedArgv,
      cwd: root,
      env,
    }).catch(() => undefined)
    if (proc === undefined || proc.writeStdin === undefined) {
      await proc?.killTree().catch(() => undefined)
      hardFailure = true
      return unavailable('受控进程没有可用的标准输入')
    }

    const session: WorkerSession = {
      proc,
      mode,
      pending: new Map(),
      buffer: '',
      closed: false,
      stderr: '',
    }
    worker = session
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('受控文件执行器启动超时')), 15_000)
      const settle = (): void => { clearTimeout(timer) }
      readySettlers.set(session, { resolve: () => { settle(); resolveReady() }, reject: (error) => { settle(); rejectReady(error) } })
    })
    proc.stdout.on('data', (chunk: Buffer | string) => onOutput(session, chunk.toString()))
    proc.stderr.on('data', (chunk: Buffer | string) => {
      session.stderr = (session.stderr + chunk.toString()).slice(-4_000)
    })
    void proc.exited.then(() => {
      session.closed = true
      rejectPending(session, new Error(`受控文件执行器已退出${session.stderr === '' ? '' : `：${session.stderr.trim()}`}`))
      readySettlers.get(session)?.reject(new Error('受控文件执行器启动失败'))
      readySettlers.delete(session)
    })
    try {
      await ready
      hardFailure = false
      return session
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await closeWorker()
      hardFailure = true
      return unavailable(`${reason}${session.stderr === '' ? '' : `：${session.stderr.trim()}`}`)
    }
  }

  const request = async <T>(session: WorkerSession, op: Record<string, unknown>): Promise<T> => {
    if (session.closed || session.proc.writeStdin === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: '受控文件执行器已关闭',
        userMessage: '文件执行器已关闭，请重试。',
        retryable: false,
      })
    }
    const id = ++requestId
    const result = new Promise<T>((resolveValue, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new LcodeErrorImpl({
          code: ERROR_CODES.ET_ERROR,
          message: '受控文件执行器响应超时',
          userMessage: '文件操作超时，请重试。',
          retryable: true,
        }))
      }, 30_000)
      session.pending.set(id, {
        resolve: (value) => resolveValue(value as T),
        reject,
        timer,
      })
      session.proc.writeStdin?.(`${JSON.stringify({ id, ...op })}\n`)
    })
    return await result
  }

  const pathOf = (value: string): string => canonicalPath(normalizePath(resolve(root, value)))
  const inside = (file: string): boolean => isInsideWorkspace(root, file)

  const withWorker = async <T>(op: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> => {
    const session = await ensureWorker()
    if (session === undefined) {
      if (hardFailure) throw workerUnavailable()
      return await fallback()
    }
    return await request<T>(session, op)
  }

  return {
    async read(path, opts: FsReadOpts = {}): Promise<FsReadResult> {
      const file = pathOf(path)
      if (!inside(file)) return await options.base.read(file, opts)
      return await withWorker(
        { op: 'read', path: file, ...(opts.offset === undefined ? {} : { offset: opts.offset }), ...(opts.limit === undefined ? {} : { limit: opts.limit }) },
        async () => await options.base.read(file, opts),
      )
    },

    async write(path, data, opts: FsWriteOpts = {}): Promise<FsWriteResult> {
      const file = pathOf(path)
      if (!inside(file)) return await options.base.write(file, data, opts)
      const session = await ensureWorker()
      if (session === undefined) {
        if (hardFailure) throw workerUnavailable()
        return await options.base.write(file, data, opts)
      }
      options.mutationAuthority?.consume(opts.mutationAccess, file)
      return await request<FsWriteResult>(session, {
        op: 'write',
        path: file,
        data,
        createDirs: opts.createDirs !== false,
      })
    },

    async edit(input: FsEditInput): Promise<FsEditResult> {
      const file = pathOf(input.path)
      if (!inside(file)) return await options.base.edit({ ...input, path: file })
      const session = await ensureWorker()
      if (session === undefined) {
        if (hardFailure) throw workerUnavailable()
        return await options.base.edit({ ...input, path: file })
      }
      options.mutationAuthority?.consume(input.mutationAccess, file)
      return await request<FsEditResult>(session, {
        op: 'edit',
        path: file,
        oldText: input.oldText,
        newText: input.newText,
        replaceAll: input.replaceAll === true,
      })
    },

    async glob(pattern, opts: FsGlobOpts = {}): Promise<FsGlobResult> {
      const file = pathOf(opts.path ?? '.')
      if (!inside(file)) return await options.base.glob(pattern, { ...opts, path: file })
      return await withWorker(
        { op: 'glob', pattern, path: file, ...(opts.include === undefined ? {} : { include: opts.include }), ...(opts.maxResults === undefined ? {} : { maxResults: opts.maxResults }) },
        async () => await options.base.glob(pattern, { ...opts, path: file }),
      )
    },

    async grep(pattern, opts: FsGrepOpts = {}): Promise<FsGrepResult> {
      const file = pathOf(opts.path ?? '.')
      if (!inside(file)) return await options.base.grep(pattern, { ...opts, path: file })
      return await withWorker(
        {
          op: 'grep',
          pattern,
          path: file,
          ...(opts.include === undefined ? {} : { include: opts.include }),
          ...(opts.maxResults === undefined ? {} : { maxResults: opts.maxResults }),
          ...(opts.caseSensitive === undefined ? {} : { caseSensitive: opts.caseSensitive }),
        },
        async () => await options.base.grep(pattern, { ...opts, path: file }),
      )
    },

    async stat(path): Promise<FsStat> {
      const file = pathOf(path)
      if (!inside(file)) return await options.base.stat(file)
      return await withWorker(
        { op: 'stat', path: file },
        async () => await options.base.stat(file),
      )
    },

    async readdir(path): Promise<readonly string[]> {
      const file = pathOf(path)
      if (!inside(file)) return await options.base.readdir(file)
      return await withWorker(
        { op: 'readdir', path: file },
        async () => await options.base.readdir(file),
      )
    },

    async dispose(): Promise<void> {
      await closeWorker()
    },
  }

  function onOutput(session: WorkerSession, chunk: string): void {
    session.buffer += chunk
    for (;;) {
      const newline = session.buffer.indexOf('\n')
      if (newline < 0) break
      const line = session.buffer.slice(0, newline).trim()
      session.buffer = session.buffer.slice(newline + 1)
      if (line === '') continue
      let reply: WorkerReply
      try {
        reply = JSON.parse(line) as WorkerReply
      } catch {
        continue
      }
      if (reply.type === 'ready') {
        readySettlers.get(session)?.resolve()
        readySettlers.delete(session)
        continue
      }
      if (typeof reply.id !== 'number') continue
      const pending = session.pending.get(reply.id)
      if (pending === undefined) continue
      session.pending.delete(reply.id)
      clearTimeout(pending.timer)
      if (reply.ok === true) pending.resolve(reply.value)
      else pending.reject(workerError(reply.error))
    }
  }
}

function rejectPending(session: WorkerSession, error: Error): void {
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  session.pending.clear()
}

function workerError(error: WorkerReply['error']): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: error?.code === 'ET-INVALID_ARGS' ? ERROR_CODES.ET_INVALID_ARGS : ERROR_CODES.ET_ERROR,
    message: error?.message ?? '文件操作失败',
    userMessage: error?.userMessage ?? '文件操作失败，已拒绝执行。',
    retryable: false,
  })
}

function workerBootstrap(source: string): string {
  const encoded = gzipSync(Buffer.from(source, 'utf8')).toString('base64')
  return `eval(require('node:zlib').gunzipSync(Buffer.from('${encoded}','base64')).toString('utf8'))`
}

function environmentForWorker(workspaceRoot: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env['ELECTRON_RUN_AS_NODE'] = '1'
  env['LCODE_FS_WORKSPACE'] = workspaceRoot
  return env
}
