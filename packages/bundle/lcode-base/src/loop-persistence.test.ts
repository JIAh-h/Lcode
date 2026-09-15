import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryAgentStore } from '@lcode/agent'
import { InMemoryAgentDefaultModelService } from '@lcode/agent-default-model'
import { createAgentLoop } from '@lcode/agent-loop'
import { createContext } from '@lcode/context'
import { InMemoryLlmRegistry } from '@lcode/llm'
import { ReplayLlmAdapter } from '@lcode/llm-replay'
import type { ReplayScript } from '@lcode/llm-replay'
import type { SessionService } from '@lcode/session'
import { LocalSessionsApi } from '@lcode/session-api'
import { loadLog } from '@lcode/session-persistence-jsonl'
import { closeAllIndexDbs, openIndexDb, rebuildIndex, searchMessages } from '@lcode/session-persistence-sqlite'
import { createSystemPromptService } from '@lcode/system-prompt'
import { InMemoryToolRegistry } from '@lcode/tools'
import type { ToolDefinition } from '@lcode/tools'
import { asAgentId, asSessionId } from '@lcode/util'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * T5.1 验收（docs/24 §5 阶段 5）：无密钥回放闭环。
 *
 * `llm-replay` + `agent-loop` 跑通一次**完整循环（含工具调用）** →
 * 事件经持久化会话（`LocalSessionsApi.sessionServiceFor`）写入 JSONL（权威真相）→
 * `SessionIndexWriter` 投影到 SQLite → 查询 / 搜索可用；删库重建后**逐行一致**。
 *
 * 这是「装配层」的集成测试：它不测任何单包行为（那些在各自包里测过），
 * 只钉住**缝**——引擎的同步 `append()` 与 write-behind 持久化如何拼在一起。
 * 不联网、不花钱。
 */

// ─────────── 夹具 ───────────

const echoTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  name: 'echo',
  description: '回显输入文本',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  execute: (call) => ({ echoed: call.parsed.text }),
}

const toolScript: ReplayScript = {
  provider: 'replay',
  chunks: [
    { type: 'tool-call-delta', callId: 'call-1', name: 'echo', argsDelta: '{"text":' },
    { type: 'tool-call-delta', callId: 'call-1', name: 'echo', argsDelta: '"hi"}' },
    {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: { text: 'hi' } }],
      },
    },
  ],
}

const textScript = (text: string): ReplayScript => ({
  provider: 'replay',
  chunks: [
    { type: 'text-delta', text },
    {
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      usage: { input: 5, output: 7, total: 12 },
    },
  ],
})

interface Harness {
  readonly home: string
  /** 可变：`restart()` 会换一个新的实例（模拟进程重启） */
  api: LocalSessionsApi
  readonly loop: ReturnType<typeof createAgentLoop>
  readonly registry: InMemoryToolRegistry
  /** 换一个新的 `LocalSessionsApi`（内存状态清空）——崩溃恢复测试需要"新进程" */
  restart(): void
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/**
 * 装配一个 mini-runtime：`LocalSessionsApi`（sessions.* + 持久化 + 索引）
 * 与 `agent-loop`（引擎）共用同一存储——引擎的 getSession 走
 * `api.sessionServiceFor()`，于是引擎的事件**写穿**到同一条 JSONL。
 */
async function makeHarness(scripts: readonly ReplayScript[]): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'lcode-loop-'))
  const api = new LocalSessionsApi({ home })
  const ctx = createContext()
  const getSession = (sessionId: string): SessionService => api.sessionServiceFor(sessionId)
  const registry = new InMemoryToolRegistry(ctx)
  const prompts = createSystemPromptService(registry)
  prompts.section('base', '你是 Lcode。')
  const models = new InMemoryAgentDefaultModelService()
  await models.set({ provider: 'replay', model: 'replay-model' })
  const llm = new InMemoryLlmRegistry()
  llm.register(new ReplayLlmAdapter(scripts))
  ctx.set('agents', new InMemoryAgentStore(ctx, getSession))
  ctx.set('tools', registry)
  ctx.set('systemPrompt', prompts)
  ctx.set('agentDefaultModel', models)
  ctx.set('llm', llm)
  const loop = createAgentLoop({ ctx, getSession })
  const h: Harness = {
    home,
    api,
    loop,
    registry,
    /** 换一个新的 `LocalSessionsApi`（内存状态清空）——用于模拟进程重启后的崩溃恢复 */
    restart: () => {
      h.api = new LocalSessionsApi({ home })
    },
  }
  cleanups.push(async () => {
    await api.close()
    closeAllIndexDbs()
    rmSync(home, { recursive: true, force: true })
  })
  return h
}

