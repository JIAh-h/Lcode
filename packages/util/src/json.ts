import { ERROR_CODES } from './error-codes.ts'
import { LcodeErrorImpl } from './error.ts'
import { isPlainObject, type JsonValue } from './guard.ts'

/**
 * 无损 JSON 序列化 —— 不变量 I5（文档 06 §2.1 / 22 §7.6）。
 *
 * 事件 data 必须无损 JSON 序列化。拒绝：
 * - `BigInt` / `NaN` / `Infinity`（JSON.stringify 会静默丢值或抛错）
 * - `undefined`（对象键会静默丢失；数组元素变 null）
 * - 函数 / Symbol
 * - `Map` / `Set` / `Date` / 类实例（原型信息丢失，反序列化后不是同类）
 * - 循环引用
 *
 * 违规一律抛 `EC-EVENT_NOT_JSON` 具名错误，绝不静默修正。
 */

export class LosslessJsonError extends LcodeErrorImpl {
  constructor(path: string, problem: string) {
    super({
      code: ERROR_CODES.EC_EVENT_NOT_JSON,
      message: `事件 data 无法无损 JSON 序列化：路径 ${path} 包含 ${problem}`,
      userMessage: '这条记录存不下（内容格式不支持）。',
      retryable: false,
    })
    this.name = 'LosslessJsonError'
  }
}

const seen = new WeakSet<object>()

/** 校验值是否无损可序列化；不通过抛 LosslessJsonError */
export function assertLosslessJson(value: unknown, path = '$'): void {
  if (value === null) return
  const t = typeof value
  if (t === 'string' || t === 'boolean') return
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new LosslessJsonError(path, 'NaN / Infinity')
    return
  }
  if (t === 'bigint') throw new LosslessJsonError(path, 'BigInt')
  if (t === 'symbol' || t === 'function' || t === 'undefined') {
    throw new LosslessJsonError(path, t)
  }
  // object
  if (value instanceof Date) throw new LosslessJsonError(path, 'Date 实例')
  if (value instanceof Map || value instanceof Set) throw new LosslessJsonError(path, `${value.constructor.name} 实例`)
  const obj = value as Record<string, unknown>
  if (seen.has(obj)) throw new LosslessJsonError(path, '循环引用')
  if (!isPlainObject(obj) && !Array.isArray(obj)) {
    throw new LosslessJsonError(path, `类实例（${obj.constructor?.name ?? 'unknown'}）`)
  }
  seen.add(obj)
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertLosslessJson(item, `${path}[${i}]`))
  } else {
    for (const key of Object.keys(obj)) {
      if (obj[key] === undefined) throw new LosslessJsonError(`${path}.${key}`, 'undefined 键值')
      assertLosslessJson(obj[key], `${path}.${key}`)
    }
  }
  seen.delete(obj)
}

/** 校验 + 深冻结（事件进入日志的那一刻深冻结，文档 06 §2.1） */
export function freezeLossless<T>(value: T): T {
  assertLosslessJson(value)
  return deepFreeze(value)
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/** 序列化为字符串；输入必须先过 assertLosslessJson（或直接传冻结后的值） */
export function serializeLossless(value: JsonValue): string {
  assertLosslessJson(value)
  return JSON.stringify(value)
}
