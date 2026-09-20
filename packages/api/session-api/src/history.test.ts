import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EpochHeader } from '@lcode/session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSessionsApi } from './sessions-api.ts'

let home = ''
let api: LocalSessionsApi

const firstHeader: EpochHeader = {
  provider: 'test',
  model: 'first',
  system: '你是登录流程审查助手。',
  tools: [{ name: 'read', description: '读取文件', inputSchema: { type: 'object', properties: {} } }],
  systemFingerprint: 'system-first',
  toolsFingerprint: 'tools-first',
}

const secondHeader: EpochHeader = {
  provider: 'test',
  model: 'second',
  system: '你是第二个模型。',
  tools: [],
  systemFingerprint: 'system-second',
  toolsFingerprint: 'tools-second',
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-history-'))
  api = new LocalSessionsApi({ home })
})

afterEach(async () => {
  await api.close()
  rmSync(home, { recursive: true, force: true })
})

async function seed(): Promise<{ readonly sessionId: string; readonly firstHeaderSeq: number; readonly secondHeaderSeq: number }> {
  const { session_id } = await api.create({ cwd: '/repo/web' })
  await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
  await api.append({ session_id, type: 'user/message', data: { role: 'user', content: '先检查登录流程' } })
  await api.append({ session_id, type: 'step/start', data: { turn: 1, step: 1 } })
  const first = await api.append({
    session_id,
    type: 'request/header',
    data: { header: firstHeader, reason: 'new-epoch' } as never,
  })
  await api.append({
    session_id,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '我先检查。' } },
  })
  await api.append({
    session_id,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '我先检查。' }] } },
  })
  await api.append({
    session_id,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: '{"path":"src/login.ts"}' },
  })
  await api.append({
    session_id,
    type: 'approval/asked',
    data: {
      callId: 'read-1',
      action: { tool: 'read', summary: '读取登录代码' },
      basis: { source: 'preset', reason: '标准预设要求确认' },
      impact: {},
      askedAt: 100,
    },
  })
  await api.append({
    session_id,
    type: 'approval/decided',
    data: { callId: 'read-1', result: 'allowed-once', decidedBy: 'human', decidedAt: 101 },
  })
  await api.append({
    session_id,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'read-1', content: 'line 1', isError: false } },
  })
  await api.append({ session_id, type: 'step/end', data: { turn: 1, step: 1 } })
  await api.append({ session_id, type: 'step/start', data: { turn: 1, step: 2 } })
  const second = await api.append({
    session_id,
    type: 'request/header',
    data: { header: secondHeader, reason: 'model-switch' } as never,
  })
  await api.flush({ session_id })
  return { sessionId: session_id, firstHeaderSeq: first.seq, secondHeaderSeq: second.seq }
}

async function appendAuditedCall(
  sessionId: string,
  callId: string,
  result?: 'allowed-once' | 'rejected' | 'cancelled',
  degraded = false,
): Promise<number> {
  const call = await api.append({
    session_id: sessionId,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'shell', arguments: '{"token":"must-not-leak"}' },
  })
  if (result !== undefined) {
    await api.append({
      session_id: sessionId,
      type: 'approval/asked',
      data: {
        callId,
        action: { tool: 'shell', summary: '运行项目检查' },
        basis: { source: 'guard', reason: '命令会启动子进程' },
        impact: { processScope: 'workspace' },
        askedAt: 200,
      },
    })
    if (degraded) {
      await api.append({
        session_id: sessionId,
        type: 'sandbox/degraded',
        data: { reason: 'Windows 原生隔离不可用', mechanism: 'none' },
      })
    }
    await api.append({
      session_id: sessionId,
      type: 'approval/decided',
      data: {
        callId,
        result,
        decidedBy: result === 'cancelled' ? 'cancelled' : 'human',
        decidedAt: 201,
      },
    })
  }
  await api.append({
    session_id: sessionId,
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'user', toolCallId: callId, content: 'done', isError: result !== 'allowed-once' } },
  })
  return call.seq
}