type IndexDb = ReturnType<typeof openIndexDb>

/** 跑一轮工具循环（建会话 → 建 agent → followup → flush 到持久屏障） */
async function runToolTurn(h: Harness): Promise<string> {
  h.registry.register(echoTool)
  const { session_id } = await h.api.create({ cwd: '/repo/demo' })
  const handle = await h.loop.create({ sessionId: asSessionId(session_id), id: asAgentId('a1') })
  await handle.followup({ kind: 'text', text: '把 hi 回显一遍' })
  // 持久屏障：JSONL 落盘 + 索引侧的投影应用（drain）都在 flush 内完成
  await h.api.flush({ session_id })
  return session_id
}

/**
 * 索引全量快照（逐行一致比对用）。
 * 唯一豁免：`indexed_at` 类「索引时刻」列（`sessions.indexed_at`、`session_log_index.created_at`）
 * ——它们来自投影时的 `indexedAt` 参数，重建后必然是新时刻，不属于「从日志派生」的事实。
 */
type IndexRow = Record<string, unknown>

const VOLATILE_COLUMNS: Record<string, readonly string[]> = {
  sessions: ['indexed_at'],
  session_log_index: ['created_at'],
}

const SNAPSHOT_QUERIES: readonly (readonly [string, string])[] = [
  ['sessions', 'SELECT * FROM sessions WHERE session_id = ? ORDER BY session_id'],
  ['session_log_index', 'SELECT * FROM session_log_index WHERE session_id = ? ORDER BY seq, kind, byte_offset'],
  ['turns', 'SELECT * FROM turns WHERE session_id = ? ORDER BY turn'],
  ['steps', 'SELECT * FROM steps WHERE session_id = ? ORDER BY turn, step'],
  ['events', 'SELECT * FROM events WHERE session_id = ? ORDER BY seq'],
  ['messages_projection', 'SELECT * FROM messages_projection WHERE session_id = ? ORDER BY surface_index'],
  ['tool_calls', 'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY seq'],
  ['checkpoints', 'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY seq, kind'],
]

function snapshotSession(db: IndexDb, sessionId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [table, sql] of SNAPSHOT_QUERIES) {
    const rows = db.prepare(sql).all(sessionId) as IndexRow[]
    const volatileCols = VOLATILE_COLUMNS[table] ?? []
    out[table] = rows.map((row) => {
      const copy = { ...row }
      for (const col of volatileCols) delete copy[col]
      return copy
    })
  }
  // FTS 表：rowid 由触发器按 NEW.rowid 分配，每次重算都会重新分配——比对「可搜索集合」本身
  out['search_index'] = db
    .prepare('SELECT seq, role FROM search_index WHERE session_id = ? ORDER BY seq, role')
    .all(sessionId)
  return out
}

// ─────────── 用例 ───────────

