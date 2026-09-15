import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@lcode/session'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSessionsApi } from './sessions-api.ts'

/**
 * T4.1 验收（docs/24 §5 阶段 4）：
 * - 9 个方法逐个有单测
 * - `sessions.fork` 在未闭合轮边界报 `ES-FORK_BOUNDARY_INVALID`
 * - `sessions.resume` 幂等且带 `repaired`
 * - `sessions.export` 产出 sha256 / bytes，且 jsonl 可再读
 */

let home = ''
let api: LocalSessionsApi

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-api-'))
  api = new LocalSessionsApi({ home })
})

afterEach(async () => {
  await api.close()
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/repo/web'

function logPathFrom(meta: { log_path: string }): string {
  return join(home, meta.log_path)
}

/** 建一个"一轮已闭合"的会话，返回 session_id */
async function seedClosedTurn(title = '测试'): Promise<string> {
  const { session_id } = await api.create({ cwd: CWD, title })
  await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
  await api.append({ session_id, type: 'user/message', data: { role: 'user', content: '把 parse.ts 换成结构化解析' } })
  await api.append({
    session_id,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '改完了，测试通过' }] } },
  })
  await api.append({ session_id, type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  await api.flush({ session_id })
  return session_id
}

describe('sessions.create / list / meta', () => {
  it('create 返回新会话与 last_seq = -1，并出现在 list 里', async () => {
    const created = await api.create({ cwd: CWD })
    expect(created.session_id).toMatch(/^[A-Z0-9]{26}$/)
    expect(created.last_seq).toBe(-1)

    const list = await api.list()
    expect(list.items.map((s) => s.session_id)).toEqual([created.session_id])
    expect(list.items[0]).toMatchObject({ workspace: CWD, status: 'idle', last_seq: -1, parent_session: null })
  })

  it('meta 给出 header 与 log_revision', async () => {
    const sessionId = await seedClosedTurn()
    const meta = await api.meta({ session_id: sessionId })
    expect(meta.last_seq).toBe(3)
    expect(meta.header).toMatchObject({ session_id: sessionId, workspace: CWD, status: 'idle', seed_length: 0 })
    expect(meta.log_revision).not.toBe('')
    expect(meta.header.log_path).toBe(`sessions/${meta.header.workspace_key}/${sessionId}.jsonl`)
  })

  it('list 按 workspace 过滤，且支持 cursor 分页', async () => {
    const a = await api.create({ cwd: CWD })
    const b = await api.create({ cwd: '/repo/api' })
    const other = await api.create({ cwd: CWD })

    const filtered = await api.list({ workspace: CWD })
    expect(filtered.items.map((s) => s.session_id).sort()).toEqual([a.session_id, other.session_id].sort())

    const page1 = await api.list({ limit: 1 })
    expect(page1.items).toHaveLength(1)
    expect(page1.nextCursor).toBeDefined()
    const page2 = await api.list({ limit: 1, cursor: page1.nextCursor })
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]!.session_id).not.toBe(page1.items[0]!.session_id)
    // 三页取完（3 个会话）
    const page3 = await api.list({ limit: 1, cursor: page2.nextCursor })
    expect(page3.items).toHaveLength(1)
    expect(page3.nextCursor).toBeUndefined()
    expect(b.session_id).toBeTruthy()
  })

  it('cwd 非绝对路径 → EC-INVALID_PARAMS', async () => {
    await expect(api.create({ cwd: 'relative/dir' })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(api.create({ cwd: '' })).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
  })
})

