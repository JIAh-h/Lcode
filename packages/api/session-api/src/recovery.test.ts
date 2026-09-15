import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllIndexDbs } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveFromDisk, eventTypesOf, lineCountOf, readLogFromDisk } from './recovery-test-helpers.ts'
import { LocalSessionsApi } from './sessions-api.ts'

/**
 * T6.1 验收（docs/24 §5 阶段 6）。
 *
 * 契约事实源是 [11 §6](../../../docs/11-数据模型与持久化设计.md) 与
 * [06 §9](../../../docs/06-会话事件日志与可重放设计.md)：
 * - 未闭合的**轮** / **步** / 未配对 `tool/call` 都补出收尾事件，顺序必须是
 *   `tool/result` → `step/end` → `turn/end`（11 §6.3「关键顺序」——闭合有层次）
 * - 补出的事件**写回日志**（持久化），不是内存假象（11 §6.1）
 * - 补记必须**可区分**（`ABORTED_BEFORE_DISPATCH`），不得伪装成真实发生（06 §9.4）
 * - 恢复**幂等**：对已恢复的日志再恢复，不再补出任何事件（11 §6.1 末）
 * - 轮已闭合时，上一世的孤儿 `tool/call` **不**被误判为本次欠账（11 §7.2）
 *
 * 断言一律落在**磁盘字节**上（`readLogFromDisk`），走 API 读路径会让
 * 「内存里有、盘上没有」这种失败漏掉。用真实的 `InMemorySessionStore`，不 mock——
 * seq 的分配与 I4/I5 校验必须在测试里真的跑一遍。
 */

const NOW = 1_000_000
let home = ''
let api: LocalSessionsApi

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-rec-'))
  api = new LocalSessionsApi({ home, now: () => NOW })
})

afterEach(async () => {
  await api.close()
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/repo/web'

async function createSession(): Promise<string> {
  const { session_id } = await api.create({ cwd: CWD })
  return session_id
}

/** 取会话日志的绝对路径（经索引里的 log_path，与生产读路径一致） */
async function logPathOf(session_id: string): Promise<string> {
  const meta = await api.meta({ session_id })
  return join(home, meta.header.log_path)
}

/**
 * **模拟一次进程重启**（崩溃恢复的真实前提）。
 *
 * 这一步不能省。`resume()` 对**已在内存里**的会话是幂等的空操作——那是刻意的：
 * 会话开着就说明进程活着、内存镜像不比磁盘旧，磁盘上"开着"的轮只是还没写完而已。
 * 真正的崩溃恢复场景是"**新进程**打开一个磁盘上有未闭合结构的日志"。
 *
 * 原来的测试直接在同一个实例上 `append` 完就 `resume`，用"已打开的会话"去触发恢复，
 * 于是**从来没有真正走过崩溃恢复那条路**——生产上"打开会话把正在跑的轮搞坏"那个
 * 破坏性 bug 就是这么漏过去的（详见 `resume()` 的注释）。
 */
async function restart(): Promise<void> {
  await api.close()
  closeAllIndexDbs()
  api = new LocalSessionsApi({ home, now: () => NOW })
}

/** 按序追加一批事件并落盘 */
async function writeEvents(session_id: string, events: readonly [string, unknown][]): Promise<void> {
  for (const [type, data] of events) await api.append({ session_id, type, data: data as never })
  await api.flush({ session_id })
}

/** 建一个"一轮已闭合"的会话 */
async function seedClosedTurn(): Promise<string> {
  const session_id = await createSession()
  await writeEvents(session_id, [
    ['turn/start', { turn: 1 }],
    ['user/message', { role: 'user', content: '把 parse.ts 换成结构化解析' }],
    ['step/start', { turn: 1, step: 1 }],
    ['assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '改完了' }] } }],
    ['step/end', { turn: 1, step: 1 }],
    ['turn/end', { turn: 1, reason: 'completed' }],
  ])
  return session_id
}

/** 崩溃残留：轮开着、步开着、一个工具调用在派发前中断 */
async function seedCrashedMidTool(): Promise<string> {
  const session_id = await createSession()
  await writeEvents(session_id, [
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
          content: [{ type: 'tool_use', id: 'call_a1', name: 'read', input: { path: 'src/auth.ts' } }],
        },
      },
    ],
    ['tool/call', { turn: 1, step: 1, callId: 'call_a1', name: 'read', arguments: '{"path":"src/auth.ts"}' }],
  ])
  return session_id
}