describe('T5.1 · 无密钥回放闭环（llm-replay + agent-loop → JSONL → SQLite）', () => {
  it('工具循环：事件三层落齐（内存日志 = JSONL = 可查询的索引）', async () => {
    const h = await makeHarness([toolScript, textScript('完成：hi')])
    const sessionId = await runToolTurn(h)

    // ① JSONL（权威真相）：从文件读回的事件序列与内存完全一致（含工具循环，seq 连续）
    const meta = await h.api.meta({ session_id: sessionId })
    const loaded = loadLog(join(h.home, meta.header.log_path))
    expect(loaded.header.cwd).toBe('/repo/demo')
    expect(loaded.events.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'request/header',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'tool/call',
      'tool/result',
      'step/start',
      'request/header',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(loaded.events.map((e) => e.seq)).toEqual(loaded.events.map((_, i) => i))

    // ② SQLite：会话 / 轮步 / 工具调用行落齐
    const db = openIndexDb({ home: h.home })
    const sessionRow = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
    expect(sessionRow).toMatchObject({
      workspace: '/repo/demo',
      last_seq: 17,
      status: 'idle',
      model_provider: 'replay',
      model_name: 'replay-model',
      parent_session: null,
      seed_length: 0,
    })

    const turns = db.prepare('SELECT * FROM turns WHERE session_id = ?').all(sessionId)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ turn: 1, reason: 'completed', steps: 2, tool_calls: 1 })

    const steps = db.prepare('SELECT step, input_tokens, output_tokens FROM steps WHERE session_id = ? ORDER BY step').all(sessionId)
    expect(steps.map((s) => (s as { step: number }).step)).toEqual([1, 2])
    // 第二次请求的 usage 来自 replay 脚本的 done 帧（input 5 / output 7）
    expect(steps[1]).toMatchObject({ input_tokens: 5, output_tokens: 7 })

    const calls = db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'echo', status: 'done', turn: 1, step: 1, error_code: null })
    // 原始参数只在 JSONL；索引里是脱敏摘要（sha256 + 白名单字段）
    expect(String((calls[0] as { args_digest: string }).args_digest)).toContain('sha256:')

    // ③ 消息投影：表面顺序与角色（tool_use 那条没有可见文本，summary 为空）
    const msgs = db
      .prepare('SELECT seq, role, summary, is_active FROM messages_projection WHERE session_id = ? ORDER BY surface_index')
      .all(sessionId) as { seq: number; role: string; summary: string; is_active: number }[]
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(msgs.map((m) => m.summary)).toEqual(['把 hi 回显一遍', '', '{"echoed":"hi"}', '完成：hi'])
    expect(msgs.every((m) => m.is_active === 1)).toBe(true)

    // ④ FTS 中文搜索：命中即可用 (session_id, seq) 回表取原文
    const hits = searchMessages(db, '回显')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sessionId, seq: 1, role: 'user' })
    const hits2 = searchMessages(db, '完成')
    expect(hits2.map((hit) => hit.seq)).toEqual([15])
  })

  it('读路径与写路径同源：sessions.* 看到引擎写入的数据', async () => {
    const h = await makeHarness([toolScript, textScript('完成：hi')])
    const sessionId = await runToolTurn(h)

    // 引擎写入后，sessions.* 的读取路径拿到同一份数据（不是两份 store）
    const derived = await h.api.derive({ session_id: sessionId })
    expect(derived.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    const meta = await h.api.meta({ session_id: sessionId })
    expect(meta.last_seq).toBe(17)
    expect(meta.header.workspace).toBe('/repo/demo')

    const list = await h.api.list()
    expect(list.items.map((s) => s.session_id)).toContain(sessionId)
    expect(list.items[0]).toMatchObject({ status: 'idle', last_seq: 17 })
  })

  it('删库重建：索引逐行一致（豁免列：indexed_at 类「索引时刻」）', async () => {
    const h = await makeHarness([toolScript, textScript('完成：hi')])
    const sessionId = await runToolTurn(h)

    const db = openIndexDb({ home: h.home })
    const before = snapshotSession(db, sessionId)

    // 删库 → 全量重建（与实时写入共用 projectSession 纯函数，故一致是构造性的）
    await h.api.close()
    closeAllIndexDbs()
    const report = rebuildIndex({ home: h.home })
    expect(report).toMatchObject({ scanned: 1, rebuilt: 1, skipped: [] })

    const db2 = openIndexDb({ home: h.home })
    const after = snapshotSession(db2, sessionId)
    expect(after).toEqual(before)
  })

  it('sessionServiceFor：未打开的会话拒绝发包装（ES-SESSION_NOT_FOUND，防 seq 重排覆盖日志）', async () => {
    const h = await makeHarness([])
    let caught: unknown
    try {
      h.api.sessionServiceFor('UNOPENED')
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })
})

