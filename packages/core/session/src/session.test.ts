import { describe, expect, it } from 'vitest'
import { asSessionId, ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { InMemorySessionStore } from './session.ts'
import { deriveEventMessage, deriveSurfaceItems } from './surface.ts'
import type { SessionEvent } from './types.ts'

function makeStore() {
  return new InMemorySessionStore(asSessionId('TEST-SESSION-001'))
}

describe('session 不变量 S1：seq 单调连续无空洞', () => {
  it('seq 恒等于追加前的日志长度', () => {
    const store = makeStore()
    const e0 = store.append({ type: 'turn/start', data: { turn: 1 } })
    const e1 = store.append({ type: 'user/message', data: { role: 'user', content: 'hi' } })
    expect(e0.seq).toBe(0)
    expect(e1.seq).toBe(1)
    expect(store.length).toBe(2)
    expect(store.events({ from: 0, to: 1 })).toHaveLength(1)
  })

  it('appendMany 保持连续', () => {
    const store = makeStore()
    const evs = store.appendMany([
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
    ])
    expect(evs.map((e) => e.seq)).toEqual([0, 1])
    expect(makeStore().appendMany([])).toEqual([])
  })
})

describe('session 不变量 S4：事件 data 无损 JSON（I5）', () => {
  it('拒绝 NaN 载荷', () => {
    const store = makeStore()
    expect(() =>
      // 之前这里传的是字符串（`'x' as unknown as number`），压根没有 NaN，等于没测到；
      // 真正要验的是「数值型 data 里的 NaN 会被无损 JSON 校验拒绝」
      store.append({ type: 'user/message', data: { role: 'user', content: Number.NaN as unknown as string } } as never),
    ).toThrow()
  })

  it('拒绝 undefined 键值', () => {
    const store = makeStore()
    expect(() =>
      store.append({ type: 'todo/write', data: { todos: [{ id: 'a', text: 't', status: 'pending', extra: undefined }] } } as never),
    ).toThrowError(LcodeErrorImpl)
  })

  it('事件深冻结（进入日志那一刻不可变）', () => {
    const store = makeStore()
    const ev = store.append({ type: 'todo/write', data: { todos: [{ id: 'a', text: 't', status: 'pending' }] } })
    expect(Object.isFrozen(ev.data)).toBe(true)
  })

  it('保留显式时间、血缘和 ignorable 标记', () => {
    const store = makeStore()
    const event = store.append({
      type: 'turn/start',
      data: { turn: 1 },
      time: 123,
      sourceEventSeqs: [0],
      ignorable: true,
    })
    expect(event).toMatchObject({ time: 123, sourceEventSeqs: [0], ignorable: true })
  })
})

describe('表面投影（06 §3）', () => {
  it('非表面事件不产生模型消息', () => {
    expect(deriveEventMessage({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as never)).toBeNull()
  })

  it('直接派生时也拒绝越界 replace', () => {
    expect(() =>
      deriveSurfaceItems([
        {
          type: 'user/message',
          seq: 0,
          time: 0,
          data: { role: 'user', content: 'hi' },
          surfaceOp: { op: 'replace', start: 2, end: 3 },
        } as never,
      ]),
    ).toThrowError(RangeError)
  })

  it('只投影三类表面事件', () => {
    const store = makeStore()
    store.append({ type: 'turn/start', data: { turn: 1 } })
    store.append({ type: 'user/message', data: { role: 'user', content: '请修 bug' } })
    store.append({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '正在看' } } })
    store.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '找到了' }] } },
    })
    const msgs = store.deriveMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'user', content: '请修 bug' })
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '找到了' }] })
  })

  it('surfaceOp replace 隐藏区间（压缩的唯一原语）', () => {
    const store = makeStore()
    store.append({ type: 'user/message', data: { role: 'user', content: '任务' } })
    store.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '旧的中间输出' }] } },
    })
    // 压缩：声明替换表面区间 [1,2)（旧 assistant 消息被新内容覆盖）
    store.append({
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '最终总结' }] } },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
    })
    const items = deriveSurfaceItems(store.events())
    expect(items.filter((i) => !i.hidden)).toHaveLength(2)
    expect(items[1]?.hidden).toBe(true)
    const msgs = store.deriveMessages()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('非表面事件携带 append 操作不改变投影', () => {
    const store = makeStore()
    store.append({ type: 'turn/start', data: { turn: 1 }, surfaceOp: 'append' })
    expect(store.deriveMessages()).toEqual([])
  })

  it('非表面事件的 replace 仍按当前表面范围校验', () => {
    const store = makeStore()
    store.append({ type: 'user/message', data: { role: 'user', content: 'hi' } })
    store.append({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c', name: 'x', arguments: '{}' },
      surfaceOp: { op: 'replace', start: 0, end: 1 },
    })
    expect(store.deriveMessages()).toEqual([])
  })

  it('replace 区间越界抛错（I4）', () => {
    const store = makeStore()
    store.append({ type: 'user/message', data: { role: 'user', content: 'hi' } })
    expect(() =>
      store.append({
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
        surfaceOp: { op: 'replace', start: 5, end: 6 },
      }),
    ).toThrowError(RangeError)
  })
})

