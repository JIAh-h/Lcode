import { describe, expect, it } from 'vitest'
import type { ApprovalResult, EventInput, SessionEvent, SessionEventType, SessionService } from '@lcode/session'
import { createApprovalService } from './approval-service.ts'
import type { ApprovalChannel, ApprovalRequest } from './approval.ts'

/**
 * 审批服务验收（12 §5；04 §5.6 的 M-PERM-04/05；14 §3.4 的 M-SEC-02）。
 *
 * 这一组盯的是**安全语义**，不是功能覆盖面：
 * - fail-closed：没有应答者 → 一定 `unavailable`，**绝不放行**
 * - 两个事件一定成对落盘（不留悬挂 `approval/asked`）
 * - `human` 与 `auto-denied` 分得开（"用户拒绝" ≠ "没人问"）
 * - 一次性：同一个 callId 不产生两对事件
 */

const REQUEST: ApprovalRequest = {
  callId: 'call_1',
  action: { tool: 'write', summary: '写入 /repo/other/.env' },
  basis: { source: 'preset', reason: '工作区外写入', presetName: '标准' },
  impact: { paths: [{ path: '/repo/other/.env', mode: 'write', outsideWorkspace: true }] },
}

/** 记账用的假会话（只关心落了哪些事件） */
function fakeSession(): { session: SessionService; events: SessionEvent[] } {
  const events: SessionEvent[] = []
  const session = {
    append<K extends SessionEventType>(input: EventInput<K>): SessionEvent {
      const event = { type: input.type, seq: events.length, time: 0, data: input.data } as unknown as SessionEvent
      events.push(event)
      return event
    },
  } as unknown as SessionService
  return { session, events }
}

/** 通道：直接给一个答案 */
function channel(answer: ApprovalResult | undefined): ApprovalChannel {
  return { ask: async () => answer }
}

const types = (events: readonly SessionEvent[]): string[] => events.map((e) => e.type)

describe('fail-closed：没有应答者绝不放行（D11 / M-SEC-02）', () => {
  it('**没有通道 → unavailable**（不是 allowed-once，也不是抛错）', async () => {
    const service = createApprovalService()
    await expect(service.ask(REQUEST)).resolves.toBe('unavailable')
  })

  it('通道返回 undefined（通道开着但没人）→ unavailable', async () => {
    const service = createApprovalService({ channel: channel(undefined) })
    await expect(service.ask(REQUEST)).resolves.toBe('unavailable')
  })

  it('超时 → unavailable（用户没来得及答，按拒绝处理）', async () => {
    // 一个永不回答案的通道
    const never: ApprovalChannel = { ask: () => new Promise(() => {}) }
    const service = createApprovalService({ channel: never })
    await expect(service.ask(REQUEST, { timeoutMs: 50 })).resolves.toBe('unavailable')
  })

  it('**不限时**（省略 timeoutMs）时不会自己冒出一个拒绝', async () => {
    let answered = false
    const slow: ApprovalChannel = {
      ask: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            answered = true
            resolve('allowed-once')
          }, 120)
        }),
    }
    const service = createApprovalService({ channel: slow })
    // 用户慢慢读 diff 不该被自己的钟拒掉（21 §2.4：无固定超时）
    await expect(service.ask(REQUEST)).resolves.toBe('allowed-once')
    expect(answered).toBe(true)
  })

  it('请求已取消 → cancelled（不必问）', async () => {
    let asked = false
    const spy: ApprovalChannel = {
      ask: async () => {
        asked = true
        return 'allowed-once'
      },
    }
    const ctrl = new AbortController()
    ctrl.abort()
    const service = createApprovalService({ channel: spy })
    await expect(service.ask(REQUEST, { signal: ctrl.signal })).resolves.toBe('cancelled')
    // 已经取消就不该再去打扰用户
    expect(asked).toBe(false)
  })

  it('等待期间被取消 → cancelled', async () => {
    const never: ApprovalChannel = { ask: () => new Promise(() => {}) }
    const ctrl = new AbortController()
    const service = createApprovalService({ channel: never })
    setTimeout(() => ctrl.abort(), 30)
    await expect(service.ask(REQUEST, { signal: ctrl.signal })).resolves.toBe('cancelled')
  })
})

describe('答案如实转达', () => {
  it('允许 → allowed-once', async () => {
    const service = createApprovalService({ channel: channel('allowed-once') })
    await expect(service.ask(REQUEST)).resolves.toBe('allowed-once')
  })

  it('拒绝 → rejected', async () => {
    const service = createApprovalService({ channel: channel('rejected') })
    await expect(service.ask(REQUEST)).resolves.toBe('rejected')
  })

  it('人点了取消 → cancelled', async () => {
    const service = createApprovalService({ channel: channel('cancelled') })
    await expect(service.ask(REQUEST)).resolves.toBe('cancelled')
  })
})

