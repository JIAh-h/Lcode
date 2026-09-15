import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import { loadLog } from '@lcode/session-persistence-jsonl'
import { closeAllIndexDbs, openIndexDb } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentRuntime } from './agent-runtime.ts'
import type { AgentRuntime } from './agent-runtime.ts'

/**
 * **对话闭环**的装配验收（docs/24 T5.2/T5.3）。
 *
 * 判据（用户可见的那条）：
 * > 输入一句话 → 拿到模型回复 → 会话落进 `~/.lcode/sessions/` → 索引里查得到
 *
 * 用 `llm-replay` 驱动，**不联网、不花钱**（15 §7 快照重放策略）。
 * 这里盯的是**接线**：引擎的事件到底有没有写穿到 JSONL、有没有进索引。
 * （`agent-loop` 自身的行为在它自己的包里测过，这里不重复。）
 */

let home = ''
let runtime: AgentRuntime | null = null

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-runtime-'))
})

afterEach(async () => {
  await runtime?.dispose()
  runtime = null
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const textScript: ReplayScript = {
  provider: 'custom',
  model: 'test-model',
  chunks: [
    { type: 'text-delta', text: '改完了，' },
    { type: 'text-delta', text: '测试也过了。' },
    { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '改完了，测试也过了。' }] } },
  ],
}

/** 建运行时并把 replay 适配器注册成 `custom`（与设置页里那家同名，模拟真实链路） */
async function makeRuntime(scripts: readonly ReplayScript[]): Promise<AgentRuntime> {
  const rt = await createAgentRuntime({ home })
  const llm = rt.ctx.get('llm')
  // 用 replay 顶掉真实适配器：`ctx.llm` 是注册表，按 provider 名查找（消费方不知道实现）
  llm.register(new ReplayLlmAdapter(scripts))
  const models = rt.ctx.get('agentDefaultModel')
  await models.set({ provider: 'custom', model: 'test-model' })
  runtime = rt
  return rt
}

/**
 * 提交一句话并**等到那一轮真的跑完**。
 *
 * 为什么不能"followup 完就断言"：`agents.followup` **只返回入队回执**，不等本轮结果
 *（21 §2.2：「等待某个区间是调用方自己的事」）。契约给的等待判据是
 * `agents.watch` 的 idle 事件带 `seq`（此刻日志长度）——**`idleSeq >= 回执 seq` 即跑完**。
 *
 * 这个判据也正是 UI 要用的那个：渲染层不能靠"发送成功"就当拿到了回复。
 */
async function sendAndWait(rt: AgentRuntime, agentId: string, text: string): Promise<void> {
  const status = rt.agents.watch({ agent_id: agentId })
  const receipt = await rt.agents.followup({ agent_id: agentId, content: [{ type: 'text', text }] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待本轮结束超时（5s）')), 5000)
    const stop = status.subscribe((event) => {
      if (event.status !== 'idle') return
      // 回执的 seq 是"本轮 user/message 的 seq"；idle 时的 seq 是"此刻日志长度"。
      // 长度大于起点就说明这一轮写完了。
      if ((event.seq ?? 0) > receipt.seq) {
        clearTimeout(timer)
        stop()
        resolve()
      }
    })
  })
  status.close()
}

/** 跑一轮对话，返回 sessionId */
async function runTurn(rt: AgentRuntime, text = '把 parse.ts 换成结构化解析'): Promise<string> {
  const { session_id } = await rt.sessions.create({ cwd: '/repo/web', title: '对话测试' })
  const { agent_id } = await rt.agents.create({ session_id })
  await sendAndWait(rt, agent_id, text)
  await rt.sessions.flush({ session_id })
  return session_id
}

