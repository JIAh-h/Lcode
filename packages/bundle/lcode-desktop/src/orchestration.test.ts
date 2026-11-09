/**
 * P11 跨会话编排的闭环测试（docs/26）。
 *
 * 这组用例覆盖设计文档里**每一条已定决策**，而不是只测"能跑"：
 * - §4 事件契约：worker/dispatched 与 worker/completed 都写在 Router 会话
 * - §5.4 自动汇报：有产出汇报、无产出不出声、失败必须出声
 * - §6 取消隔离：Router 停 worker 继续；只能显式 cancel worker
 * - §7.4 三档授权：off 拒绝、observe 只记录、auto 真派发
 * - §7.5 并发：超过上限排队而非拒绝；worker 不能再派发
 * - §3.2 Router 不持有执行工具
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
import { ROUTER_FORBIDDEN_TOOLS } from './session-roles.ts'

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
  // 顺序很重要：先 dispose（它会等在途 worker 的 agent 停下），再关索引库，最后删目录。
  await runtime?.dispose()
  runtime = undefined
  /*
   * dispose 之后再让出一个"静默期"。
   *
   * 为什么还要等：`orchestration.dispose` 等待的是**已 materialize** 的 worker；
   * 队列里尚未落地的派发（并发上限用例）会在 dispose 前一刻被 pumpQueue 启动，
   * 那一次 `sessions.create` + agent 创建是异步的，可能排在 dispose 之后。
   * 这是测试基础设施的兜底，不是产品缺陷——真实使用中 Router 不会在派发途中被销毁。
   */
  await new Promise((resolve) => setTimeout(resolve, 150))
  closeAllIndexDbs()
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

async function makeRuntime(scripts: readonly ReplayScript[], mode?: 'off' | 'observe' | 'auto', max?: number): Promise<AgentRuntime> {
  home = mkdtempSync(join(tmpdir(), 'lcode-p11-'))
  const rt = await createAgentRuntime({
    home,
    sandbox,
    ...(mode === undefined ? {} : { orchestrationMode: mode }),
    ...(max === undefined ? {} : { maxConcurrentWorkers: max }),
  })
  rt.ctx.get('llm').register(new ReplayLlmAdapter([...scripts]))
  await rt.ctx.get('agentDefaultModel').set({ provider: 'custom', model: 'test-model' })
  runtime = rt
  return rt
}

/** 等某个会话出现指定事件（有超时，避免测试挂死）。 */
async function waitForEvent(rt: AgentRuntime, sessionId: string, type: string, timeoutMs = 5000): Promise<void> {
  const session = rt.sessions.sessionServiceFor(sessionId)
  if (session.events().some((event) => event.type === type)) return
  await new Promise<void>((resolve, reject) => {
    let unwatch: () => void = () => {}
    const timer = setTimeout(() => {
      unwatch()
      reject(new Error(`等待 ${type} 超时`))
    }, timeoutMs)
    unwatch = rt.watchSession(sessionId, (event) => {
      if (event.type !== type) return
      clearTimeout(timer)
      unwatch()
      resolve()
    })
  })
}

