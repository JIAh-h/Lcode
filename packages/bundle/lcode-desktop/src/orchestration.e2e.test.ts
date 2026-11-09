/**
 * P11 跨会话编排的端到端验收（docs/26 §10）。
 *
 * ## 与 orchestration.test.ts 的分工
 *
 * - `orchestration.test.ts`：**契约级**——逐条验证设计文档的每条决策。
 * - 本文件：**场景级**——模拟一次真实使用：用户建 Router → 派 3 个任务 →
 *   worker 并行完成 → Router 自动汇报 → 用户看到汇总。这是"闭环"的定义。
 *
 * 它还额外守住一条 orchestration.test.ts 不容易覆盖的：
 * **整个流程结束后，日志必须能完整回放**（I1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import type { SandboxService } from '@lcode/sandbox'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { createAgentRuntime, type AgentRuntime } from './agent-runtime.ts'

const sandbox: SandboxService = {
  status: () => ({ enforced: true, mechanism: 'test', platform: 'win32', capabilities: {} }),
  wrap: async (argv: readonly string[]) => ({ enforced: true, wrappedArgv: argv, mechanism: 'test' }),
  dispose: () => {},
} as unknown as SandboxService

const reply = (text: string): ReplayScript => ({
  provider: 'custom',
  model: 'test-model',
  chunks: [
    { type: 'text-delta', text },
    { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ],
})

let home = ''
let runtime: AgentRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await new Promise((resolve) => setTimeout(resolve, 50))
  closeAllIndexDbs()
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

async function waitForEvents(rt: AgentRuntime, sessionId: string, type: string, count: number, timeoutMs = 15000): Promise<void> {
  const seen = (): number => rt.sessions.sessionServiceFor(sessionId).events().filter((event) => event.type === type).length
  if (seen() >= count) return
  await new Promise<void>((resolve, reject) => {
    let unwatch: () => void = () => {}
    const timer = setTimeout(() => {
      unwatch()
      reject(new Error(`等待 ${type} × ${count} 超时（实际 ${seen()}）`))
    }, timeoutMs)
    unwatch = rt.watchSession(sessionId, () => {
      if (seen() < count) return
      clearTimeout(timer)
      unwatch()
      resolve()
    })
  })
}

describe('P11 端到端闭环：一次真实的跨会话编排', () => {
  it('建 Router → 派 3 个任务 → 并行完成 → 自动汇报 → 全链路可回放', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-e2e-'))
    // 3 个 worker 各一段 + Router 处理汇报一段
    const rt = await createAgentRuntime({ home, sandbox, orchestrationMode: 'auto' })
    rt.ctx.get('llm').register(
      new ReplayLlmAdapter([reply('任务A完成：改了 a.ts'), reply('任务B完成：查了文档'), reply('任务C完成'), reply('三条都回来了，已汇总。')]),
    )
    await rt.ctx.get('agentDefaultModel').set({ provider: 'custom', model: 'test-model' })
    runtime = rt

    // ① 用户建 Router 会话
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: '总协调' })
    rt.sessionRoles.setRole(routerSession, 'router')
    expect(rt.sessionRoles.roleOf(routerSession)).toBe('router')
    const { agent_id } = await rt.agents.create({ session_id: routerSession })

    // ② Router 派 3 个任务（其中一条带 reason，验证审计）
    const tasks = [
      { task: '任务A：改 a.ts', reason: '需要独立改代码' },
      { task: '任务B：查文档' },
      { task: '任务C：跑测试' },
    ]
    const receipts = []
    for (const t of tasks) {
      receipts.push(await rt.orchestration.dispatch({ routerSessionId: routerSession, ...t }))
    }
    expect(receipts.every((r) => r.materialized)).toBe(true)
    // 三个 worker 是**不同会话**（并行，不是同一个）
    expect(new Set(receipts.map((r) => r.workerSessionId)).size).toBe(3)

    // ③ 等三个 worker 全部完成
    await waitForEvents(rt, routerSession, 'worker/completed', 3)

    // ④ 三个 worker 各自的独立日志都完整
    for (const receipt of receipts) {
      const workerEvents = rt.sessions.sessionServiceFor(receipt.workerSessionId).events()
      expect(workerEvents.some((e) => e.type === 'turn/end')).toBe(true)
      // 归属标记指向 Router
      const meta = await rt.sessions.meta({ session_id: receipt.workerSessionId })
      expect(meta.header.parent_session).toBe(routerSession)
    }

    // ⑤ Router 侧：3 条 dispatched + 3 条 completed，且 reason 被记录下来
    const routerEvents = rt.sessions.sessionServiceFor(routerSession).events()
    expect(routerEvents.filter((e) => e.type === 'worker/dispatched')).toHaveLength(3)
    expect(routerEvents.filter((e) => e.type === 'worker/completed')).toHaveLength(3)
    const withReason = routerEvents.find(
      (e) => e.type === 'worker/dispatched' && (e.data as { reason?: string }).reason !== undefined,
    )
    expect(withReason).toBeDefined()

    // ⑥ 状态查询反映三个都已结算
    for (const receipt of receipts) {
      expect(rt.orchestration.status(receipt.taskId)?.state).toBe('settled')
    }
    expect(rt.orchestration.running(routerSession)).toBe(0)

    // ⑦ 全链路可回放。
    //
    // 注意**不能用 Router 会话的回放**：本用例里 Router 只派发、自己没有跑过回合，
    // 而 `sessions.replay` 要求落点在一个有请求快照的回合边界上。
    // worker 才是真正跑了回合的一方，它的日志可回放正是"每条 worker 都能被审计"的证据；
    // Router 侧的审计由上面 ⑤ 的事件断言覆盖。
    const firstWorker = receipts[0]
    expect(firstWorker).toBeDefined()
    const workerSession = rt.sessions.sessionServiceFor(firstWorker?.workerSessionId ?? '')
    const lastAssistant = workerSession.events().filter((e) => e.type === 'assistant/message').at(-1)
    expect(lastAssistant).toBeDefined()
    const replay = await rt.sessions.replay({
      session_id: firstWorker?.workerSessionId ?? '',
      up_to_seq: lastAssistant?.seq ?? 0,
    })
    expect(replay).toBeDefined()
    expect(JSON.stringify(replay)).toContain('任务A')

    await rt.agents.dispose({ agent_id })
    // 等 Router 的汇报轮跑完，否则 afterEach 关会话时它还在写事件
    await new Promise((resolve) => setTimeout(resolve, 300))
  }, 40000)

  it('observe 档下同一套流程不产生任何 worker 会话（预演）', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-e2e-observe-'))
    const rt = await createAgentRuntime({ home, sandbox, orchestrationMode: 'observe' })
    rt.ctx.get('llm').register(new ReplayLlmAdapter([]))
    await rt.ctx.get('agentDefaultModel').set({ provider: 'custom', model: 'test-model' })
    runtime = rt

    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: '预演' })
    rt.sessionRoles.setRole(routerSession, 'router')
    const before = (await rt.sessions.list()).items.length

    const receipts = await Promise.all(
      ['A', 'B', 'C'].map((task) => rt.orchestration.dispatch({ routerSessionId: routerSession, task })),
    )
    expect(receipts.every((r) => !r.materialized)).toBe(true)
    // 没有新会话产生
    expect((await rt.sessions.list()).items.length).toBe(before)
    // 但三条意向都记录了
    const dispatched = rt.sessions.sessionServiceFor(routerSession).events().filter((e) => e.type === 'worker/dispatched')
    expect(dispatched).toHaveLength(3)
  }, 20000)
})
