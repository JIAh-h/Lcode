/**
 * P11-08 Watchdog 的闭环测试（docs/26 §8）。
 *
 * 核心断言不是"能检出问题"，而是**"检出后不会自己动手"**——只通知不派发是
 * 这条设计里最容易在实现时被"顺手优化"掉的一条。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { SandboxService } from '@lcode/sandbox'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { createAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { registerLocalWatchdog } from './watchdog.ts'

const sandbox: SandboxService = {
  status: () => ({ enforced: true, mechanism: 'test', platform: 'win32', capabilities: {} }),
  wrap: async (argv: readonly string[]) => ({ enforced: true, wrappedArgv: argv, mechanism: 'test' }),
  dispose: () => {},
} as unknown as SandboxService

let home = ''
let runtime: AgentRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  closeAllIndexDbs()
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

async function makeRuntime(): Promise<AgentRuntime> {
  home = mkdtempSync(join(tmpdir(), 'lcode-wd-'))
  const rt = await createAgentRuntime({ home, sandbox })
  rt.ctx.get('llm').register(new ReplayLlmAdapter([]))
  runtime = rt
  return rt
}

describe('P11-08 Watchdog', () => {
  it('空会话不产生任何发现', async () => {
    const rt = await makeRuntime()
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'S' })
    const wd = registerLocalWatchdog({
      ctx: rt.ctx,
      sessions: rt.sessions,
      intervalMs: 60_000,
      listSessions: async () => [session_id],
    })
    try {
      expect(await wd.service.scan()).toEqual([])
    } finally {
      wd.dispose()
    }
  })

  it('失败的轮次且无后续用户消息 → silent-failure；用户又说话后消失', async () => {
    const rt = await makeRuntime()
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'S' })
    const session = rt.sessions.sessionServiceFor(session_id)
    session.append({ type: 'turn/start', data: { turn: 1 } })
    session.append({ type: 'turn/end', data: { turn: 1, reason: 'error' } })

    const wd = registerLocalWatchdog({
      ctx: rt.ctx,
      sessions: rt.sessions,
      intervalMs: 60_000,
      listSessions: async () => [session_id],
    })
    try {
      const found = await wd.service.scan()
      expect(found.some((f) => f.kind === 'silent-failure')).toBe(true)

      // 用户说话了 → 不再算"静默"
      session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
      const after = await wd.service.scan()
      expect(after.some((f) => f.kind === 'silent-failure')).toBe(false)
    } finally {
      wd.dispose()
    }
  })

  it('running 超时无新事件 → stalled', async () => {
    const rt = await makeRuntime()
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'S' })
    rt.sessions.sessionServiceFor(session_id).append({ type: 'turn/start', data: { turn: 1 } })

    const wd = registerLocalWatchdog({
      ctx: rt.ctx,
      sessions: rt.sessions,
      intervalMs: 60_000,
      stallMs: 1,
      listSessions: async () => [session_id],
    })
    try {
      // 用"未来时刻"扫描，稳定触发超时判定（不依赖真实等待）
      const found = await wd.service.scan(Date.now() + 10_000)
      expect(found.some((f) => f.kind === 'stalled')).toBe(true)
    } finally {
      wd.dispose()
    }
  })

  it('**只通知不派发**：巡检不会创建任何 worker 或会话', async () => {
    const rt = await makeRuntime()
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'S' })
    rt.sessionRoles.setRole(session_id, 'router')
    const session = rt.sessions.sessionServiceFor(session_id)
    session.append({ type: 'turn/start', data: { turn: 1 } })

    const before = (await rt.sessions.list()).items.length
    const wd = registerLocalWatchdog({
      ctx: rt.ctx,
      sessions: rt.sessions,
      intervalMs: 60_000,
      stallMs: 1,
      listSessions: async () => [session_id],
    })
    try {
      await wd.service.scan(Date.now() + 10_000)
      // 关键断言：巡检之后没有多出任何会话（worker 会话）
      expect((await rt.sessions.list()).items.length).toBe(before)
      // 也没有任何派发事件
      expect(session.events().some((e) => e.type === 'worker/dispatched')).toBe(false)
    } finally {
      wd.dispose()
    }
  })
})
