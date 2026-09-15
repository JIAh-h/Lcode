/**
 * 异步工具：退避重试 / 超时 / deferred / 可取消延时。
 * 所有长操作必须接受 AbortSignal（文档 23 §7.3：异步操作必须可取消）。
 */

export interface Deferred<T = void> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface TimeoutOptions {
  signal?: AbortSignal
  onTimeout?: () => void
}

/** 带超时的 Promise 竞速；超时抛 TimeoutError（可由调用方映射为具名错误码） */
export class TimeoutError extends Error {
  constructor(message = 'operation timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, opts: TimeoutOptions = {}): Promise<T> {
  const ac = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // 竞速分支。**必须有它**：只 `ac.abort()` 是不够的——被调方完全可能不理会 signal
  // （比如一个永不 resolve 的 Promise），那样调用方会被无限挂住，超时形同虚设。
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      ac.abort()
      opts.onTimeout?.()
      reject(new TimeoutError())
    }, ms)
  })

  const onOuterAbort = () => ac.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    return await Promise.race([fn(ac.signal), timeout])
  } catch (err) {
    // 因**我们**超时而失败时统一成 TimeoutError（被调方可能抛的是 AbortError）；
    // 外层主动取消导致的不改写，保留原始原因（调用方要能区分"我取消了"与"超时了"）
    if (timedOut && !(err instanceof TimeoutError) && opts.signal?.aborted !== true) {
      throw new TimeoutError()
    }
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3 */
  maxAttempts?: number
  /** 基础退避毫秒，默认 200；每次 ×2 */
  baseDelayMs?: number
  signal?: AbortSignal
  /** 决定哪些失败可重试；默认全部可重试 */
  shouldRetry?: (err: unknown, attempt: number) => boolean
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void
}

/** 指数退避重试（文档 21：EL-RATE_LIMITED 等可重试错误走此路径） */
export async function retry<T>(fn: (attempt: number, signal: AbortSignal) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 200
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt, opts.signal ?? new AbortController().signal)
    } catch (err) {
      lastErr = err
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) throw err
      if (attempt >= maxAttempts - 1) break
      const delay = baseDelayMs * 2 ** attempt
      opts.onRetry?.(err, attempt, delay)
      await sleep(delay, opts.signal)
    }
  }
  throw lastErr
}

/** 可取消延时（AbortSignal 触发时立即返回） */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
