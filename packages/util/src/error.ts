import type { ErrorCode } from './error-codes.ts'
import type { JsonValue } from './guard.ts'

/**
 * 错误分类（= code 前缀语义，文档 21 §6.1）。
 */
export type ErrorCategory =
  | 'client'
  | 'session'
  | 'tool'
  | 'permission'
  | 'model'
  | 'plugin'
  | 'filesystem'
  | 'network'
  | 'model-output'
  | 'job'

export const ERROR_CATEGORY_BY_PREFIX: Readonly<Record<string, ErrorCategory>> = {
  EC: 'client',
  ES: 'session',
  ET: 'tool',
  EP: 'permission',
  EL: 'model',
  EX: 'plugin',
  EF: 'filesystem',
  EN: 'network',
  EM: 'model-output',
  EJ: 'job',
}

export interface ErrorCause {
  code?: string | undefined
  message: string
  stackDigest?: string | undefined
}

/**
 * 所有边界的错误一律归一化为同一个对象（文档 21 §6.1）。
 * 内部 RPC 的 error、UI IPC 的 reject、外部协议 error.data 都是它。
 */
export interface LcodeError {
  /** 稳定、机器可路由的标识（E?-UPPER_SNAKE）。按它路由，绝不按 message/userMessage 文本。 */
  readonly code: ErrorCode
  /** 粗粒度分类，等于 code 的前缀语义。 */
  readonly category: ErrorCategory
  /** 面向研发的诊断信息：可含内部术语、路径、堆栈摘要。不得含凭据值（I7）。 */
  readonly message: string
  /** 面向用户的人话。必须通过 19 §6.2 术语黑名单。 */
  readonly userMessage: string
  /** 调用方可据此决定是否退避重试。 */
  readonly retryable: boolean
  /** 结构化细节：人话不便表达、但要给「详情」区看的东西。 */
  readonly details?: JsonValue | undefined
  /** 因果链：底层错误（保留原始 code/stack 摘要，用于诊断）。 */
  readonly cause?: ErrorCause | undefined
}

export interface LcodeErrorInput {
  code: ErrorCode
  message: string
  userMessage: string
  retryable?: boolean
  details?: JsonValue
  cause?: unknown
}

/** 具名错误实现：一切失败都必须用 LcodeError（文档 23 §7.3），不 throw new Error('failed') */
export class LcodeErrorImpl extends Error implements LcodeError {
  readonly code: ErrorCode
  readonly category: ErrorCategory
  readonly userMessage: string
  readonly retryable: boolean
  readonly details?: JsonValue | undefined
  readonly causeInfo?: ErrorCause | undefined

  constructor(input: LcodeErrorInput) {
    super(input.message)
    this.name = 'LcodeError'
    this.code = input.code
    this.category = ERROR_CATEGORY_BY_PREFIX[input.code.split('-')[0] ?? ''] ?? 'client'
    this.userMessage = input.userMessage
    this.retryable = input.retryable ?? false
    if (input.details !== undefined) this.details = input.details
    if (input.cause !== undefined) this.causeInfo = toCauseInfo(input.cause)
  }

  override get cause(): ErrorCause | undefined {
    return this.causeInfo
  }

  toJSON(): LcodeError {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      userMessage: this.userMessage,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.causeInfo !== undefined ? { cause: this.causeInfo } : {}),
    }
  }
}

export function isLcodeError(value: unknown): value is LcodeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'category' in value &&
    'message' in value &&
    'userMessage' in value &&
    'retryable' in value
  )
}

export function toLcodeError(input: LcodeErrorInput): LcodeErrorImpl {
  return input instanceof LcodeErrorImpl ? input : new LcodeErrorImpl(input)
}

function toCauseInfo(cause: unknown): ErrorCause | undefined {
  if (cause === undefined || cause === null) return undefined
  const message =
    typeof cause === 'object' && 'message' in cause && typeof (cause as { message: unknown }).message === 'string'
      ? (cause as { message: string }).message
      : String(cause)
  const info: ErrorCause = { message }
  if (typeof cause === 'object' && 'code' in cause && typeof (cause as { code: unknown }).code === 'string') {
    info.code = (cause as { code: string }).code
  }
  if (typeof cause === 'object' && 'stack' in cause && typeof (cause as { stack: unknown }).stack === 'string') {
    info.stackDigest = (cause as { stack: string }).stack.split('\n').slice(0, 3).join('\n')
  }
  return info
}
