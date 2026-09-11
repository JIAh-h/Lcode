import { describe, expect, it } from 'vitest'
import { assertLosslessJson, deepFreeze, freezeLossless, LosslessJsonError, serializeLossless } from './json.ts'
import { ERROR_CODES } from './error-codes.ts'
import { isLcodeError, LcodeErrorImpl } from './error.ts'
import { newId, newSessionId } from './id.ts'
import { composeDisposers, once } from './disposer.ts'
import { retry, withTimeout, TimeoutError } from './async.ts'
import { isJsonValue, isPlainObject } from './guard.ts'

describe('json（不变量 I5）', () => {
  it('接受普通可序列化值', () => {
    expect(() => assertLosslessJson({ a: 1, b: ['x', null, true], c: { d: 2.5 } })).not.toThrow()
  })

  it('拒绝 NaN / Infinity', () => {
    expect(() => assertLosslessJson({ a: NaN })).toThrowError(LosslessJsonError)
    expect(() => assertLosslessJson({ a: Infinity })).toThrowError(LosslessJsonError)
  })

  it('拒绝 BigInt / undefined 键值 / 函数', () => {
    expect(() => assertLosslessJson({ a: 1n })).toThrowError(LosslessJsonError)
    expect(() => assertLosslessJson({ a: undefined })).toThrowError(LosslessJsonError)
    expect(() => assertLosslessJson({ a: () => 1 })).toThrowError(LosslessJsonError)
  })

  it('拒绝 Map / Set / Date / 类实例', () => {
    expect(() => assertLosslessJson(new Map())).toThrowError(LosslessJsonError)
    expect(() => assertLosslessJson(new Set([1]))).toThrowError(LosslessJsonError)
    expect(() => assertLosslessJson(new Date())).toThrowError(LosslessJsonError)
    expect(() => assertLosslessJson(new (class Foo {})())).toThrowError(LosslessJsonError)
  })

  it('拒绝循环引用', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    expect(() => assertLosslessJson(obj)).toThrowError(LosslessJsonError)
  })

  it('错误码为 EC-EVENT_NOT_JSON', () => {
    try {
      assertLosslessJson({ a: NaN })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LcodeErrorImpl)
      expect((err as LcodeErrorImpl).code).toBe(ERROR_CODES.EC_EVENT_NOT_JSON)
    }
  })

  it('deepFreeze 真正冻结嵌套对象', () => {
    const frozen = deepFreeze({ a: { b: [1, 2] } })
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.a)).toBe(true)
    expect(Object.isFrozen(frozen.a.b)).toBe(true)
  })

  it('freezeLossless 组合校验与冻结', () => {
    const v = freezeLossless({ turn: 1 })
    expect(Object.isFrozen(v)).toBe(true)
  })

  it('serializeLossless 可往返', () => {
    const src = { a: [1, 2, 3], b: 'x', c: null }
    const text = serializeLossless(src)
    expect(JSON.parse(text)).toEqual(src)
  })
})

describe('error', () => {
  it('构造具名错误并归类', () => {
    const err = new LcodeErrorImpl({
      code: ERROR_CODES.ET_TIMEOUT,
      message: 'tool timed out',
      userMessage: '这一步等太久了，先停下来了。可以让它再试一次。',
      retryable: true,
    })
    expect(err.category).toBe('tool')
    expect(err.retryable).toBe(true)
    expect(isLcodeError(err.toJSON())).toBe(true)
  })

  it('cause 保留栈摘要', () => {
    const inner = new Error('boom')
    const err = new LcodeErrorImpl({
      code: ERROR_CODES.EN_IO_ERROR,
      message: 'io failed',
      userMessage: '读写出错了，已经记下来，可以再试一次。',
      cause: inner,
    })
    expect(err.cause?.message).toBe('boom')
    expect(err.cause?.stackDigest).toBeTruthy()
  })
})

describe('id', () => {
  it('生成 26 字符 A-Z0-9（无 I/O/0/1）', () => {
    const id = newId()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[A-HJ-NP-Z2-9]{26}$/)
  })

  it('两次生成不重复', () => {
    expect(newSessionId()).not.toBe(newSessionId())
  })
})

describe('disposer', () => {
  it('逆序回滚', () => {
    const order: number[] = []
    const dispose = composeDisposers(
      () => order.push(1),
      () => order.push(2),
    )
    dispose()
    expect(order).toEqual([2, 1])
  })

  it('幂等（once）', () => {
    let count = 0
    const fn = once(() => {
      count++
    })
    fn()
    fn()
    expect(count).toBe(1)
  })
})

describe('async', () => {
  it('withTimeout 超时抛 TimeoutError', async () => {
    await expect(
      withTimeout(() => new Promise<never>(() => {}), 20),
    ).rejects.toBeInstanceOf(TimeoutError)
  })

  it('withTimeout 正常完成', async () => {
    await expect(withTimeout(async () => 42, 1000)).resolves.toBe(42)
  })

  it('retry 失败后成功', async () => {
    let calls = 0
    const result = await retry(
      async () => {
        calls++
        if (calls < 2) throw new Error('try again')
        return 'ok'
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  it('retry 达上限抛出最后一次错误', async () => {
    await expect(
      retry(
        async () => {
          throw new Error('always fails')
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('always fails')
  })
})

describe('guard', () => {
  it('isPlainObject / isJsonValue', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isJsonValue({ a: [1, 2, null] })).toBe(true)
    expect(isJsonValue({ a: undefined })).toBe(false)
    expect(isJsonValue(NaN)).toBe(false)
  })
})