describe('T6.1 崩溃恢复穿过三层（JSONL 真相 → SQLite 索引）', () => {
  /**
   * 造一段"崩溃残留"：轮与步都开着，一个工具调用在派发前中断。
   * 直接经 `sessions.append` 写入（等价于引擎跑到一半被杀）。
   */
  async function seedCrashedLog(h: Harness): Promise<string> {
    const { session_id } = await h.api.create({ cwd: '/repo/web' })
    const events: [string, unknown][] = [
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
      ['user/message', { role: 'user', content: '读一下 auth.ts' }],
      [
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_x', name: 'read', input: { path: 'src/auth.ts' } }],
          },
        },
      ],
      ['tool/call', { turn: 1, step: 1, callId: 'call_x', name: 'read', arguments: '{"path":"src/auth.ts"}' }],
    ]
    for (const [type, data] of events) await h.api.append({ session_id, type, data: data as never })
    await h.api.flush({ session_id })
    return session_id
  }

  it('恢复补记同时落进 JSONL 与索引：消息历史合法，且可被检索到', async () => {
    const h = await makeHarness([])
    const sessionId = await seedCrashedLog(h)

    /*
     * **模拟进程重启**（崩溃恢复的真实前提）。
     * `resume()` 对已在内存里的会话是幂等的空操作——那是对的，会话开着说明进程活着。
     * 崩溃恢复的场景是"**新进程**打开一个磁盘上有未闭合结构的日志"，所以这里必须换实例。
     * 见 `sessions-api.ts` 的 `resume()` 注释（这个区别曾经让一个破坏性 bug 溜过去）。
     */
    h.restart()

    const result = await h.api.resume({ session_id: sessionId })
    expect(result.repaired).toBe(true)
    expect(result.closers?.map((c) => c.type)).toEqual([
      'tool/result',
      'step/end',
      'turn/end',
      'session/end-seed',
    ])

    // ① JSONL（权威真相）里有全部补记
    await h.api.flush({ session_id: sessionId })
    const file = join(h.home, (await h.api.meta({ session_id: sessionId })).header.log_path)
    const onDisk = loadLog(file).events.map((e) => e.type)
    expect(onDisk).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
      'session/end-seed',
    ])

    // ② 模型可见历史合法：被中断的调用有了配对的错误结果
    //    `tool/result` 派生出的是一条**消息级**的 ToolResultMessage（带 toolCallId / isError），
    //    不是 assistant 内容里的 tool_result 块。
    const messages = (await h.api.derive({ session_id: sessionId })).messages
    const toolResultMessage = messages.find(
      (m) => 'toolCallId' in m && m.toolCallId === 'call_x',
    )
    expect(toolResultMessage).toMatchObject({ toolCallId: 'call_x', isError: true })

    // ③ 索引（派生层）跟上了补记：轮闭合、补记的文本进了 FTS
    const db = openIndexDb({ home: h.home })
    const openTurns = db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND ended_at IS NULL')
      .get(sessionId) as { n: number }
    expect(openTurns.n).toBe(0)
    const hits = searchMessages(db, 'dispatch')
    expect(hits.some((hit) => hit.sessionId === sessionId)).toBe(true)
  })

  it('恢复幂等：连跑两次只补一次，JSONL 长度不变', async () => {
    const h = await makeHarness([])
    const sessionId = await seedCrashedLog(h)
    const file = join(h.home, (await h.api.meta({ session_id: sessionId })).header.log_path)

    await h.api.resume({ session_id: sessionId })
    await h.api.flush({ session_id: sessionId })
    const firstLength = loadLog(file).events.length

    const second = await h.api.resume({ session_id: sessionId })
    expect(second.closers).toBeUndefined()
    expect(second.repaired).toBe(false)
    await h.api.flush({ session_id: sessionId })
    expect(loadLog(file).events.length).toBe(firstLength)
  })

  it('恢复后仍可继续跑一轮（补出的 turn/end 让引擎能开新轮）', async () => {
    const h = await makeHarness([textScript('好的，继续')])
    const sessionId = await seedCrashedLog(h)
    await h.api.resume({ session_id: sessionId })
    await h.api.flush({ session_id: sessionId })

    const handle = await h.loop.create({ sessionId: asSessionId(sessionId), id: asAgentId('a1') })
    await handle.followup({ kind: 'text', text: '继续' })
    await h.api.flush({ session_id: sessionId })

    const file = join(h.home, (await h.api.meta({ session_id: sessionId })).header.log_path)
    const events = loadLog(file).events
    // 新一轮的 turn/start 出现，且 seq 连续（I2 没被补记破坏）
    expect(events.filter((e) => e.type === 'turn/start').length).toBe(2)
    events.forEach((event, index) => expect(event.seq).toBe(index))
  })
})