describe('落盘：两个事件一定成对（12 §5.5）', () => {
  it('问一次 → asked + decided 各一条，且四态都成对', async () => {
    for (const answer of ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const) {
      const { session, events } = fakeSession()
      const service = createApprovalService({
        channel: answer === 'unavailable' ? channel(undefined) : channel(answer),
        getSession: () => session,
      })
      await service.ask({ ...REQUEST, callId: `c_${answer}` })
      expect(types(events)).toEqual(['approval/asked', 'approval/decided'])
    }
  })

  it('没有通道时**也要**落盘（"没人问"本身是事实）', async () => {
    const { session, events } = fakeSession()
    const service = createApprovalService({ getSession: () => session })
    await service.ask(REQUEST)
    expect(types(events)).toEqual(['approval/asked', 'approval/decided'])
  })

  it('`asked` 只含 callId/action/basis/impact/askedAt（三段齐备）', async () => {
    const { session, events } = fakeSession()
    const service = createApprovalService({ channel: channel('allowed-once'), getSession: () => session })
    await service.ask(REQUEST)
    const asked = events[0]!
    expect(asked.type).toBe('approval/asked')
    if (asked.type !== 'approval/asked') throw new Error('unreachable')
    expect(asked.data).toMatchObject({
      callId: 'call_1',
      action: { tool: 'write', summary: '写入 /repo/other/.env' },
      basis: { source: 'preset', reason: '工作区外写入', presetName: '标准' },
      // 工作区外这一位必须原样落盘——UI 要靠它显著标出（EP-OUTSIDE_WORKSPACE）
      impact: { paths: [{ path: '/repo/other/.env', mode: 'write', outsideWorkspace: true }] },
    })
    expect(typeof asked.data.askedAt).toBe('number')
  })

  it('**decidedBy 区分 human 与 auto-denied**（"用户拒绝" ≠ "没人问"）', async () => {
    const decidedByOf = async (answer: ApprovalResult | undefined, hasChannel = true): Promise<string> => {
      const { session, events } = fakeSession()
      const service = createApprovalService({
        ...(hasChannel ? { channel: channel(answer) } : {}),
        getSession: () => session,
      })
      await service.ask(REQUEST)
      const decided = events.find((e) => e.type === 'approval/decided')!
      if (decided.type !== 'approval/decided') throw new Error('unreachable')
      return decided.data.decidedBy
    }

    expect(await decidedByOf('rejected')).toBe('human')
    expect(await decidedByOf('allowed-once')).toBe('human')
    expect(await decidedByOf(undefined)).toBe('auto-denied')
    // 没有通道时同样是 auto-denied —— 这是"根本没问到人"的那一类
    expect(await decidedByOf('allowed-once', false)).toBe('auto-denied')
  })
})

describe('一次性：同一个 callId **并发**只问一次（12 §5.1）', () => {
  it('问两次同一个 callId → 两次都按第一次问出的答案回答，但**不缓存**', async () => {
    const { session, events } = fakeSession()
    let asks = 0
    const spy: ApprovalChannel = {
      ask: async () => {
        asks += 1
        return 'allowed-once'
      },
    }
    const service = createApprovalService({ channel: spy, getSession: () => session })
    await service.ask(REQUEST)
    await service.ask(REQUEST)
    /*
     * **两次都真的问了用户**（`asks === 2`）。
     *
     * 这里踩过一个坑：原本缓存了"已答过的 callId → 结果"，于是同 id 的第二次
     * 直接沿用旧答案。而 `callId` 是**模型生成**的，跨轮重复完全可能——
     * 那样第 5 轮的一个动作会沿用第 1 轮用户点过的"允许"，**不再问人**。
     * 那是把一次性审批变成了永久授权，方向正好反了（12 §5.1）。
     */
    expect(asks).toBe(2)
    // 两次都留下完整的一对事件（各自是一次真实的询问）
    expect(types(events)).toEqual(['approval/asked', 'approval/decided', 'approval/asked', 'approval/decided'])
  })

  it('**并发**问同一个 callId → 只问一次（调用方没等上一次就再来，不该弹两次）', async () => {
    const { session, events } = fakeSession()
    let asks = 0
    const spy: ApprovalChannel = {
      ask: async () => {
        asks += 1
        return new Promise((resolve) => setTimeout(() => resolve('allowed-once'), 30))
      },
    }
    const service = createApprovalService({ channel: spy, getSession: () => session })
    const [a, b] = await Promise.all([service.ask(REQUEST), service.ask(REQUEST)])
    expect([a, b]).toEqual(['allowed-once', 'allowed-once'])
    expect(asks).toBe(1)
    expect(types(events)).toEqual(['approval/asked', 'approval/decided'])
  })

  it('不同 callId 各写一对（互不干扰）', async () => {
    const { session, events } = fakeSession()
    const service = createApprovalService({ channel: channel('allowed-once'), getSession: () => session })
    await service.ask({ ...REQUEST, callId: 'call_a' })
    await service.ask({ ...REQUEST, callId: 'call_b' })
    expect(types(events)).toEqual(['approval/asked', 'approval/decided', 'approval/asked', 'approval/decided'])
  })
})