describe('派生是纯函数（P1 / I1）', () => {
  it('同样的日志必然得到同样的结果', () => {
    const store = makeStore()
    store.append({ type: 'user/message', data: { role: 'user', content: 'a' } })
    const once = store.deriveMessages()
    const twice = store.deriveMessages()
    expect(once).toEqual(twice)
    // 读取不改变日志
    expect(store.events()).toHaveLength(1)
  })
})

describe('fork 分叉（20 §5.1）', () => {
  it('切点越界拒绝', async () => {
    const store = makeStore()
    await expect(store.fork(0)).resolves.toMatchObject({ seed: [] })
    await expect(store.fork(-1)).rejects.toMatchObject({ code: ERROR_CODES.ES_FORK_BOUNDARY_INVALID })
    await expect(store.fork(1)).rejects.toMatchObject({ code: ERROR_CODES.ES_FORK_BOUNDARY_INVALID })
  })

  it('切点必须落在已关闭的轮内', async () => {
    const store = makeStore()
    store.append({ type: 'turn/start', data: { turn: 1 } })
    store.append({ type: 'user/message', data: { role: 'user', content: 'hi' } })
    await expect(store.fork(2)).rejects.toMatchObject({ code: ERROR_CODES.ES_FORK_BOUNDARY_INVALID })
  })

  it('已关闭的轮可安全分叉', async () => {
    const store = makeStore()
    store.append({ type: 'turn/start', data: { turn: 1 } })
    store.append({ type: 'user/message', data: { role: 'user', content: 'hi' } })
    store.append({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    const handle = await store.fork(3)
    expect(handle.seed).toHaveLength(3)
  })
})

describe('markEndSeed 生命周期分界线', () => {
  it('种子后追加 end-seed，且只追加一次', () => {
    const store = makeStore()
    store.append({ type: 'user/message', data: { role: 'user', content: 'seed' } })
    store.markEndSeed()
    store.markEndSeed()
    const events = store.events()
    expect(events[events.length - 1]?.type).toBe('session/end-seed')
    expect(events.filter((e) => e.type === 'session/end-seed')).toHaveLength(1)
  })
})

describe('onEvent 订阅（UI 数据源）', () => {
  it('每个落盘事件广播一次', () => {
    const store = makeStore()
    const seen: string[] = []
    store.onEvent((e) => seen.push(e.type))
    store.append({ type: 'turn/start', data: { turn: 1 } })
    store.append({ type: 'user/message', data: { role: 'user', content: 'x' } })
    expect(seen).toEqual(['turn/start', 'user/message'])
  })

  it('撤销订阅后不再广播', () => {
    const store = makeStore()
    let count = 0
    const dispose = store.onEvent(() => count++)
    dispose()
    store.append({ type: 'turn/start', data: { turn: 1 } })
    expect(count).toBe(0)
  })

  it('观察者的异常交给 onObserverError，不当成 append 失败也不静默消失', () => {
    const reported: unknown[] = []
    const store = new InMemorySessionStore(asSessionId('s-observer'), {
      onObserverError: (err) => reported.push(err),
    })
    const seen: string[] = []
    store.onEvent(() => {
      throw new Error('订阅者炸了')
    })
    store.onEvent(() => seen.push('second'))

    const event = store.append({ type: 'turn/start', data: { turn: 1 } })
    expect(event.seq).toBe(0)
    expect(seen).toEqual(['second'])
    expect(store.length).toBe(1)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toBeInstanceOf(Error)
  })

  it('没有传 onObserverError 时，异常被静默吞掉（但 append 仍然成功）', () => {
    const store = makeStore()
    store.onEvent(() => {
      throw new Error('没人接')
    })
    expect(() => store.append({ type: 'turn/start', data: { turn: 1 } })).not.toThrow()
    expect(store.length).toBe(1)
  })
})

// 类型级验证：开放接口可声明合并（编译期检查；运行时不执行）
declare module './types.ts' {
  interface SessionEventMap {
    'test/custom': { foo: string }
  }
}

void (null as unknown as SessionEvent<'test/custom'>)