/** 等到某个会话出现指定事件**至少 count 次**。 */
async function waitForEvents(
  rt: AgentRuntime,
  sessionId: string,
  type: string,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
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

describe('P11-01 事件契约：派发与完成都记在 Router 会话', () => {
  it('auto 档派发后，Router 会话落 worker/dispatched 与 worker/completed', async () => {
    const rt = await makeRuntime([reply('worker 干完了。')], 'auto')
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')

    const receipt = await rt.orchestration.dispatch({ routerSessionId: routerSession, task: '调研入口文件。', reason: '需要独立调查' })
    expect(receipt.materialized).toBe(true)
    // 立刻回来，不等 worker
    expect(receipt.workerSessionId).not.toBe('')

    await waitForEvent(rt, routerSession, 'worker/completed')
    const events = rt.sessions.sessionServiceFor(routerSession).events()
    expect(events.find((event) => event.type === 'worker/dispatched')).toMatchObject({
      data: { taskId: receipt.taskId, workerSessionId: receipt.workerSessionId, reason: '需要独立调查' },
    })
    expect(events.find((event) => event.type === 'worker/completed')).toMatchObject({
      data: { taskId: receipt.taskId, outcome: 'completed' },
    })
  })

  it('worker 是独立会话：自己的日志里有完整回合，Router 不持有它的工具输出', async () => {
    const rt = await makeRuntime([reply('worker 结论')], 'auto')
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')
    const receipt = await rt.orchestration.dispatch({ routerSessionId: routerSession, task: '独立任务' })
    await waitForEvent(rt, routerSession, 'worker/completed')

    const workerEvents = rt.sessions.sessionServiceFor(receipt.workerSessionId).events()
    expect(workerEvents.some((event) => event.type === 'turn/end')).toBe(true)
    // worker 的父会话标记指向 Router
    const meta = await rt.sessions.meta({ session_id: receipt.workerSessionId })
    expect(meta.header.parent_session).toBe(routerSession)
  })
})

describe('P11-06 编排授权三档（§7.4）', () => {
  it('off 档拒绝派发', async () => {
    const rt = await makeRuntime([reply('x')], 'off')
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'R' })
    await expect(rt.orchestration.dispatch({ routerSessionId: session_id, task: 't' })).rejects.toThrow('off')
  })

  it('observe 档只记录，不建 worker 会话、不调模型', async () => {
    const rt = await makeRuntime([reply('不应该被调用')], 'observe')
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'R' })
    const before = (await rt.sessions.list()).items.length
    const receipt = await rt.orchestration.dispatch({ routerSessionId: session_id, task: '预演任务' })

    expect(receipt.materialized).toBe(false)
    expect(receipt.workerSessionId).toBe('')
    // 没有新会话
    expect((await rt.sessions.list()).items.length).toBe(before)
    // 但派发意向落盘了，可回放
    const events = rt.sessions.sessionServiceFor(session_id).events()
    expect(events.find((event) => event.type === 'worker/dispatched')).toMatchObject({ data: { task: '预演任务', workerSessionId: '' } })
  })

  it('默认档是 observe（保守默认）', async () => {
    const rt = await makeRuntime([reply('x')])
    expect(rt.orchestration.mode()).toBe('observe')
  })
})

describe('P11-02 取消隔离（§6）', () => {
  it('Router 被取消不影响 worker；只能显式 cancel worker', async () => {
    const rt = await makeRuntime([reply('worker 完成')], 'auto')
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')
    const { agent_id } = await rt.agents.create({ session_id: routerSession })

    const receipt = await rt.orchestration.dispatch({ routerSessionId: routerSession, task: '长任务' })
    // 取消 Router：worker 不该受影响（取消隔离）
    await rt.agents.cancel({ agent_id, cause: 'user' })
    expect(rt.orchestration.status(receipt.taskId)).toBeDefined()

    // worker 仍然会完成
    await waitForEvent(rt, routerSession, 'worker/completed')
    expect(rt.orchestration.status(receipt.taskId)?.outcome).toBe('completed')
  })

  it('cancel 未知 id 返回 false，不抛错', async () => {
    const rt = await makeRuntime([reply('x')], 'auto')
    expect(await rt.orchestration.cancel('no-such-task')).toBe(false)
  })
})

describe('P11-05 派发深度（§7.5.2）', () => {
  it('worker 不能派发 worker', async () => {
    const rt = await makeRuntime([reply('x')], 'auto')
    const { session_id: workerSession } = await rt.sessions.create({ cwd: home, title: 'W' })
    rt.sessionRoles.setRole(workerSession, 'worker')
    await expect(rt.orchestration.dispatch({ routerSessionId: workerSession, task: '嵌套' })).rejects.toThrow('最多两层')
  })
})

describe('P11-03 Router 不持有执行工具（§3.2）', () => {
  it('Router 会话的请求头里没有 shell/write/edit', async () => {
    const rt = await makeRuntime([reply('router 判断完毕')])
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(session_id, 'router')
    const { agent_id } = await rt.agents.create({ session_id })

    // 先挂 watcher 再发送，避免竞态（本轮可能在 watch 建立前就结束）。
    const done = waitForEvent(rt, session_id, 'turn/end')
    await rt.agents.followup({ agent_id, content: [{ type: 'text', text: '判断一下要派什么' }] })
    await done
    // 显式释放该 agent：本用例自己建了 agent，不释放的话它的收尾会排在
    // afterEach 关会话之后，向已关闭的会话写事件（unhandled rejection）。
    await rt.agents.dispose({ agent_id })

    const header = rt.sessions.sessionServiceFor(session_id).events().find((event) => event.type === 'request/header')
    expect(header).toBeDefined()
    const tools = (header as { data: { header: { tools: readonly { name: string }[] } } }).data.header.tools.map((t) => t.name)
    // Router 不能执行：shell/write/edit/terminal/run_code 一律不得出现
    for (const forbidden of ROUTER_FORBIDDEN_TOOLS) {
      expect(tools).not.toContain(forbidden)
    }
    // 但必须能派发
    expect(tools).toContain('dispatch_worker')
  })
})