describe('T6.1 恢复：补出收尾事件的顺序与内容', () => {
  it('未配对的 tool/call → tool/result(ABORTED) → step/end → turn/end(aborted) → session/end-seed', async () => {
    const session_id = await seedCrashedMidTool()

    await restart()
    const result = await api.resume({ session_id })

    expect(result.repaired).toBe(true)
    expect(result.closers?.map((c) => c.type)).toEqual([
      'tool/result',
      'step/end',
      'turn/end',
      // 生命周期分界线（11 §7.2）：补记之后立刻标记"这一世从这开始"
      'session/end-seed',
    ])

    // ① 工具结果：错误码明示"未派发"，不能假装执行过（06 §9.2 的方案 C）
    expect(result.closers![0]).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'user', toolCallId: 'call_a1', isError: true },
        error: { code: 'ABORTED_BEFORE_DISPATCH' },
      },
    })
    // ② 步闭合
    expect(result.closers![1]).toMatchObject({ type: 'step/end', data: { turn: 1, step: 1 } })
    // ③ 轮闭合，reason 是 aborted（22 §6.2 的 TurnEndReason）
    expect(result.closers![2]).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: 'aborted' } })
  })

  it('补出的事件**写回磁盘**，seq 连续，且元数据标了 repaired', async () => {
    const session_id = await seedCrashedMidTool()

    await restart()
    await api.resume({ session_id })
    await api.flush({ session_id })
    const file = await logPathOf(session_id)

    const loaded = readLogFromDisk(file)
    expect(loaded.map((e) => e.type)).toEqual([
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
    // I2：seq 连续无空洞
    loaded.forEach((event, index) => expect(event.seq).toBe(index))

    // 06 §9.4：补记必须"可区分"，不能被当成真实发生的事件
    const repaired = loaded.find((e) => e.type === 'tool/result')
    expect(repaired).toMatchObject({
      data: { meta: { repaired: true }, error: { code: 'ABORTED_BEFORE_DISPATCH' } },
    })
  })

  it('补记的 time 紧贴崩溃时刻，不跳到恢复时刻', async () => {
    const session_id = await seedCrashedMidTool()
    const file = await logPathOf(session_id)

    // 把磁盘上的 time 整体压到很久以前（模拟"上周崩的、今天才恢复"）
    // 注意用同一个 api 实例：恢复读的是文件，不需要第二个实例。
    const rewound = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => line.replace(/"time":\d+/g, '"time":1000'))
      .join('\n') + '\n'
    writeFileSync(file, rewound)

    await restart()
    const result = await api.resume({ session_id })
    const times = (result.closers ?? []).map((c) => c.time)
    expect(times.length).toBeGreaterThan(0)
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!)
    // 补记贴着崩溃时刻（1000ms），而不是恢复时刻 NOW
    expect(Math.max(...times)).toBeLessThanOrEqual(1000 + 60_000)
  })
})

