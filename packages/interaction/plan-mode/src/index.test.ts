import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemorySessionStore } from '@lcode/session'
import { createSystemPromptService } from '@lcode/system-prompt'
import { InMemoryToolRegistry } from '@lcode/tools'
import { asSessionId } from '@lcode/util'
import { createPlanModeService } from './index.ts'

function harness() {
  const ctx = createContext()
  const sessions = new Map<string, InMemorySessionStore>()
  const getSession = (id: string): InMemorySessionStore => {
    const session = sessions.get(id)
    if (session === undefined) throw new Error(`missing session: ${id}`)
    return session
  }
  const addSession = (id: string): InMemorySessionStore => {
    const session = new InMemorySessionStore(asSessionId(id))
    sessions.set(id, session)
    return session
  }
  const tools = new InMemoryToolRegistry(ctx)
  const executed: string[] = []
  for (const name of ['read', 'glob', 'grep', 'write']) {
    tools.register({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        executed.push(name)
        return { name }
      },
    })
  }
  const prompt = createSystemPromptService(tools)
  const approvalRequests: unknown[] = []
  const plan = createPlanModeService({
    ctx,
    getSession,
    systemPrompt: prompt,
    tools,
    approval: { ask: async (request: unknown) => {
      approvalRequests.push(request)
      return 'allowed-once'
    } },
  })
  return { addSession, executed, plan, prompt, tools, approvalRequests }
}

describe('PlanModeService', () => {
  it('计划会话只向模型暴露只读工具，写调用在执行前被拒绝', async () => {
    const h = harness()
    h.addSession('plan')
    h.plan.enter('plan')

    const assembled = await h.prompt.assemble({ sessionId: 'plan' })
    expect(assembled.tools.map((tool) => tool.name)).toEqual(['read', 'glob', 'grep', 'submit_plan'])
    expect(assembled.system).toContain('计划模式')

    const result = await h.tools.execute(
      { callId: 'write-1', name: 'write', arguments: '{}' },
      { signal: new AbortController().signal, scope: { sessionId: 'plan' } },
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'ET-DENIED' } })
    expect(JSON.stringify(result.meta)).toContain('计划模式')
    expect(h.executed).toEqual([])
  })

  it('会话级过滤不影响其它会话，确认后恢复常规执行', async () => {
    const h = harness()
    const planSession = h.addSession('plan')
    h.addSession('execute')
    h.plan.enter('plan')

    expect((await h.prompt.assemble({ sessionId: 'execute' })).tools.map((tool) => tool.name)).toEqual([
      'read', 'glob', 'grep', 'write',
    ])
    await expect(
      h.tools.execute(
        { callId: 'write-other', name: 'write', arguments: '{}' },
        { signal: new AbortController().signal, scope: { sessionId: 'execute' } },
      ),
    ).resolves.toMatchObject({ ok: true })

    await h.tools.execute(
      { callId: 'plan-before-confirm', name: 'submit_plan', arguments: JSON.stringify({ summary: '执行写入', steps: ['写入文件'] }) },
      { signal: new AbortController().signal, scope: { sessionId: 'plan' } },
    )
    h.plan.confirm('plan')
    await expect(
      h.tools.execute(
        { callId: 'write-after-confirm', name: 'write', arguments: '{}' },
        { signal: new AbortController().signal, scope: { sessionId: 'plan' } },
      ),
    ).resolves.toMatchObject({ ok: true })
    expect(planSession.events().filter((event) => event.type === 'plan/mode').map((event) => event.data)).toEqual([
      { active: true, reason: 'entered' },
      { active: false, reason: 'confirmed' },
    ])
    expect(h.executed).toEqual(['write', 'write'])
  })

  it('提交并确认计划会记录权威计划，且生成可直接交给执行回合的提示', async () => {
    const h = harness()
    const session = h.addSession('plan')
    h.plan.enter('plan')
    await expect(h.tools.execute(
      { callId: 'plan-1', name: 'submit_plan', arguments: JSON.stringify({ summary: '补测试', steps: ['定位缺口', '补充用例'], risks: ['不改接口'] }) },
      { signal: new AbortController().signal, scope: { sessionId: 'plan' } },
    )).resolves.toMatchObject({ ok: true })

    const approved = h.plan.confirm('plan')
    expect(approved.plan).toEqual({ summary: '补测试', steps: ['定位缺口', '补充用例'], risks: ['不改接口'] })
    expect(approved.executionPrompt).toContain('现在请直接执行')
    expect(session.events().filter((event) => event.type === 'plan/approved')).toHaveLength(1)
    expect(h.plan.isActive('plan')).toBe(false)
  })

  it('执行中只有通过统一审批才可确认实质计划变更', async () => {
    const h = harness()
    const session = h.addSession('plan')
    h.plan.enter('plan')
    await h.tools.execute(
      { callId: 'plan-1', name: 'submit_plan', arguments: JSON.stringify({ summary: '补测试', steps: ['补用例'] }) },
      { signal: new AbortController().signal, scope: { sessionId: 'plan' } },
    )
    h.plan.confirm('plan')

    expect((await h.prompt.assemble({ sessionId: 'plan' })).tools.map((tool) => tool.name)).toContain('request_plan_change')
    await expect(h.tools.execute(
      { callId: 'change-1', name: 'request_plan_change', arguments: JSON.stringify({ summary: '补测试和修复接口', steps: ['补用例', '修复接口'], reason: '发现接口契约与测试冲突' }) },
      { signal: new AbortController().signal, scope: { sessionId: 'plan' } },
    )).resolves.toMatchObject({ ok: true, value: { accepted: true } })
    expect(h.approvalRequests).toHaveLength(1)
    expect(session.events().map((event) => event.type)).toContain('plan/changed')
  })
})
