import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import type { SandboxService } from '@lcode/sandbox'
import type { LspService } from '@lcode/lsp'
import type { WebService } from '@lcode/web'
import { createApprovalService } from '@lcode/approval'
import type { ApprovalService } from '@lcode/approval'
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

const terminalOpenScript: ReplayScript = {
  provider: 'custom',
  model: 'test-model',
  chunks: [
    { type: 'tool-call-delta', callId: 'terminal-open', name: 'terminal', argsDelta: '{"op":"open"}' },
    {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'terminal-open', name: 'terminal', input: { op: 'open' } }],
      },
    },
  ],
}

const blockedWriteScript: ReplayScript = {
  provider: 'custom',
  model: 'test-model',
  chunks: [
    {
      type: 'tool-call-delta',
      callId: 'blocked-write',
      name: 'write',
      argsDelta: '{"path":"should-not-exist.txt","content":"blocked"}',
    },
    {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'blocked-write', name: 'write', input: { path: 'should-not-exist.txt', content: 'blocked' } }],
      },
    },
  ],
}

const submittedPlanScript: ReplayScript = {
  provider: 'custom',
  model: 'test-model',
  chunks: [
    { type: 'tool-call-delta', callId: 'submit-plan', name: 'submit_plan', argsDelta: '{"summary":"创建验收文件","steps":["写入验收文件"]}' },
    {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'submit-plan', name: 'submit_plan', input: { summary: '创建验收文件', steps: ['写入验收文件'] } }],
      },
    },
  ],
}

const writeAfterPlanScript: ReplayScript = {
  provider: 'custom',
  model: 'test-model',
  chunks: [
    { type: 'tool-call-delta', callId: 'write-after-plan', name: 'write', argsDelta: '{"path":"planned.txt","content":"done"}' },
    {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'write-after-plan', name: 'write', input: { path: 'planned.txt', content: 'done' } }],
      },
    },
  ],
}

/** 装配测试不验证 OS 沙箱本身，显式注入受保护 Provider，避免以裸实现掩盖业务断言。 */
const enforcedSandbox: SandboxService = {
  status: async () => ({
    available: true,
    mechanism: 'test',
    knownEscapeSurfaces: [],
    degraded: false,
    capabilities: {
      platform: 'test',
      mechanism: 'test',
      boundaries: {
        filesystem: { state: 'enforced', plannedMechanism: 'test', message: '测试 Provider 已强制' },
        network: { state: 'enforced', plannedMechanism: 'test', message: '测试 Provider 已强制' },
        spawn: { state: 'enforced', plannedMechanism: 'test', message: '测试 Provider 已强制' },
      },
      reason: '测试 Provider 已强制',
    },
  }),
  wrap: async (argv) => ({ enforced: true, wrappedArgv: argv }),
}

/** PTY 的真实数据链测试要验证 node-pty 本身，故显式模拟尚未接入原生 PTY 的降级环境。 */
const degradedSandbox: SandboxService = {
  ...enforcedSandbox,
  status: async () => ({
    ...(await enforcedSandbox.status()),
    available: false,
    mechanism: 'none',
    degraded: true,
    reason: '测试环境没有原生 PTY 沙箱。',
  }),
  wrap: async (argv) => ({ enforced: false, wrappedArgv: argv, degradationReason: '测试环境没有原生 PTY 沙箱。' }),
}