describe('sessions.append / derive / flush', () => {
  it('append 返回带 seq 的事件，derive 得到模型可见消息', async () => {
    const sessionId = await seedClosedTurn()
    const derived = await api.derive({ session_id: sessionId })
    expect(derived.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(await api.meta({ session_id: sessionId })).toMatchObject({ last_seq: 3 })
  })

  it('derive 支持 up_to（只派生到某 seq 之前）', async () => {
    const sessionId = await seedClosedTurn()
    expect((await api.derive({ session_id: sessionId, up_to: 2 })).messages.map((m) => m.role)).toEqual(['user'])
  })

  it('append 的 seq 由内核分配、连续递增', async () => {
    const { session_id } = await api.create({ cwd: CWD })
    const e0 = await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    const e1 = await api.append({ session_id, type: 'user/message', data: { role: 'user', content: 'hi' } })
    expect([e0.seq, e1.seq]).toEqual([0, 1])
  })

  it('I4：surface 区间越界 → EC-INVALID_PARAMS（不新增错误码）', async () => {
    const { session_id } = await api.create({ cwd: CWD })
    await api.append({ session_id, type: 'user/message', data: { role: 'user', content: 'hi' } })
    await expect(
      api.append({
        session_id,
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
        surface_op: { op: 'replace', start: 5, end: 6 },
      }),
    ).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
  })

  it('I5：NaN 载荷 → EC-EVENT_NOT_JSON（来自 store，未被本层改写）', async () => {
    const { session_id } = await api.create({ cwd: CWD })
    await expect(
      api.append({ session_id, type: 'user/message', data: { role: 'user', content: Number.NaN } }),
    ).rejects.toMatchObject({ code: 'EC-EVENT_NOT_JSON' })
  })

  it('flush 是持久屏障：冲洗后文件里能读到全部事件', async () => {
    const sessionId = await seedClosedTurn()
    const meta = await api.meta({ session_id: sessionId })
    const lines = readFileSync(logPathFrom(meta.header), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(5) // 头部帧 + 4 条事件
    expect(meta.header.log_codec).toBe('none')
  })

  it('未知会话 → ES-SESSION_NOT_FOUND（append / derive / meta / flush 一致）', async () => {
    for (const run of [
      () => api.append({ session_id: 'NOPE', type: 'turn/start', data: { turn: 1 } }),
      () => api.derive({ session_id: 'NOPE' }),
      () => api.meta({ session_id: 'NOPE' }),
      () => api.flush({ session_id: 'NOPE' }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
    }
  })
})

describe('sessions.resume', () => {
  it('重启后 resume 能接上原 seq 继续追加（幂等）', async () => {
    const sessionId = await seedClosedTurn()
    await api.close()

    const fresh = new LocalSessionsApi({ home })
    try {
      const resumed = await fresh.resume({ session_id: sessionId })
      expect(resumed).toMatchObject({ session_id: sessionId, last_seq: 3, repaired: false })
      // 再 resume 一次（幂等）
      expect((await fresh.resume({ session_id: sessionId })).last_seq).toBe(3)
      // seq 接着走
      const next = await fresh.append({ session_id: sessionId, type: 'turn/start', data: { turn: 2 } })
      expect(next.seq).toBe(4)
      await fresh.flush({ session_id: sessionId })
      expect((await fresh.derive({ session_id: sessionId })).messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
      ])
    } finally {
      await fresh.close()
      closeAllIndexDbs()
      api = new LocalSessionsApi({ home }) // 供 afterEach 关闭
    }
  })

  it('撕裂尾被丢弃 → repaired = true，且已有事件完好', async () => {
    const sessionId = await seedClosedTurn()
    const meta = await api.meta({ session_id: sessionId })
    await api.close()
    // 手工制造撕裂尾（模拟断电）
    appendFileSync(logPathFrom(meta.header), '{"type":"turn/end","seq":4,"ti')

    const fresh = new LocalSessionsApi({ home })
    try {
      const resumed = await fresh.resume({ session_id: sessionId })
      expect(resumed).toMatchObject({ last_seq: 3, repaired: true })
    } finally {
      await fresh.close()
      closeAllIndexDbs()
      api = new LocalSessionsApi({ home })
    }
  })

  it('**会话已打开时 resume 不得重建内存 store**（否则与正在跑的轮各编各的号）', async () => {
    /*
     * 这一条盯的是一个会**破坏 I2** 的破坏性行为，而且 UI 的正常流程必然踩中：
     *
     * ```
     * 首页发送 → 引擎拿到 store A 开跑（磁盘上还只有 turn/start…）
     *          → 跳转工作台 → session.open → resume
     *          → 读到"turn 开着"的旧快照 → 合成 turn/end(aborted) + end-seed
     *          → forget() 删 store A、adopt() 建 store B
     *          → 模型分片这时才回来，引擎**仍往已孤立的 store A 写**
     * ```
     *
     * 结果：B 与 A 各自从 0 编号 → 日志出现**重复 seq**，一个正常结束的轮被记成
     * `aborted`，界面上第二轮永远渲染不出来。
     *
     * 断言方式：先拿住 store（模拟引擎持有的那份），resume 之后再往它写，
     * 必须与 `sessionServiceFor` 取到的是**同一个** store，且 seq 连续。
     */
    const { session_id } = await api.create({ cwd: CWD, title: '打开中' })
    await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    await api.append({ session_id, type: 'user/message', data: { role: 'user', content: '你好' } })

    // 引擎持有的那份（在 resume 之前拿到）
    const before = api.sessionServiceFor(session_id)

    const resumed = await api.resume({ session_id })
    // 已打开 → 不做恢复，也不该报告"修过什么"
    expect(resumed).toMatchObject({ session_id, last_seq: 1, repaired: false })

    /*
     * 关键断言：**resume 之后，引擎手里那份（`before`）仍然写到同一个地方。**
     *
     * 不能比对象身份——`sessionServiceFor` 每次返回新的 wrapper（包着同一个 store），
     * 所以要比的是**行为**：往 `before` 写，`after` 必须看得见。
     */
    before.append({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } },
    })
    before.append({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    await api.flush({ session_id })

    const events = api.sessionServiceFor(session_id).events()
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    // 没有被合成出 `aborted`（那是"以为会话开着"才会有的东西）
    expect(events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)).toEqual(['completed'])
    expect(events.some((e) => e.type === 'session/end-seed')).toBe(false)
  })

  it('未知会话 resume → ES-SESSION_NOT_FOUND', async () => {
    await expect(api.resume({ session_id: 'NOPE' })).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })

  it('追了但还没 flush 就 resume：看到的是最新状态（不是过期快照）', async () => {
    /*
     * write-behind 是批量的（06 §5.3：热路径不 await 磁盘），所以"刚说完一轮、
     * 事件还在缓冲区"是常态。`resume()` 不能让调用方以为"只有磁盘上那些"。
     *
     * 注意：一条**完整闭合**的轮不会被恢复逻辑改写（没有未闭合结构），
     * 所以这里断言的是"resume 报的 last_seq 是最新的、续写 seq 连续"。
     */
    const { session_id } = await api.create({ cwd: CWD, title: '未 flush' })
    await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    await api.append({ session_id, type: 'user/message', data: { role: 'user', content: '你好' } })
    await api.append({
      session_id,
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } },
    })
    await api.append({ session_id, type: 'turn/end', data: { turn: 1, reason: 'completed' } })

    // 此刻事件仍在 write-behind 缓冲区里（没有 flush）——立刻 resume
    const resumed = await api.resume({ session_id })
    expect(resumed).toMatchObject({ last_seq: 3, repaired: false })

    // 续写接着走，而不是从"过期快照的长度"重新开始
    const next = await api.append({ session_id, type: 'turn/start', data: { turn: 2 } })
    expect(next.seq).toBe(4)
    await api.flush({ session_id })
  })
})

