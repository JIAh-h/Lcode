import { describe, expect, it } from 'vitest'
import { asSeq } from '@lcode/util'
import { buildRequestBody, fingerprintOf, headerReason, snapshotTools, toolsFingerprintOf, withBody } from './request.ts'
import type { PreparedCall } from '@lcode/llm'
import type { EpochHeader, SessionEvent } from '@lcode/session'
import type { ToolSchema } from '@lcode/tools'

const header: EpochHeader = {
  provider: 'p',
  model: 'm',
  system: 'system',
  tools: [],
  systemFingerprint: 's',
  toolsFingerprint: 't',
}
const event = (value: EpochHeader): SessionEvent => ({
  type: 'request/header',
  seq: asSeq(0),
  time: 0,
  data: { header: value, reason: 'new-epoch' },
})

describe('request helpers', () => {
  it('指纹稳定、请求体深拷贝、替换 body 不改原 call', () => {
    expect(fingerprintOf('same')).toBe(fingerprintOf('same'))
    expect(toolsFingerprintOf([])).toHaveLength(16)
    const messages = [{ role: 'user', content: 'hello' }] as never
    const tools: ToolSchema[] = [{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }]
    expect(snapshotTools(tools)).toEqual([{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }])
    const body = buildRequestBody('system', messages, tools)
    expect(body).toEqual({ system: 'system', messages, tools })
    ;(messages[0] as { content: string }).content = 'changed'
    expect((body as { messages: Array<{ content: string }> }).messages[0]?.content).toBe('hello')

    const call = { provider: 'p', model: 'm', request: { body: null } } as unknown as PreparedCall
    const replaced = withBody(call, { ok: true })
    expect(replaced.request.body).toEqual({ ok: true })
    expect(call.request.body).toBeNull()
  })

  it('判定首次、模型切换、提示词变化和连续请求', () => {
    expect(headerReason([], header)).toBe('new-epoch')
    expect(headerReason([event({ ...header, provider: 'other' })], header)).toBe('model-switch')
    expect(headerReason([event({ ...header, systemFingerprint: 'other' })], header)).toBe('new-epoch')
    expect(headerReason([event(header)], header)).toBe('continuation')
  })
})