describe('T6.1 恢复：幂等与生命周期分界线', () => {
  it('对已恢复的日志再 resume：不补任何事件，磁盘零新增', async () => {
    const session_id = await seedCrashedMidTool()

    await restart()
    const first = await api.resume({ session_id })
    expect(first.repaired).toBe(true)
    expect(first.closers?.length).toBeGreaterThan(0)

    const file = await logPathOf(session_id)
    const bytesAfterFirst = lineCountOf(file)

    // 第二次恢复：所有结构都已闭合 → 无事可补
    await restart()
    const second = await api.resume({ session_id })
    expect(second.closers).toBeUndefined()
    expect(second.repaired).toBe(false)
    expect(lineCountOf(file)).toBe(bytesAfterFirst)
  })

  it('轮已闭合时，上一世的孤儿 tool/call 不算欠账（11 §7.2）', async () => {
    const session_id = await createSession()
    // 轮完整闭合，但留了一个没有配对的 tool/call（模拟上一世残骸）
    await writeEvents(session_id, [
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
      ['tool/call', { turn: 1, step: 1, callId: 'stale', name: 'read', arguments: '{}' }],
      ['step/end', { turn: 1, step: 1 }],
      ['turn/end', { turn: 1, reason: 'completed' }],
    ])

    await restart()
    const result = await api.resume({ session_id })
    expect(result.closers).toBeUndefined()
    expect(result.repaired).toBe(false)
  })

  it('已闭合的轮**后面**再开一个未闭合的轮：只补后面那个', async () => {
    const session_id = await seedClosedTurn()
    await writeEvents(session_id, [
      ['turn/start', { turn: 2 }],
      ['step/start', { turn: 2, step: 1 }],
    ])

    await restart()
    const result = await api.resume({ session_id })
    expect(result.closers?.map((c) => c.type)).toEqual(['step/end', 'turn/end', 'session/end-seed'])
    expect(result.closers![0]).toMatchObject({ data: { turn: 2, step: 1 } })
    expect(result.closers![1]).toMatchObject({ data: { turn: 2, reason: 'aborted' } })
  })

  it('内核**不补**插件的括号：compaction/start 即使在本世也不合成 compaction/end', async () => {
    const session_id = await seedClosedTurn()
    await writeEvents(session_id, [
      ['session/end-seed', {}],
      ['turn/start', { turn: 2 }],
      // 本世里活着的括号——按 11 §6.1 R3 表末行，内核不补，交给插件按分界线判定
      ['compaction/start', { compactionId: 'alive' }],
    ])

    await restart()
    const result = await api.resume({ session_id })
    expect(result.closers?.some((c) => c.type === 'compaction/end')).toBe(false)
    // 只补这一世的结构边界
    expect(result.closers?.map((c) => c.type)).toEqual(['turn/end', 'session/end-seed'])
  })
})

describe('T6.1 恢复：与撕裂尾的叠加', () => {
  it('撕裂尾被丢弃 → repaired = true，且补出被截断的那条闭合', async () => {
    const session_id = await seedClosedTurn()
    const file = await logPathOf(session_id)

    // 手工把最后一行截断（模拟进程被杀时"写了一半"）
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
    writeFileSync(file, lines.slice(0, lines.length - 1).join('\n') + '\n' + '{"type":"turn/end","seq":5,"time"')

    await restart()
    const result = await api.resume({ session_id })
    expect(result.repaired).toBe(true)
    // 被截断的是 turn/end → 第 1 轮变成未闭合 → 补 turn/end（+ 分界线）
    expect(result.closers?.map((c) => c.type)).toEqual(['turn/end', 'session/end-seed'])
    expect(eventTypesOf(file)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
      'session/end-seed',
    ])
  })
})

describe('T6.1 恢复：补记让模型可见历史仍然合法', () => {
  it('assistant 消息里的 tool_use 都有配对结果（否则下次请求被 400）', async () => {
    const session_id = await createSession()
    await writeEvents(session_id, [
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
      [
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'c1', name: 'read', input: {} },
              { type: 'tool_use', id: 'c2', name: 'glob', input: {} },
            ],
          },
        },
      ],
      // 只有第一个调用落了盘（真正的"派发前崩溃"）
      ['tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }],
    ])

    await restart()
    await api.resume({ session_id })
    await api.flush({ session_id })
    const loaded = readLogFromDisk(await logPathOf(session_id))

    const calls = loaded.filter((e) => e.type === 'tool/call').map((e) => e.data.callId)
    const results = loaded.filter((e) => e.type === 'tool/result').map((e) => e.data.message.toolCallId)
    expect(calls).toEqual(['c1'])
    expect(results).toEqual(['c1'])

    // 派生历史能跑通（补记没有制造非法结构）
    expect(deriveFromDisk(await logPathOf(session_id)).length).toBeGreaterThan(0)
  })
})
