import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { asAgentId, asSessionId } from '@lcode/util'
import { InMemoryAgentStore } from './store.ts'
import type { SessionService } from '@lcode/session'

function session(events: Array<{ type: string; data?: unknown }> = []): SessionService {
  return {
    append(input) {
      const event = { ...input, seq: events.length, time: 0 }
      events.push(event)
      return event as never
    },
    appendMany(inputs) {
      return inputs.map((input) => this.append(input))
    },
    events: () => events as never,
    deriveMessages: () => [],
    fork: async () => ({ sessionId: asSessionId('s1'), seed: [] }),
    markEndSeed: () => {},
    get length() {
      return events.length
    },
    onEvent: () => () => {},
  }
}

describe('InMemoryAgentStore', () => {
  it('创建、恢复、查询和发起者透传', async () => {
    const ctx = createContext()
    const seen: unknown[] = []
    ctx.on('agent/created', (payload) => {
      seen.push(payload)
    })
    const sessions = new Map([['s1', session()]])
    const store = new InMemoryAgentStore(ctx, (id) => sessions.get(id)!)
    const created = await store.create({ sessionId: asSessionId('s1') })
    expect(store.get(created.id)).toBe(created)
    expect(store.list()).toEqual([created])
    expect(seen).toHaveLength(1)
    expect(await store.resume({ sessionId: asSessionId('s1'), agentId: created.id })).toBe(created)
    const resumed = await store.resume({ sessionId: asSessionId('s1'), agentId: asAgentId('other') })
    expect(store.list()).toHaveLength(2)
    await expect(store.withInitiator({ sessionId: asSessionId('s1'), agentId: resumed.id }, async () => 'ok')).resolves.toBe('ok')
    await expect(store.create({ id: created.id, sessionId: asSessionId('s1') })).rejects.toMatchObject({ code: 'EC-CONFLICT' })
  })

  it('handle 状态、插话约束、取消收尾和销毁后的 fail-closed', async () => {
    const ctx = createContext()
    const events: string[] = []
    ctx.on('agent/status', (payload) => {
      events.push(`${payload.status}:${payload.reason ?? ''}`)
    })
    ctx.on('agent/inbox', (payload) => {
      events.push(`inbox:${payload.kind}`)
    })
    const log = [{ type: 'turn/start', data: { turn: 1 } }]
    const store = new InMemoryAgentStore(ctx, () => session(log))
    const handle = await store.create({ id: asAgentId('a1'), sessionId: asSessionId('s1') })

    await expect(handle.steer({ kind: 'text', text: 'no' })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
    await handle.followup({ kind: 'text', text: 'go' })
    await handle.steer({ kind: 'text', text: 'steer' })
    await handle.inject({ content: 'context', source: 'test' })
    await handle.cancel('user')
    await handle.cancel('user')
    expect(handle.status).toBe('cancelled')
    expect(log.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: 'cancelled' } })
    await handle.dispose()
    await handle.dispose()
    await handle.cancel('user')
    expect(events).toContain('inbox:steer')
    await expect(handle.followup({ kind: 'text', text: 'after' })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
    await expect(handle.inject({ content: 'after', source: 'test' })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
  })

  it('无打开轮时取消只发状态，整体销毁后拒绝新操作', async () => {
    const ctx = createContext()
    const store = new InMemoryAgentStore(ctx, () => session())
    const handle = await store.create({ id: asAgentId('a1'), sessionId: asSessionId('s1') })
    await handle.cancel('dispose')
    await store.disposeAll()
    await expect(store.create({ sessionId: asSessionId('s1') })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
    await expect(store.resume({ sessionId: asSessionId('s1'), agentId: asAgentId('a2') })).rejects.toMatchObject({ code: 'EC-NOT_RUNNING' })
  })
})
