import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import { deriveMessages } from '@lcode/session'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { loadLog } from '@lcode/session-persistence-jsonl'
import { createAgentRuntime } from './agent-runtime.ts'

/** 无密钥回放门禁：真实内核循环、持久化和消息派生都必须走同一条路径。 */
const script: ReplayScript = {
  provider: 'replay',
  model: 'replay-model',
  chunks: [
    { type: 'text-delta', text: '回放通过。' },
    { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '回放通过。' }] } },
  ],
}

let home = ''

afterEach(() => {
  closeAllIndexDbs()
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('M-ENG-03：无密钥快照回放', () => {
  it('回放一次完整任务，事件日志与派生消息一致', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-replay-gate-'))
    const runtime = await createAgentRuntime({ home })
    try {
      runtime.ctx.get('llm').register(new ReplayLlmAdapter([script]))
      await runtime.ctx.get('agentDefaultModel').set({ provider: 'replay', model: 'replay-model' })

      const { session_id } = await runtime.sessions.create({ cwd: home, title: '回放门禁' })
      const { agent_id } = await runtime.agents.resume({ session_id })
      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('回放任务未在 5 秒内结束')), 5000)
        const stop = runtime.watchSession(session_id, (event) => {
          if (event.type !== 'turn/end') return
          clearTimeout(timer)
          stop()
          resolve()
        })
      })
      await runtime.agents.followup({ agent_id, content: [{ type: 'text', text: '执行无密钥回放' }] })
      await finished
      await runtime.sessions.flush({ session_id })

      const meta = await runtime.sessions.meta({ session_id })
      const events = loadLog(join(home, meta.header.log_path)).events
      expect(events.some((event) => event.type === 'request/header')).toBe(true)
      expect(events.some((event) => event.type === 'assistant/chunk')).toBe(true)
      expect(deriveMessages(runtime.sessions.sessionServiceFor(session_id).events())).toEqual([
        { role: 'user', content: [{ type: 'text', text: '执行无密钥回放' }] },
        { role: 'assistant', content: [{ type: 'text', text: '回放通过。' }] },
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