/** 建运行时并把 replay 适配器注册成 `custom`（与设置页里那家同名，模拟真实链路） */
async function makeRuntime(
  scripts: readonly ReplayScript[],
  sandbox: SandboxService = enforcedSandbox,
  approval?: ApprovalService,
  workspaceRoot?: string,
): Promise<AgentRuntime> {
  const rt = await createAgentRuntime({ home, sandbox, ...(approval === undefined ? {} : { approval }), ...(workspaceRoot === undefined ? {} : { workspaceRoot }) })
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
      'request/context',
      'step/start',
      'request/header', // 可重放审计点（06 §6.1）
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
      'checkpoint/created',
    ])
    expect(events.at(-1)).toMatchObject({ type: 'checkpoint/created', data: { files: 0, partial: false } })
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
  it('默认以 desktop-default profile 装配，并只公开脱敏服务关系', async () => {
    const rt = await makeRuntime([textScript])
    expect(rt.composition).toEqual({
      profile: 'desktop-default',
      entries: [
        { id: 'sessions-local', requires: [], adopts: [], provides: ['sessions'] },
        {
          id: 'execution-local',
          adopts: [],
          requires: ['sessions'],
          provides: expect.arrayContaining(['subprocess', 'sandbox', 'fs', 'jobs', 'shell', 'terminals', 'spill']),
        },
        {
          id: 'tooling-local',
          adopts: [],
          requires: ['sessions', 'fs', 'shell', 'terminals', 'spill'],
          provides: ['tools', 'systemPrompt'],
        },
        {
          id: 'model-local',
          requires: ['llm', 'agentDefaultModel'],
          adopts: ['llm', 'agentDefaultModel'],
          provides: [],
        },
        {
          id: 'model-routing-local',
          adopts: [],
          requires: ['llm', 'agentDefaultModel'],
          provides: ['modelRouting'],
        },
        {
          id: 'policy-local',
          adopts: [],
          requires: ['sessions', 'tools', 'systemPrompt', 'sandbox', 'fs'],
          provides: ['permissionPresets', 'workspaceTrust', 'planMode', 'subagents'],
        },
        {
          id: 'extensions-local',
          adopts: [],
          requires: ['tools', 'systemPrompt', 'subprocess', 'sandbox', 'workspaceTrust'],
          provides: ['skills', 'presets', 'plugins'],
        },
        {
          id: 'code-runtime-local',
          adopts: [],
          requires: ['tools', 'subprocess', 'sandbox'],
          provides: ['codeRuntime'],
        },
        {
          id: 'agent-local',
          adopts: [],
          requires: ['llm', 'agentDefaultModel', 'modelRouting', 'sessions', 'tools', 'systemPrompt', 'jobs', 'terminals'],
          provides: ['agentLoop', 'agents', 'contextSources', 'contextBudget', 'compaction'],
        },
        {
          id: 'lcode-spine',
          adopts: [],
          requires: ['sessions', 'agentLoop', 'agents', 'contextSources', 'contextBudget', 'compaction', 'skills', 'presets', 'plugins'],
          provides: [],
        },
      ],
    })
    expect(rt.ctx.get('sessions')).toBe(rt.sessions)
    expect(JSON.stringify(rt.composition)).not.toContain(home)
  })

  it('P7-05：已配置 Web/LSP 才作为可信 Profile entry 挂载，并复用工具权限流水线', async () => {
    const web: WebService = {
      async fetch(input) { return { url: input.url, finalUrl: input.url, status: 200, title: 'test', contentType: 'text/plain', text: 'external', truncated: false, fetchedAt: 1 } },
      async search(input) { return { query: input.query, results: [], truncated: false } },
    }
    const lsp: LspService = { async query() { return [] } }
    const rt = await createAgentRuntime({ home, sandbox: enforcedSandbox, web, lsp })
    runtime = rt
    expect(rt.composition.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'web-provider', requires: ['tools'], provides: ['web'] }),
      expect.objectContaining({ id: 'lsp-provider', requires: ['tools', 'subprocess', 'sandbox'], provides: ['lsp'] }),
    ]))
    expect(rt.ctx.get('tools').schemas().map((tool) => tool.name)).toEqual(expect.arrayContaining(['web_fetch', 'web_search', 'lsp_query', 'run_code']))
  })

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

  it('上下文用量：供应商没给上限时保守回落到 128K', async () => {
    const rt = await makeRuntime([textScript])
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    rt.sessions.sessionServiceFor(session_id).append({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '看一下项目结构' }] },
    })

    const usage = await rt.contextUsage({ sessionId: session_id })
    expect(usage.contextWindowTokens).toBe(128_000)
    expect(usage.usedTokens).toBeGreaterThan(0)
    expect(usage.percent).not.toBeNull()
    expect(usage.usageSource).toBe('estimate')
    expect(usage.measurement.surfaceTokens).toBeGreaterThan(0)
    expect(usage.measurement.systemTokens).toBeGreaterThan(0)
    expect(usage.measurement.toolSchemaTokens).toBeGreaterThan(0)
  })

  it('上下文用量：供应商 usage 是实测基线，后续新增内容标为混合估算', async () => {
    const rt = await makeRuntime([textScript])
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    const session = rt.sessions.sessionServiceFor(session_id)
    session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '看一下项目结构' }] } })
    session.append({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        usage: { input: 1_200, output: 80 },
      },
    })

    const measured = await rt.contextUsage({ sessionId: session_id })
    expect(measured.usageSource).toBe('provider')
    expect(measured.usedTokens).toBe(1_280)
    expect(measured.percent).toBe(1)

    session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
    const mixed = await rt.contextUsage({ sessionId: session_id })
    expect(mixed.usageSource).toBe('mixed')
    expect(mixed.usedTokens).toBeGreaterThan(1_280)
  })

  it('上下文用量：优先用供应商缓存的窗口上限', async () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      model: {
        providers: [{
          name: 'custom',
          label: 'custom',
          model: 'test-model',
          base_url: 'http://127.0.0.1:1',
          api_key_ref: '',
          context_window_max: 129_024,
        }],
      },
    }, null, 2))
    const rt = await makeRuntime([textScript])
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    rt.sessions.sessionServiceFor(session_id).append({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '看一下项目结构' }] },
    })

    const usage = await rt.contextUsage({ sessionId: session_id })
    expect(usage.contextWindowTokens).toBe(129_024)
    expect(usage.usedTokens).toBeGreaterThan(0)
  })

  it('手动压缩：摘要安全前缀并提交 manual 事务；运行中的轮拒绝', async () => {
    const rt = await createAgentRuntime({ home, compactionSummarizer: () => '较早历史摘要' })
    runtime = rt
    rt.ctx.get('llm').register(new ReplayLlmAdapter([textScript]))
    await rt.ctx.get('agentDefaultModel').set({ provider: 'custom', model: 'test-model' })
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    const session = rt.sessions.sessionServiceFor(session_id)
    session.append({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: `旧目标：${'改代码'.repeat(500)}` }] },
    })
    session.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '改完了。' }] } },
    })
    session.append({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续' }] } })

    const result = await rt.compactSession({ sessionId: session_id })
    expect(result).toMatchObject({ status: 'compacted' })
    const derived = await rt.sessions.derive({ session_id })
    expect(JSON.stringify(derived.messages[0])).toContain('较早历史摘要')
    expect(JSON.stringify(derived.messages.at(-1))).toContain('继续')

    session.append({ type: 'turn/start', data: { turn: 2 } })
    await expect(rt.compactSession({ sessionId: session_id })).rejects.toThrow('这一轮还在执行')
  })

  it('agents.inject 进入本轮系统提示，但不会污染下一轮', async () => {
    const rt = await makeRuntime([textScript, textScript])
    const { session_id } = await rt.sessions.create({ cwd: '/repo/web' })
    const { agent_id } = await rt.agents.create({ session_id })

    await rt.agents.inject({ agent_id, content: [{ type: 'text', text: '宿主提示：a.txt 无法回退' }] })
    await sendAndWait(rt, agent_id, '第一轮')
    await sendAndWait(rt, agent_id, '第二轮')

    const systems = rt.sessions
      .sessionServiceFor(session_id)
      .events()
      .filter((event) => event.type === 'request/header')
      .map((event) => event.data.header.system)
    expect(systems).toHaveLength(2)
    expect(systems[0]).toContain('宿主提示：a.txt 无法回退')
    expect(systems[1]).not.toContain('宿主提示：a.txt 无法回退')
  })

  it('P7-01：上下文来源预计算、限于工作区并写入请求审计', async () => {
    const workspace = join(home, 'workspace')
    mkdirSync(join(workspace, '.lcode'), { recursive: true })
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), 'Use the project formatter.', 'utf8')
    writeFileSync(join(workspace, 'src', 'example.txt'), 'untrusted file payload', 'utf8')
    const rt = await makeRuntime([textScript], enforcedSandbox, undefined, workspace)

    const referenced = await rt.sessions.create({ cwd: workspace })
    rt.sessions.sessionServiceFor(referenced.session_id).append({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: 'Referenced session fact.' }] },
    })
    const { session_id } = await rt.sessions.create({ cwd: workspace })
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, `Check @src/example.txt @session:${referenced.session_id}`)
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    const context = events.find((event) => event.type === 'request/context')
    expect(context).toMatchObject({
      data: { sources: expect.arrayContaining(['time:iso-8601', 'instructions:AGENTS.md', 'repo-map:root', 'file:src/example.txt', `session:${referenced.session_id}`]) },
    })
    const header = events.find((event) => event.type === 'request/header')
    expect(header).toMatchObject({
      data: { header: { system: expect.stringContaining('Use the project formatter.') } },
    })
    expect(JSON.stringify(header)).toContain('[UNTRUSTED DATA]')
    expect(rt.ctx.get('contextSources').inspect(session_id)).toMatchObject({ sessionId: session_id })
  })

  it('未选择工作区的会话不注入仓库上下文，也不借用默认工作区', async () => {
    const workspace = join(home, 'workspace-unscoped')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), 'SHOULD NOT LEAK INTO RECENT TASKS', 'utf8')
    const rt = await makeRuntime([textScript], enforcedSandbox, undefined, workspace)
    const { session_id } = await rt.sessions.create({})
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, 'Check @AGENTS.md')
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    const context = events.find((event) => event.type === 'request/context')
    expect(context).toMatchObject({ data: { sources: ['time:iso-8601'] } })
    const header = events.find((event) => event.type === 'request/header')
    expect(JSON.stringify(header)).not.toContain('SHOULD NOT LEAK INTO RECENT TASKS')
    expect(rt.sessions.workspaceOf(session_id)).toBeUndefined()
  })

  it('`request/header` 记下完整模型输入配置（可重放审计点）', async () => {
    const rt = await makeRuntime([textScript])
    const sessionId = await runTurn(rt)
    const events = loadLog(join(home, (await rt.sessions.meta({ session_id: sessionId })).header.log_path)).events
    const header = events.find((e) => e.type === 'request/header')
    expect(header).toMatchObject({
      data: {
        header: {
          provider: 'custom',
          model: 'test-model',
          system: expect.stringContaining('Lcode'),
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'read', inputSchema: expect.any(Object) }),
          ]),
        },
      },
    })
  })

  it('工具已接：注册表含计划提交工具，但正常请求不暴露它', async () => {
    const rt = await makeRuntime([textScript])
    // 五个文件工具 + shell + terminal + 子代理 + 代码模式 + 两个计划工具
    expect(rt.ctx.get('tools').schemas().map((s) => s.name).sort()).toEqual([
      'delegate',
      'edit',
      'glob',
      'grep',
      'read',
      'request_plan_change',
      'run_code',
      'shell',
      'skill_list',
      'skill_load',
      'submit_plan',
      'terminal',
      'write',
    ])
    const assembled = await rt.ctx.get('systemPrompt').assemble({})
    // 提示词要如实描述能力。说反了（说"不能"但实际能）会让模型不敢用工具，
    // 而说"能"但实际没有会让它编造 —— 两头都是真事故，所以这一条钉住措辞
    expect(assembled.system).not.toContain('尚未接入')
    expect(assembled.system).toContain('read')
    expect(assembled.system).toContain('edit')
    expect(assembled.tools.some((tool) => tool.name === 'submit_plan')).toBe(false)
    expect(assembled.tools.some((tool) => tool.name === 'request_plan_change')).toBe(false)
  })

  it('P7-04：子代理继承组合快照，创建独立会话且只能看到只读工具', async () => {
    const rt = await makeRuntime([textScript])
    const { session_id: parentSessionId } = await rt.sessions.create({ cwd: home, title: '父任务' })

    const delegated = await rt.subagents.run({ parentSessionId, task: '只调查当前项目的入口文件。' })
    expect(delegated).toMatchObject({ outcome: 'completed', depth: 1, result: '改完了，测试也过了。' })
    expect(delegated.childSessionId).toEqual(expect.any(String))

    const parentEvents = rt.sessions.sessionServiceFor(parentSessionId).events()
    expect(parentEvents.find((event) => event.type === 'subagent/delegated')).toMatchObject({
      data: {
        childSessionId: delegated.childSessionId,
        depth: 1,
        allowedToolIds: ['read', 'glob', 'grep'],
        profileId: 'desktop-default',
      },
    })
    expect(parentEvents.find((event) => event.type === 'subagent/completed')).toMatchObject({ data: { outcome: 'completed' } })

    const childEvents = rt.sessions.sessionServiceFor(delegated.childSessionId!).events()
    const header = childEvents.find((event) => event.type === 'request/header')
    expect(header).toMatchObject({ data: { header: { tools: [{ name: 'read' }, { name: 'glob' }, { name: 'grep' }] } } })
    expect(rt.ctx.get('agents').list().some((agent) => agent.sessionId === delegated.childSessionId)).toBe(false)
  })

  it('计划模式：请求只暴露只读工具，写调用被拒绝且不落盘', async () => {
    const rt = await makeRuntime([blockedWriteScript, textScript])
    const { session_id } = await rt.sessions.create({ cwd: home, title: '计划模式测试' })
    rt.ctx.get('planMode').enter(session_id)
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, '先分析再修改')
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    const header = events.find((event) => event.type === 'request/header')
    expect(header).toMatchObject({
      data: { header: { tools: [{ name: 'read' }, { name: 'glob' }, { name: 'grep' }, { name: 'submit_plan' }] } },
    })
    const result = events.find((event) => event.type === 'tool/result')
    expect(result).toMatchObject({
      data: { message: { toolCallId: 'blocked-write', isError: true }, error: { code: 'ET-DENIED' } },
    })
    expect(existsSync(join(home, 'should-not-exist.txt'))).toBe(false)
  })

  it('计划提交并确认后，自动创建正常执行回合并按批准计划写入', async () => {
    const rt = await makeRuntime([submittedPlanScript, textScript, writeAfterPlanScript, textScript])
    const { session_id } = await rt.sessions.create({ cwd: home, title: '计划确认闭环' })
    rt.ctx.get('workspaceTrust').setTrusted(home, true)
    rt.ctx.get('planMode').enter(session_id)
    const { agent_id } = await rt.agents.create({ session_id })

    await sendAndWait(rt, agent_id, '先给计划')
    const approved = rt.ctx.get('planMode').confirm(session_id)
    expect(rt.ctx.get('planMode').isActive(session_id)).toBe(false)

    await sendAndWait(rt, agent_id, approved.executionPrompt)
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    expect(events.map((event) => event.type)).toContain('plan/proposed')
    expect(events.map((event) => event.type)).toContain('plan/approved')
    expect(existsSync(join(home, 'planned.txt'))).toBe(true)
    expect(readFileSync(join(home, 'planned.txt'), 'utf8')).toBe('done')

    const checkpoint = [...events].reverse().find((event) => event.type === 'checkpoint/created')
    expect(checkpoint).toMatchObject({ data: { files: 1, partial: false } })
    writeFileSync(join(home, 'planned.txt'), 'drift', 'utf8')
    await rt.checkpoints.restore({
      sessionId: session_id,
      workspaceRoot: home,
      session: rt.sessions.sessionServiceFor(session_id),
      checkpointId: (checkpoint?.data as { checkpointId: string }).checkpointId,
    })
    expect(readFileSync(join(home, 'planned.txt'), 'utf8')).toBe('done')
    await rt.sessions.flush({ session_id })
    const restored = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events.at(-1)
    expect(restored).toMatchObject({ type: 'checkpoint/restored' })
  })

  it('terminal.open 走真实 PTY，并落下可回放的 tool/call 与 terminal 卡片', async () => {
    const rt = await makeRuntime(
      [terminalOpenScript, textScript],
      degradedSandbox,
      createApprovalService({ channel: { ask: async () => 'allowed-once' } }),
    )
    const cwd = process.cwd()
    const { session_id } = await rt.sessions.create({ cwd, title: '终端工具测试' })
    rt.ctx.get('workspaceTrust').setTrusted(cwd, true)
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, '打开一个终端')
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    const call = events.find((event) => event.type === 'tool/call')
    const result = events.find((event) => event.type === 'tool/result')
    expect(call).toMatchObject({ data: { name: 'terminal', callId: 'terminal-open', card: 'terminal' } })
    expect(result).toMatchObject({
      data: { message: { toolCallId: 'terminal-open', isError: false }, meta: { card: 'terminal', op: 'open', terminalId: expect.any(String) } },
    })
  })

  it('系统级沙箱未提供受控 PTY 时，terminal.open 明确拒绝', async () => {
    const rt = await makeRuntime([terminalOpenScript, textScript])
    const cwd = process.cwd()
    const { session_id } = await rt.sessions.create({ cwd, title: '受控终端拒绝测试' })
    rt.ctx.get('workspaceTrust').setTrusted(cwd, true)
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, '打开一个终端')
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    expect(events.find((event) => event.type === 'tool/result')).toMatchObject({
      data: { message: { toolCallId: 'terminal-open', isError: true }, error: { code: 'EC-NOT_READY' } },
    })
  })

  it('未信任工作区在标准权限下仍拒绝打开终端', async () => {
    const rt = await makeRuntime([terminalOpenScript, textScript])
    const { session_id } = await rt.sessions.create({ cwd: home, title: '未信任终端测试' })
    const { agent_id } = await rt.agents.create({ session_id })
    await sendAndWait(rt, agent_id, '打开一个终端')
    await rt.sessions.flush({ session_id })

    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    const result = events.find((event) => event.type === 'tool/result')
    expect(result).toMatchObject({
      data: {
        message: { toolCallId: 'terminal-open', isError: true },
        error: { code: 'ET-DENIED' },
      },
    })
  })

  it('文件系统与 shell 服务都挂进了 ctx（工具靠它们干活）', async () => {
    const rt = await makeRuntime([textScript])
    expect(rt.ctx.get('fs')).toBeDefined()
    expect(rt.ctx.get('shell')).toBeDefined()
    expect(rt.ctx.get('terminals')).toBeDefined()
    expect(rt.ctx.get('jobs')).toBeDefined()
    expect(rt.ctx.get('sandbox')).toBeDefined()
    expect(rt.ctx.get('permissionPresets').get()).toBe('标准')
  })

  it('P6 产品接入：本地插件、Skill 和预设都经 Runtime 装配且可追溯', async () => {
    const plugin = join(home, 'plugin-source')
    mkdirSync(join(plugin, 'dist'), { recursive: true })
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
    writeFileSync(join(plugin, 'lcode.json'), JSON.stringify({
      $schema: 'https://lcode.dev/schema/plugin-1.json',
      id: 'com.example.runtime-demo',
      name: 'Runtime Demo',
      version: '1.0.0',
      engines: { lcode: '^0.1.0' },
      entry: './dist/index.js',
      permissions: {},
      contributes: { tools: ['demo/runtime'] },
    }), 'utf8')
    writeFileSync(join(plugin, 'dist', 'index.js'), "export async function activate(ctx) { await ctx.registerTool({ name: 'demo/runtime', description: 'runtime', inputSchema: { type: 'object', properties: {} } }, async () => ({ ok: true })) }", 'utf8')
    mkdirSync(join(home, 'skills', 'review'), { recursive: true })
    writeFileSync(join(home, 'skills', 'review', 'SKILL.md'), '# Review\nInspect the active diff.', 'utf8')
    mkdirSync(join(home, 'presets'), { recursive: true })
    writeFileSync(join(home, 'presets', 'review.yml'), 'id: review\nname: Review\nmodel:\n  maxTokens: 4096\n', 'utf8')

    const rt = await makeRuntime([textScript])
    await rt.plugins.installLocal(plugin)
    await rt.plugins.activate({ id: 'com.example.runtime-demo', version: '1.0.0' })
    expect(rt.plugins.inspect()).toMatchObject([{ id: 'com.example.runtime-demo', state: 'active', contributes: { tools: ['demo/runtime'] } }])
    expect(rt.ctx.get('tools').schemas().map((tool) => tool.name)).toContain('demo/runtime')
    await expect(rt.skills.catalog()).resolves.toEqual([{ id: 'review', name: 'Review', description: 'Inspect the active diff.', source: 'user' }])

    const { session_id } = await rt.sessions.create({ cwd: home })
    await expect(rt.presets.snapshot({ sessionId: session_id, ids: ['review'] })).resolves.toMatchObject({
      sessionId: session_id,
      ids: ['review'],
      sources: ['user'],
      config: { model: { maxTokens: 4096 } },
    })
    await rt.sessions.flush({ session_id })
    const events = loadLog(join(home, (await rt.sessions.meta({ session_id })).header.log_path)).events
    expect(events.at(-1)).toMatchObject({ type: 'preset/snapshot', data: { ids: ['review'] } })
  })

  it('agent 销毁会终止其已发布的后台作业（不是取消任意一个对话回合）', async () => {
    const rt = await makeRuntime([textScript])
    const { session_id } = await rt.sessions.create({ cwd: home, title: '作业 owner 清理' })
    const { agent_id } = await rt.agents.create({ session_id })
    let aborted = false
    const started = await rt.ctx.get('jobs').start({
      kind: 'watch',
      label: 'owner cleanup test',
      ownerAgentId: agent_id,
      run: async ({ signal }) => await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
      }),
    })
    await rt.agents.dispose({ agent_id })
    expect(aborted).toBe(true)
    expect(rt.ctx.get('jobs').status({ jobId: started.jobId, ownerAgentId: agent_id }).status).toBe('killed')
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
