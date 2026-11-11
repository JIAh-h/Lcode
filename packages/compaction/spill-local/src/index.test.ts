import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { applySpillToSurface, registerLocalSpill } from './index.ts'

let home = ''
afterEach(() => { if (home !== '') rmSync(home, { recursive: true, force: true }) })

describe('spill-local', () => {
  /*
   * spill 改为**按需调用**（docs/09 §3.2.5）：不再监听每结果事件主动触发。
   *
   * 为什么：spill 用 surfaceOp replace 改写历史，而工具结果总是写在两请求之间——
   * 改写它=改写下一步请求的历史，提供方前缀缓存从那个位置起全部失效。
   * 实测（真实会话 36 次请求）：6 次 spill 让命中率永远卡在 4~7%。
   */
  it('applySpillToSurface 外置超长结果、写 spill/created，且原事实保留', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-spill-'))
    const ctx = createContext()
    const unspill = registerLocalSpill({ ctx, home })
    const store = new InMemorySessionStore(asSessionId('session-a'))
    const original = 'line\n'.repeat(50)
    store.append({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'shell-1', content: original, isError: false } } })

    const replaced = applySpillToSurface({ sessionId: 'session-a', session: store, spill: ctx.get('spill'), thresholdChars: 60 })
    expect(replaced).toBeGreaterThanOrEqual(0)
    // 写盘是异步的：轮询等 spill/created 落盘（最多 2s）
    for (let i = 0; i < 40 && !store.events().some((event) => event.type === 'spill/created'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const spillEvent = store.events().find((event) => event.type === 'spill/created')
    if (spillEvent === undefined) {
      console.log('[debug] 事件序列:', store.events().map((event) => `${event.type}(op=${JSON.stringify(event.surfaceOp)})`).join(' | '))
    }
    expect(spillEvent).toMatchObject({ data: { originalChars: original.length } })
    const locator = (spillEvent?.type === 'spill/created' ? spillEvent.data.locator : '')
    // 原始事实不动（append-only 不变量）
    expect(store.events()[0]).toMatchObject({ data: { message: { content: original } } })
    // 可见表面上是 locator 预览
    expect(store.deriveMessages()[0]).toMatchObject({ content: expect.stringContaining(locator) })
    await expect(ctx.get('spill').read({ sessionId: 'session-a', locator })).resolves.toMatchObject({ text: expect.stringContaining('line'), totalLines: 50 })
    await expect(ctx.get('spill').read({ sessionId: 'session-b', locator })).rejects.toBeDefined()

    unspill()
  })

  it('read 工具结果不会触发 spill，避免读回引用的循环', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-spill-'))
    const ctx = createContext()
    const unspill = registerLocalSpill({ ctx, home })
    const store = new InMemorySessionStore(asSessionId('session-read'))
    store.append({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'read-1', content: 'x'.repeat(100), isError: false } } })
    applySpillToSurface({ sessionId: 'session-read', session: store, spill: ctx.get('spill'), thresholdChars: 10 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.events()).toHaveLength(1)
    unspill()
  })

  it('短结果不超过阈值时不动', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-spill-short'))
    const ctx = createContext()
    const unspill = registerLocalSpill({ ctx, home })
    const store = new InMemorySessionStore(asSessionId('session-short'))
    store.append({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'grep-1', content: '只有一行', isError: false } } })
    applySpillToSurface({ sessionId: 'session-short', session: store, spill: ctx.get('spill'), thresholdChars: 60 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(store.events()).toHaveLength(1)
    unspill()
  })
})