describe('history.replay', () => {
  it('按最近请求头切片，并只派生当时已经发送过的消息', async () => {
    const { sessionId, firstHeaderSeq, secondHeaderSeq } = await seed()

    const first = await api.replay({ session_id: sessionId, up_to_seq: firstHeaderSeq + 1 })
    expect(first.header).toEqual(firstHeader)
    expect(first.header.system).toBe('你是登录流程审查助手。')
    expect(first.header.tools).toEqual([{ name: 'read', description: '读取文件', inputSchema: { type: 'object', properties: {} } }])
    expect(first.messages).toEqual([{ role: 'user', content: '先检查登录流程' }])
    expect(first.chunks).toEqual([{ type: 'text-delta', text: '我先检查。' }])
    expect(first.toolCalls).toEqual([
      {
        call: { seq: firstHeaderSeq + 3, call_id: 'read-1', name: 'read', arguments: '{"path":"src/login.ts"}' },
        result: { role: 'user', toolCallId: 'read-1', content: 'line 1', isError: false },
      },
    ])
    expect(first.decisions).toEqual([
      { kind: 'approval/asked', basis: '标准预设要求确认', at: 100 },
      { kind: 'approval/decided:allowed-once', basis: 'human', at: 101 },
    ])

    const second = await api.replay({ session_id: sessionId, up_to_seq: secondHeaderSeq })
    expect(second.header).toEqual(secondHeader)
    expect(second.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(second.chunks).toEqual([])
    expect(second.toolCalls).toEqual([])
  })

  it('位置非法、请求头前的位置和不存在会话均返回类型化错误', async () => {
    const { sessionId, firstHeaderSeq } = await seed()
    await expect(api.replay({ session_id: sessionId, up_to_seq: -1 })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(api.replay({ session_id: sessionId, up_to_seq: firstHeaderSeq - 1 })).rejects.toMatchObject({ code: 'EC-NOT_FOUND' })
    await expect(api.replay({ session_id: 'NOPE', up_to_seq: 0 })).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })

  it('旧格式请求头缺少实际请求体时拒绝伪造回放', async () => {
    const { session_id } = await api.create({ cwd: '/repo/web' })
    await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    const legacy = await api.append({
      session_id,
      type: 'request/header',
      data: {
        header: { provider: 'legacy', model: 'old', systemFingerprint: 's', toolsFingerprint: 't' },
        reason: 'new-epoch',
      } as never,
    })
    await expect(api.replay({ session_id, up_to_seq: legacy.seq })).rejects.toMatchObject({ code: 'ES-FORMAT_UNSUPPORTED' })
  })

  it('解释允许、拒绝、取消和沙箱降级，且不回显原始工具参数', async () => {
    const { session_id } = await api.create({ cwd: '/repo/web' })
    const allowed = await appendAuditedCall(session_id, 'allowed', 'allowed-once', true)
    const rejected = await appendAuditedCall(session_id, 'rejected', 'rejected')
    const cancelled = await appendAuditedCall(session_id, 'cancelled', 'cancelled')
    const unrecorded = await appendAuditedCall(session_id, 'unrecorded')

    const allowedTrace = await api.why({ session_id, call_seq: allowed })
    expect(allowedTrace).toMatchObject({
      call: { seq: allowed, call_id: 'allowed', name: 'shell' },
      policy: { status: 'recorded', basis: { source: 'guard' } },
      approval: { status: 'allowed-once', decided_by: 'human' },
      sandbox: { status: 'degraded', mechanism: 'none' },
    })
    expect(JSON.stringify(allowedTrace)).not.toContain('must-not-leak')

    await expect(api.why({ session_id, call_seq: rejected })).resolves.toMatchObject({ approval: { status: 'rejected' } })
    await expect(api.why({ session_id, call_seq: cancelled })).resolves.toMatchObject({ approval: { status: 'cancelled', decided_by: 'cancelled' } })
    await expect(api.why({ session_id, call_seq: unrecorded })).resolves.toMatchObject({
      policy: { status: 'not-recorded' },
      approval: { status: 'not-requested' },
      sandbox: { status: 'not-recorded' },
    })
  })

  it('why 对非法或不存在的工具调用返回类型化错误', async () => {
    const { session_id } = await api.create({ cwd: '/repo/web' })
    await expect(api.why({ session_id, call_seq: -1 })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(api.why({ session_id, call_seq: 0 })).rejects.toMatchObject({ code: 'EC-NOT_FOUND' })
    await expect(api.why({ session_id: 'NOPE', call_seq: 0 })).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })

  it('checkpoints 仅返回已闭合轮，并按日志顺序稳定排列', async () => {
    const { session_id } = await api.create({ cwd: '/repo/web' })
    await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    const closed = await api.append({ session_id, type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    await api.append({ session_id, type: 'turn/start', data: { turn: 2 } })

    await expect(api.checkpoints({ session_id })).resolves.toEqual([
      { turn: 1, end_seq: closed.seq, ended_at: closed.time, reason: 'completed' },
    ])
    await expect(api.checkpoints({ session_id: 'NOPE' })).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })

  it('body 只按需返回一个事件载荷，并提供稳定且不暴露路径的引用', async () => {
    const { session_id } = await api.create({ cwd: '/repo/web' })
    const event = await api.append({ session_id, type: 'user/message', data: { role: 'user', content: 'x'.repeat(4096) } })
    const first = await api.body({ session_id, seq: event.seq })
    await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    const second = await api.body({ session_id, seq: event.seq })

    expect(first).toEqual(second)
    expect(first.bytes).toBe(Buffer.byteLength(JSON.stringify(event.data), 'utf8'))
    expect(first.ref).toMatch(/^event:[A-Za-z0-9_-]+$/)
    expect(first.ref).not.toContain('/repo/web')
    expect(first.data).toEqual(event.data)
    await expect(api.body({ session_id, seq: -1 })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(api.body({ session_id, seq: 99 })).rejects.toMatchObject({ code: 'EC-NOT_FOUND' })
    await expect(api.body({ session_id: 'NOPE', seq: 0 })).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })
})