describe('A. 对话闭环：一句话 → 回复 → 落盘 → 可查', () => {
  it('跑通一轮纯对话（无工具），事件写穿到 JSONL', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)

    const meta = await rt.sessions.meta({ session_id: sessionId })
    const file = join(home, meta.header.log_path)
    const events = loadLog(file).events

    // 结构边界齐全：一轮一步，且闭合
    expect(events.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'request/header', // 可重放审计点（06 §6.1）
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    // I2：seq 连续无空洞
    events.forEach((event, index) => expect(event.seq).toBe(index))
  })

  it('**用户输入的文本真的进了日志**（不是 mock）', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt, '给我讲讲这个项目')
    const events = loadLog(join(home, (await rt.sessions.meta({ session_id: sessionId })).header.log_path)).events
    const user = events.find((e) => e.type === 'user/message')
    expect(JSON.stringify(user?.data)).toContain('给我讲讲这个项目')
  })

  it('**模型回复真的进了日志**，且派生历史能读出来', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)

    const { messages } = await rt.sessions.derive({ session_id: sessionId })
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(JSON.stringify(assistant?.content)).toContain('测试也过了')
  })

  it('会话进了**索引**：列表里能按工作区找到它', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)

    const listed = await rt.sessions.list({ workspace: '/repo/web' })
    expect(listed.items.map((s) => s.session_id)).toContain(sessionId)

    // 索引里的 turns/steps 也落了（不是只有 sessions 一行）
    const db = openIndexDb({ home })
    for (const table of ['turns', 'steps', 'messages_projection']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)
      expect(row, `${table} 应有行`).toMatchObject({ n: expect.any(Number) })
      expect((row as { n: number }).n).toBeGreaterThan(0)
    }
    db.close()
  })

  it('**模型选择来自配置**：没配默认模型时不该静默用一个假模型', async () => {
    const rt = await createAgentRuntime({ home })
    runtime = rt
    rt.ctx.get('llm').register(new ReplayLlmAdapter([textScript]))
    // 故意不设默认模型
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    const { agent_id } = await rt.agents.create({ session_id })
    await expect(
      rt.agents.followup({ agent_id, content: [{ type: 'text', text: '你好' }] }),
    ).rejects.toMatchObject({ code: 'EL-NO_MODEL_CONFIGURED' })
  })

  it('重启后会话仍在（JSONL 是权威真相）', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)
    await rt.dispose()
    runtime = null
    closeAllIndexDbs()

    const rt2 = await makeRuntime([textScript])
    const meta = await rt2.sessions.meta({ session_id: sessionId })
    expect(meta.header.title).toBe('对话测试')
  })
})

describe('A. 装配的接线正确性', () => {
  it('引擎与 sessions 共用同一条日志：引擎写的事件 sessions 读得到', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)

    // 如果 getSession 走的是"裸 InMemorySessionStore"，这里会读到空
    const viaSessions = await rt.sessions.derive({ session_id: sessionId })
    expect(viaSessions.messages.length).toBeGreaterThan(0)
  })

  it('`ctx.systemPrompt` 装配了一段基础提示（否则模型不知道自己在哪）', async () => {
    const rt = await makeRuntime([textScript])
    const prompt = rt.ctx.get('systemPrompt')
    const assembled = await prompt.assemble({})
    expect(assembled.system).toContain('Lcode')
  })

  it('`request/header` 记下了 provider 与 model（可重放审计点）', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)
    const events = loadLog(join(home, (await rt.sessions.meta({ session_id: sessionId })).header.log_path)).events
    const header = events.find((e) => e.type === 'request/header')
    expect(header).toMatchObject({ data: { header: { provider: 'custom', model: 'test-model' } } })
  })

  it('工具已接：`ctx.tools` 有六个工具，且提示词**不再**说"不能读写文件"', async () => {
    const rt = await makeRuntime([textScript])
    // 五个文件工具 + shell
    expect(rt.ctx.get('tools').schemas().map((s) => s.name).sort()).toEqual([
      'edit',
      'glob',
      'grep',
      'read',
      'shell',
      'write',
    ])
    const assembled = await rt.ctx.get('systemPrompt').assemble({})
    // 提示词要如实描述能力。说反了（说"不能"但实际能）会让模型不敢用工具，
    // 而说"能"但实际没有会让它编造 —— 两头都是真事故，所以这一条钉住措辞
    expect(assembled.system).not.toContain('尚未接入')
    expect(assembled.system).toContain('read')
    expect(assembled.system).toContain('edit')
  })

  it('文件系统与 shell 服务都挂进了 ctx（工具靠它们干活）', async () => {
    const rt = await makeRuntime([textScript])
    expect(rt.ctx.get('fs')).toBeDefined()
    expect(rt.ctx.get('shell')).toBeDefined()
    expect(rt.ctx.get('sandbox')).toBeDefined()
    expect(rt.ctx.get('permissionPresets').get()).toBe('标准')
  })
})

describe('A. 并发与多轮', () => {
  it('同一会话连续两轮，seq 继续接而不是重排', async () => {
    const rt = await makeRuntime([textScript, textScript])
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, '第一轮')
    await rt.sessions.flush({ session_id })
    await sendAndWait(rt, agent_id, '第二轮')
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    events.forEach((event, index) => expect(event.seq).toBe(index))
    expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(2)
  })

  it('两个会话互不干扰', async () => {
    const rt = await makeRuntime([textScript, textScript])
    const a = await runTurn(rt, 'A 的话')
    const b = await runTurn(rt, 'B 的话')

    const readOf = async (id: string): Promise<string> =>
      readFileSync(join(home, (await rt.sessions.meta({ session_id: id })).header.log_path), 'utf8')
    expect(await readOf(a)).toContain('A 的话')
    expect(await readOf(a)).not.toContain('B 的话')
    expect(await readOf(b)).toContain('B 的话')
  })
})