describe('sessions.fork', () => {
  it('在已闭合的轮边界分叉：子会话带 parent_session 与 seed_length', async () => {
    const source = await seedClosedTurn()
    const forked = await api.fork({ source_session_id: source, boundary: 4 })
    expect(forked.last_seq).toBe(4) // 种子 0..3 + session/end-seed

    const meta = await api.meta({ session_id: forked.session_id })
    expect(meta.header.parent_session).toBe(source)
    expect(meta.header.seed_length).toBe(4)
    expect(meta.header.workspace).toBe(CWD)

    // 日志 = 4 条种子 + 1 条生命周期分界线
    const events = readFileSync(logPathFrom(meta.header), 'utf8').split('\n').filter(Boolean).slice(1)
    expect(events).toHaveLength(5)
    expect((JSON.parse(events[4]!) as SessionEvent).type).toBe('session/end-seed')

    // 原会话不受影响
    expect((await api.meta({ session_id: source })).last_seq).toBe(3)
  })

  it('切点落在未闭合轮内 → ES-FORK_BOUNDARY_INVALID', async () => {
    const { session_id } = await api.create({ cwd: CWD })
    await api.append({ session_id, type: 'turn/start', data: { turn: 1 } })
    await api.append({ session_id, type: 'user/message', data: { role: 'user', content: 'hi' } })
    // boundary = 2 → 前缀是 [turn/start, user/message]，轮没闭合
    await expect(api.fork({ source_session_id: session_id, boundary: 2 })).rejects.toMatchObject({
      code: 'ES-FORK_BOUNDARY_INVALID',
    })
    // 边界 0 是安全的（空前缀）
    await expect(api.fork({ source_session_id: session_id, boundary: 0 })).resolves.toMatchObject({ last_seq: 0 })
  })

  it('切点越界 / 源会话不存在', async () => {
    const sessionId = await seedClosedTurn()
    await expect(api.fork({ source_session_id: sessionId, boundary: 99 })).rejects.toMatchObject({
      code: 'ES-FORK_BOUNDARY_INVALID',
    })
    await expect(api.fork({ source_session_id: 'NOPE', boundary: 0 })).rejects.toMatchObject({
      code: 'ES-SESSION_NOT_FOUND',
    })
  })

  it('child_id 已存在 → EC-INVALID_PARAMS', async () => {
    const source = await seedClosedTurn()
    const first = await api.fork({ source_session_id: source, boundary: 4, child_id: 'CHILD_FIXED' })
    expect(first.session_id).toBe('CHILD_FIXED')
    await expect(api.fork({ source_session_id: source, boundary: 4, child_id: 'CHILD_FIXED' })).rejects.toMatchObject({
      code: 'EC-INVALID_PARAMS',
    })
  })
})