describe('P11-07 并发上限（§7.5）', () => {
  it('超过上限的派发排队，不拒绝', async () => {
    // 上限 1：第二个派发应当排队，等第一个完成后再落地
    const rt = await makeRuntime([reply('第一个'), reply('第二个')], 'auto', 1)
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')

    const first = await rt.orchestration.dispatch({ routerSessionId: routerSession, task: '任务一' })
    expect(first.materialized).toBe(true)

    // 第二个：在第一个完成前发起，应进入队列（不 reject）
    const secondPromise = rt.orchestration.dispatch({ routerSessionId: routerSession, task: '任务二' })
    const second = await secondPromise
    expect(second.materialized).toBe(true)
    // 排队后最终也能拿到独立会话
    expect(second.workerSessionId).not.toBe('')
    expect(second.workerSessionId).not.toBe(first.workerSessionId)
    // 等两个 worker 都收尾（队列里的第二个会在第一个完成后才 materialize）。
    // 只等一次不够：那时第二个 worker 可能刚启动，afterEach 关会话会让它写事件失败。
    await waitForEvents(rt, routerSession, 'worker/completed', 2, 15000)
  }, 25000)
})

describe('P11-04 自动汇报（§5.4）', () => {
  it('有产出的 worker 完成后，Router 收到一条汇报（新回合）', async () => {
    // 两段脚本：第一段给 worker，第二段给 Router 处理汇报
    const rt = await makeRuntime([reply('worker 的结论'), reply('收到，已汇总给用户')], 'auto')
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')
    const { agent_id } = await rt.agents.create({ session_id: routerSession })

    await rt.orchestration.dispatch({ routerSessionId: routerSession, task: '调研任务' })
    await waitForEvent(rt, routerSession, 'worker/completed')
    // 汇报会以 followup 形式进入 Router，触发新一轮
    await waitForEvent(rt, routerSession, 'turn/start', 8000)

    const userMessages = rt.sessions
      .sessionServiceFor(routerSession)
      .events()
      .filter((event) => event.type === 'user/message')
    // 汇报文本里带 taskId，便于追问
    expect(userMessages.some((event) => JSON.stringify(event.data).includes('已完成'))).toBe(true)
    await rt.agents.dispose({ agent_id })
  }, 20000)
})

describe('P11-04 批处理窗口（§5.3）', () => {
  it('同一批完成的多个 worker 只唤醒 Router 一次', async () => {
    // 3 个 worker 各一段 + Router 处理合并汇报一段
    const rt = await makeRuntime([reply('A 完成'), reply('B 完成'), reply('C 完成'), reply('已汇总')], 'auto')
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')
    const { agent_id } = await rt.agents.create({ session_id: routerSession })

    await Promise.all(
      ['A', 'B', 'C'].map((task) => rt.orchestration.dispatch({ routerSessionId: routerSession, task })),
    )
    // 等三个 worker 都收尾
    await waitForEvents(rt, routerSession, 'worker/completed', 3, 15000)
    // 再等批处理窗口（200ms）+ Router 汇报轮落地
    await new Promise((resolve) => setTimeout(resolve, 800))

    const events = rt.sessions.sessionServiceFor(routerSession).events()
    // 三个 worker 各写了一条完成事件
    expect(events.filter((e) => e.type === 'worker/completed')).toHaveLength(3)
    /*
     * 关键断言：**Router 只被唤醒一次**（一个 turn/start）。
     *
     * 批处理前这里是 3 次唤醒 —— 并行度越高打扰越密集，正好违背 super-agent 的初衷。
     * 允许 ±0：三个 worker 在同一批里完成，应当合并成一条汇报。
     */
    const routerTurns = events.filter((e) => e.type === 'turn/start').length
    expect(routerTurns).toBe(1)

    // 汇报文本里三个 taskId 都在（合并成一条而不是丢了两个）
    const userMessages = events.filter((e) => e.type === 'user/message')
    const reportText = JSON.stringify(userMessages)
    expect(reportText).toContain('3 个 worker 已完成')

    await rt.agents.dispose({ agent_id })
  }, 30000)
})

