import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { registerLocalSpill } from './index.ts'

let home = ''
afterEach(() => { if (home !== '') rmSync(home, { recursive: true, force: true }) })

describe('spill-local', () => {
  it('外置原始工具输出、保留可回放事实，并拒绝另一会话读取 locator', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-spill-'))
    const ctx = createContext()
    const unspill = registerLocalSpill({ ctx, home, thresholdChars: 60 })
    const store = new InMemorySessionStore(asSessionId('session-a'))
    const original = 'line\n'.repeat(50)
    const source = store.append({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'c1', content: original, isError: false } } })

    await ctx.emit('agent/tool-result-appended', {
      agentId: 'a1', sessionId: 'session-a', session: store, sourceEventSeq: source.seq,
      tool: { callId: 'c1', name: 'shell' }, message: source.data.message,
    })

    const spillEvent = store.events().find((event) => event.type === 'spill/created')
    expect(spillEvent).toMatchObject({ data: { sourceEventSeq: source.seq, originalChars: original.length } })
    const locator = (spillEvent?.type === 'spill/created' ? spillEvent.data.locator : '')
    expect(store.events()[0]).toMatchObject({ data: { message: { content: original } } })
    expect(store.deriveMessages()[0]).toMatchObject({ content: expect.stringContaining(locator) })
    await expect(ctx.get('spill').read({ sessionId: 'session-a', locator })).resolves.toMatchObject({ text: expect.stringContaining('line'), totalLines: 50 })
    await expect(ctx.get('spill').read({ sessionId: 'session-b', locator })).rejects.toBeDefined()

    unspill()
  })

  it('read 工具结果不会触发 spill，避免读回引用的循环', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-spill-'))
    const ctx = createContext()
    const unspill = registerLocalSpill({ ctx, home, thresholdChars: 10 })
    const store = new InMemorySessionStore(asSessionId('session-read'))
    const source = store.append({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'read-1', content: 'x'.repeat(100), isError: false } } })
    await ctx.emit('agent/tool-result-appended', {
      agentId: 'a1', sessionId: 'session-read', session: store, sourceEventSeq: source.seq,
      tool: { callId: 'read-1', name: 'read' }, message: source.data.message,
    })
    expect(store.events()).toHaveLength(1)
    unspill()
  })
})
