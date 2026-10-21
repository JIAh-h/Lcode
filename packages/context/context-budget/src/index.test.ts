import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { assess, measure } from './index.ts'

describe('context-budget', () => {
  it('把当前表面、system、工具 schema 与已返回 usage 分开计量', () => {
    const session = new InMemorySessionStore(asSessionId('budget'))
    session.append({ type: 'user/message', data: { role: 'user', content: '请检查项目。' } })
    session.append({ type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已检查。' }] }, usage: { input: 21, output: 8 } } })
    const snapshot = measure({ session, system: 'stable system', tools: [{ name: 'read', description: 'read file', inputSchema: { type: 'object', properties: {} } }] })
    expect(snapshot).toMatchObject({ revision: 2, observedInputTokens: 21, observedOutputTokens: 8 })
    expect(snapshot.total).toBe(snapshot.surfaceTokens + snapshot.systemTokens + snapshot.toolSchemaTokens)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('只有超过预留后的输入窗口才成为摘要候选，未知窗口不擅自触发', () => {
    const measurement = { revision: 1, surfaceTokens: 7_500, systemTokens: 200, toolSchemaTokens: 200, total: 7_900, observedInputTokens: 0, observedOutputTokens: 0 }
    expect(assess({ measurement, contextWindowTokens: 10_000 })).toMatchObject({ status: 'below-threshold', thresholdTokens: 8_000 })
    expect(assess({ measurement: { ...measurement, total: 8_100 }, contextWindowTokens: 10_000 })).toMatchObject({ status: 'summary-candidate', requiredSavingsTokens: 101 })
    expect(assess({ measurement })).toMatchObject({ status: 'no-context-window' })
  })
})