describe('sessions.export', () => {
  it('jsonl：字节级副本 + sha256 + 可再读', async () => {
    const sessionId = await seedClosedTurn()
    const result = await api.export({ session_id: sessionId, format: 'jsonl' })
    const source = await api.meta({ session_id: sessionId })
    const original = readFileSync(logPathFrom(source.header))
    const exported = readFileSync(result.path)

    expect(result.bytes).toBe(original.length)
    expect(exported.equals(original)).toBe(true)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.path.endsWith('.jsonl')).toBe(true)
  })

  it('md：含对话正文', async () => {
    const sessionId = await seedClosedTurn()
    const result = await api.export({ session_id: sessionId, format: 'md' })
    const text = readFileSync(result.path, 'utf8')
    expect(text).toContain(`# 会话 ${sessionId}`)
    expect(text).toContain('把 parse.ts 换成结构化解析')
    expect(text).toContain('改完了，测试通过')
    expect(result.bytes).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('未知会话 → ES-SESSION_NOT_FOUND', async () => {
    await expect(api.export({ session_id: 'NOPE', format: 'jsonl' })).rejects.toMatchObject({
      code: 'ES-SESSION_NOT_FOUND',
    })
  })
})

describe('索引侧跟得上（派生层，不阻塞会话）', () => {
  it('meta 在索引缺行时按日志补投影，而不是报找不到', async () => {
    const sessionId = await seedClosedTurn()
    // 把索引库整个删掉（模拟"索引可丢"），再问 meta
    const { dropIndexDb } = await import('@lcode/session-persistence-sqlite')
    await api.close()
    dropIndexDb(home)
    closeAllIndexDbs()

    const fresh = new LocalSessionsApi({ home })
    try {
      const meta = await fresh.meta({ session_id: sessionId })
      expect(meta.last_seq).toBe(3)
      expect(meta.log_revision).not.toBe('')
    } finally {
      await fresh.close()
      closeAllIndexDbs()
      api = new LocalSessionsApi({ home })
    }
  })

  it('reindex 能从日志恢复出索引（会话仍在 list 里）', async () => {
    const sessionId = await seedClosedTurn()
    await api.close()
    closeAllIndexDbs()

    const fresh = new LocalSessionsApi({ home })
    try {
      const report = fresh.reindex()
      expect(report.rebuilt).toBe(1)
      const list = await fresh.list()
      expect(list.items.map((s) => s.session_id)).toContain(sessionId)
    } finally {
      await fresh.close()
      closeAllIndexDbs()
      api = new LocalSessionsApi({ home })
    }
  })
})