describe('P11-10 Router 专用模型（26 §3.2）', () => {
  it('配了 routerModel 后，Router 会话的 request/header 用该模型，普通会话仍用默认模型', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-p11-model-'))
    const rt = await createAgentRuntime({
      home,
      sandbox,
      routerModel: { provider: 'custom', model: 'cheap-router-model' },
    })
    // 两段脚本：Router 一轮、普通会话一轮
    rt.ctx.get('llm').register(new ReplayLlmAdapter([reply('router ok'), reply('normal ok')]))
    await rt.ctx.get('agentDefaultModel').set({ provider: 'custom', model: 'test-model' })
    runtime = rt

    // ① Router 会话
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')
    const { agent_id: routerAgent } = await rt.agents.create({ session_id: routerSession })
    const routerDone = waitForEvent(rt, routerSession, 'turn/end')
    await rt.agents.followup({ agent_id: routerAgent, content: [{ type: 'text', text: '判断一下' }] })
    await routerDone

    const routerHeader = rt.sessions
      .sessionServiceFor(routerSession)
      .events()
      .find((e) => e.type === 'request/header')
    expect((routerHeader as { data: { header: { model: string } } }).data.header.model).toBe('cheap-router-model')

    // ② 普通会话：不受 routerModel 影响
    const { session_id: normalSession } = await rt.sessions.create({ cwd: home, title: '普通' })
    const { agent_id: normalAgent } = await rt.agents.create({ session_id: normalSession })
    const normalDone = waitForEvent(rt, normalSession, 'turn/end')
    await rt.agents.followup({ agent_id: normalAgent, content: [{ type: 'text', text: '普通任务' }] })
    await normalDone

    const normalHeader = rt.sessions
      .sessionServiceFor(normalSession)
      .events()
      .find((e) => e.type === 'request/header')
    expect((normalHeader as { data: { header: { model: string } } }).data.header.model).toBe('test-model')

    // 清理：显式释放自建 agent，避免收尾撞上 afterEach 关会话
    await rt.agents.dispose({ agent_id: routerAgent })
    await rt.agents.dispose({ agent_id: normalAgent })
  }, 20000)

  it('未配 routerModel 时 Router 跟随默认模型', async () => {
    const rt = await makeRuntime([reply('ok')])
    const { session_id } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(session_id, 'router')
    const { agent_id } = await rt.agents.create({ session_id })
    const done = waitForEvent(rt, session_id, 'turn/end')
    await rt.agents.followup({ agent_id, content: [{ type: 'text', text: '判断' }] })
    await done

    const header = rt.sessions
      .sessionServiceFor(session_id)
      .events()
      .find((e) => e.type === 'request/header')
    expect((header as { data: { header: { model: string } } }).data.header.model).toBe('test-model')
    await rt.agents.dispose({ agent_id })
  }, 15000)
})

describe('P11-04 结构化回传（§4.3）', () => {
  it('worker/completed 携带 summary 与 artifacts', async () => {
    const rt = await makeRuntime([reply('结论在这里')], 'auto')
    const { session_id: routerSession } = await rt.sessions.create({ cwd: home, title: 'Router' })
    rt.sessionRoles.setRole(routerSession, 'router')
    await rt.orchestration.dispatch({ routerSessionId: routerSession, task: '任务' })
    await waitForEvent(rt, routerSession, 'worker/completed')

    const completed = rt.sessions
      .sessionServiceFor(routerSession)
      .events()
      .find((event) => event.type === 'worker/completed')
    expect(completed).toMatchObject({ data: { outcome: 'completed', summary: '结论在这里' } })
    const artifacts = (completed as { data: { artifacts?: { toolCalls: number; events: number } } }).data.artifacts
    expect(artifacts?.toolCalls).toBe(0)
    expect(artifacts?.events).toBeGreaterThan(0)
  })
})
