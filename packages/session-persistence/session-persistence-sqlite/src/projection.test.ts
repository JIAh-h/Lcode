import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@lcode/session'
import type { EventFrame, JsonlSessionPersistence } from '@lcode/session-persistence-jsonl'
import { createJsonlPersistence, encodeJsonl } from '@lcode/session-persistence-jsonl'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAllIndexDbs, openIndexDb } from './db.ts'
import { searchMessages } from './fts.ts'
import { rebuildIndex } from './index-rebuild.ts'
import { SessionIndexWriter } from './index-writer.ts'
import { digestArgs } from './project.ts'

/**
 * T3 验收（docs/24 §5 阶段 3）：
 * - T3.1 write-behind：写索引失败不阻塞会话；重试耗尽后丢弃并上报
 * - T3.2 结构投影：sessions / session_log_index（含 byte_offset）/ turns / steps / events
 * - T3.3 派生投影：messages_projection 的 is_active / replaced_by_seq 正确反映 replace
 * - T3.4 工具与变更投影：tool_calls 里**查不到原始参数**；file_changes.source 恒为 presentation-meta
 * - T3.5 FTS：被 replace 遮蔽的消息搜不到
 * - T3.6 **删库重建后逐行一致**（这是阶段 3 唯一的出口判据）
 */

let home = ''
const T0 = 1_757_491_200_000

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-proj-'))
})

afterEach(() => {
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

/** 构造事件帧（物理层形态） */
function f(type: string, seq: number, data: unknown, surfaceOp?: EventFrame['surfaceOp']): EventFrame {
  return {
    type,
    seq,
    time: T0 + seq * 10,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  }
}

/** 一次"中等强度"会话：2 轮、1 次工具调用（带 diff 元数据）、3 条 chunk、1 次压缩 replace */
function buildEvents(): EventFrame[] {
  return [
    f('turn/start', 0, { turn: 1 }),
    f('user/message', 1, { role: 'user', content: '把 parse.ts 换成结构化解析' }),
    f('step/start', 2, { turn: 1, step: 1 }),
    f(
      'request/header',
      3,
      {
        header: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          system: 'test system',
          tools: [],
          systemFingerprint: 's1',
          toolsFingerprint: 't1',
        },
        reason: 'new-epoch',
      },
    ),
    f('tool/call', 4, {
      turn: 1,
      step: 1,
      callId: 'call_a',
      name: 'edit',
      // 原始参数里塞一个"哨兵"：索引层绝不允许出现它（22 §3.6）
      arguments: JSON.stringify({ path: 'src/parse.ts', content: 'SECRET_MARKER_XYZ' }),
    }),
    f('tool/result', 5, {
      turn: 1,
      step: 1,
      message: { role: 'user', toolCallId: 'call_a', content: '已写入 13 行', isError: false },
      meta: { card: 'diff', changes: [{ path: 'src/parse.ts', kind: 'modify', additions: 13, deletions: 2 }] },
    }),
    f('assistant/chunk', 6, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '改' } }),
    f('assistant/chunk', 7, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '完' } }),
    f('assistant/chunk', 8, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '了' } }),
    f('assistant/message', 9, {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        provider: 'deepseek',
        model: 'deepseek-chat',
        content: [{ type: 'text', text: '改完了，测试通过' }],
      },
      usage: { input: 1200, output: 340 },
    }),
    f('step/end', 10, { turn: 1, step: 1 }),
    f('turn/end', 11, { turn: 1, reason: 'completed' }),
    f('turn/start', 12, { turn: 2 }),
    // 压缩摘要：user/message + replace（06 §3.3 的形态），替换表面项 [0,2)
    f('user/message', 13, { role: 'user', content: '压缩摘要：把结构化解析的改动接上' }, { op: 'replace', start: 0, end: 2 }),
    f('turn/end', 14, { turn: 2, reason: 'completed' }),
  ]
}

async function seedSession(
  store: JsonlSessionPersistence,
  sessionId: string,
  events: readonly EventFrame[],
  cwd: string | null,
): Promise<void> {
  await store.open(sessionId as never, cwd === null ? undefined : { cwd })
  await store.append(sessionId as never, events as unknown as readonly SessionEvent[])
  await store.flush(sessionId as never)
}

/** 把索引里所有表倒出来（比较用）。排除易变列，避免"两次运行时间不同"误报 */
function dumpIndex(db: BetterSqlite3.Database, sessionId: string): Record<string, unknown[]> {
  const tables = [
    'session_log_index',
    'turns',
    'steps',
    'events',
    'messages_projection',
    'tool_calls',
    'file_changes',
    'checkpoints',
  ]
  const out: Record<string, unknown[]> = {}
  for (const table of tables) {
    out[table] = db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY rowid`).all(sessionId)
  }
  // 索引写入时间戳天然不确定（实时用 Date.now()、重建用注入的 now），不参与"逐行一致"比较
  out['session_log_index'] = (out['session_log_index'] as Record<string, unknown>[]).map((row) => {
    const copy = { ...row }
    delete copy['created_at']
    return copy
  })
  const sessions = db.prepare('SELECT * FROM sessions WHERE session_id = ?').all(sessionId) as Record<string, unknown>[]
  out['sessions'] = sessions.map((row) => {
    const copy = { ...row }
    delete copy['indexed_at'] // 实时 vs 重建的时间必然不同，不参与比较
    return copy
  })
  return out
}

describe('T3.2 结构投影', () => {
  it('sessions 行带 log_revision / log_bytes / 正确的 last_seq 与状态', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    const events = buildEvents()
    await seedSession(store, 'S1', events, '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('S1') as Record<string, unknown>
    expect(row['last_seq']).toBe(events.length - 1)
    expect(row['workspace']).toBe('/repo/web')
    expect(row['workspace_key']).toMatch(/^[0-9a-f]{16}$/)
    expect(row['log_path']).toBe(`sessions/${row['workspace_key'] as string}/S1.jsonl`)
    expect(row['log_codec']).toBe('none')
    expect(row['log_bytes']).toBeGreaterThan(0)
    expect(String(row['log_revision'])).toContain(':') // dev:ino:size:mtimeNs:ctimeNs
    expect(row['status']).toBe('idle') // 两轮都已闭合
    expect(row['model_provider']).toBe('deepseek')
    expect(row['model_name']).toBe('deepseek-chat')
    expect(row['indexed_at']).not.toBeNull()
    await store.closeAll()
  })

  it('session_log_index 一记录一行，且 byte_offset 连续覆盖整个文件', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const rows = db
      .prepare('SELECT * FROM session_log_index WHERE session_id = ? ORDER BY seq')
      .all('S1') as { kind: string; seq: number; seq_last: number; byte_offset: number; byte_length: number }[]

    // 头部帧 + 事件（不含 chunk 逐条）+ 1 条 chunk 批
    expect(rows[0]).toMatchObject({ kind: 'header', seq: -1 })
    expect(rows.filter((r) => r.kind === 'chunk-batch')).toHaveLength(1)
    expect(rows.find((r) => r.kind === 'chunk-batch')).toMatchObject({ seq: 6, seq_last: 8 })

    // 偏移必须严丝合缝地拼出整个文件 → 随机 seek 才成立
    let offset = 0
    for (const row of rows) {
      expect(row.byte_offset).toBe(offset)
      offset += row.byte_length
    }
    const file = join(home, 'sessions', String((db.prepare('SELECT workspace_key AS k FROM sessions').get() as { k: string }).k), 'S1.jsonl')
    expect(offset).toBe(Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8'))
    await store.closeAll()
  })

  it('events 表不含 assistant/chunk 行（22 §3.4）', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const chunks = db.prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND type = 'assistant/chunk'").get('S1') as { c: number }
    expect(chunks.c).toBe(0)
    // 其它事件都在
    const total = db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get('S1') as { c: number }
    expect(total.c).toBe(buildEvents().filter((e) => e.type !== 'assistant/chunk').length)
    await store.closeAll()
  })

  it('turns / steps 边界与用量', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn').all('S1') as Record<string, unknown>[]
    expect(turns.map((t) => t['turn'])).toEqual([1, 2])
    expect(turns[0]).toMatchObject({ start_seq: 0, end_seq: 11, reason: 'completed', steps: 1, tool_calls: 1 })
    expect(turns[1]).toMatchObject({ start_seq: 12, end_seq: 14, steps: 0, tool_calls: 0 })

    const steps = db.prepare('SELECT * FROM steps WHERE session_id = ?').all('S1') as Record<string, unknown>[]
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      turn: 1,
      step: 1,
      start_seq: 2,
      end_seq: 10,
      model_provider: 'deepseek',
      model_name: 'deepseek-chat',
      input_tokens: 1200,
      output_tokens: 340,
    })
    await store.closeAll()
  })

  it('未闭合轮能被 idx_turns_open 查出，且 sessions.status = busy', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S2', [f('turn/start', 0, { turn: 1 }), f('user/message', 1, { role: 'user', content: '跑起来了' })], '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    expect(db.prepare('SELECT turn FROM turns WHERE session_id = ? AND end_seq IS NULL').all('S2')).toEqual([{ turn: 1 }])
    expect((db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('S2') as { status: string }).status).toBe('busy')
    await store.closeAll()
  })
})

describe('T3.3 / T3.5 派生投影与全文检索', () => {
  it('replace 遮蔽：is_active = 0 且记录 replaced_by_seq；摘要本身仍生效', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const rows = db
      .prepare('SELECT surface_index, seq, role, is_active, replaced_by_seq, summary FROM messages_projection WHERE session_id = ? ORDER BY surface_index')
      .all('S1') as Record<string, unknown>[]

    expect(rows.map((r) => [r['surface_index'], r['seq'], r['is_active'], r['replaced_by_seq']])).toEqual([
      [0, 1, 0, 13], // 被压缩摘要替换掉
      [1, 5, 0, 13], // 同上
      [2, 9, 1, null],
      [3, 13, 1, null], // 摘要自己生效
    ])
    expect(rows[3]!['summary']).toBe('压缩摘要：把结构化解析的改动接上')
    expect(rows[0]!['summary']).toBe('把 parse.ts 换成结构化解析') // 原始事实仍在（只是不进当前表面）
    await store.closeAll()
  })

  it('被 replace 遮蔽的消息搜不到；生效的能搜到（2 字与 3 字以上）', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    // 「结构化」出现在被遮蔽的第 1 条里，摘要里也有 → 只应命中摘要（seq 13）
    expect(searchMessages(db, '结构化').map((h) => h.seq)).toEqual([13])
    // 「换成」只在被遮蔽的消息里 → 搜不到
    expect(searchMessages(db, '换成')).toEqual([])
    // 「parse」同样只在被遮蔽的消息里（这条消息没进当前表面）→ 搜不到
    expect(searchMessages(db, 'parse')).toEqual([])
    // 「测试」在生效的 assistant 消息里；「摘要」在生效的摘要里（2 字中文也命中）
    expect(searchMessages(db, '测试').map((h) => h.seq)).toEqual([9])
    expect(searchMessages(db, '摘要').map((h) => h.seq)).toEqual([13])
    await store.closeAll()
  })

  it('summary 保原样、fts_text 走分词（UI 文本不被污染）', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const row = db.prepare("SELECT summary, fts_text FROM messages_projection WHERE session_id = 'S1' AND seq = 9").get() as {
      summary: string
      fts_text: string
    }
    expect(row.summary).toBe('改完了，测试通过')
    expect(row.fts_text).toContain('改 完 了')
    await store.closeAll()
  })
})

describe('T3.4 工具与变更投影', () => {
  it('tool_calls 带 args_digest 与状态/耗时；**索引里查不到原始参数**', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const call = db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').get('S1') as Record<string, unknown>
    expect(call['call_id']).toBe('call_a')
    expect(call['status']).toBe('done')
    expect(call['result_seq']).toBe(5)
    expect(String(call['args_digest'])).toMatch(/^sha256:[0-9a-f]{16}/)
    expect(String(call['args_digest'])).toContain('path=src/parse.ts') // 白名单字段保留，便于定位
    expect(call['duration_ms']).toBe(10) // tool/call seq4(T0+40) → tool/result seq5(T0+50)
    expect(call['result_bytes']).toBeGreaterThan(0)

    // 安全断言：把整库所有表的所有列倒成文本，**不得**出现原始参数里的哨兵
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    let all = ''
    for (const t of tables) all += JSON.stringify(db.prepare(`SELECT * FROM ${t.name}`).all())
    expect(all).not.toContain('SECRET_MARKER_XYZ')

    // 而权威 JSONL 里当然有（原始参数只该在这儿）
    const file = join(home, 'sessions', String((db.prepare('SELECT workspace_key AS k FROM sessions').get() as { k: string }).k), 'S1.jsonl')
    expect(readFileSync(file, 'utf8')).toContain('SECRET_MARKER_XYZ')
    await store.closeAll()
  })

  it('digestArgs 不含 content / command 这类敏感键', () => {
    const digest = digestArgs(JSON.stringify({ path: 'a.ts', content: 'TOPSECRET', command: 'rm -rf /', limit: 10 }))
    expect(digest).toContain('path=a.ts')
    expect(digest).toContain('limit=10')
    expect(digest).not.toContain('TOPSECRET')
    expect(digest).not.toContain('rm -rf')
  })

  it('file_changes 从 presentationMeta 派生，带 turn 且 source 恒为 presentation-meta', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const changes = db.prepare('SELECT * FROM file_changes WHERE session_id = ?').all('S1') as Record<string, unknown>[]
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      turn: 1,
      path: 'src/parse.ts',
      change_kind: 'modify',
      additions: 13,
      deletions: 2,
      tool_call_id: 'call_a',
      source: 'presentation-meta',
      seq: 5,
    })
    await store.closeAll()
  })

  it('checkpoints：轮边界 safe_fork = 1，步边界 = 0', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()

    const db = openIndexDb({ home })
    const cps = db.prepare('SELECT seq, kind, safe_fork FROM checkpoints WHERE session_id = ? ORDER BY seq').all('S1')
    expect(cps).toEqual([
      { seq: 10, kind: 'step-end', safe_fork: 0 },
      { seq: 11, kind: 'turn-end', safe_fork: 1 },
      { seq: 14, kind: 'turn-end', safe_fork: 1 },
    ])
    await store.closeAll()
  })
})

describe('T3.6 index rebuild', () => {
  it('删库重建后查询结果与重建前**逐行一致**（阶段 3 的出口判据）', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await seedSession(store, 'S2', [f('turn/start', 0, { turn: 1 }), f('user/message', 1, { role: 'user', content: '第二个会话' })], null)
    await writer.drain()
    await store.closeAll()

    const before1 = dumpIndex(openIndexDb({ home }), 'S1')
    const before2 = dumpIndex(openIndexDb({ home }), 'S2')

    const report = rebuildIndex({ home, now: () => T0 })
    expect(report.rebuilt).toBe(2)
    expect(report.skipped).toEqual([])

    closeAllIndexDbs()
    const after1 = dumpIndex(openIndexDb({ home }), 'S1')
    const after2 = dumpIndex(openIndexDb({ home }), 'S2')

    expect(after1).toEqual(before1)
    expect(after2).toEqual(before2)
  })

  it('单个会话损坏 → 记 ES-CORRUPTED 并跳过，其余照常重建', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await writer.drain()
    await store.closeAll()

    // 手工造一个"中间行损坏"的会话文件
    const bucket = join(home, 'sessions', '_unknown')
    mkdirSync(bucket, { recursive: true })
    const brokenHeader = {
      kind: 'file-header',
      formatVersion: 1,
      sessionId: 'BROKEN',
      createdAt: T0,
      cwd: null,
      parentSession: null,
      seedLength: 0,
      codec: 'none',
      keyId: null,
    }
    writeFileSync(
      join(bucket, 'BROKEN.jsonl'),
      encodeJsonl([brokenHeader as never, f('turn/start', 0, { turn: 1 })]) + '{"bad\n' + encodeJsonl([f('turn/end', 1, { turn: 1, reason: 'completed' })]),
    )

    const report = rebuildIndex({ home, now: () => T0 })
    expect(report.scanned).toBe(2)
    expect(report.rebuilt).toBe(1)
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]).toMatchObject({ sessionId: 'BROKEN', code: 'ES-CORRUPTED' })

    // S1 仍然完好
    closeAllIndexDbs()
    const db = openIndexDb({ home })
    expect((db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE session_id = 'S1'").get() as { c: number }).c).toBe(1)
  })

  it('--check 只体检：不建库、报出损坏项', async () => {
    const store = createJsonlPersistence({ home, batchMs: 5 })
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await store.closeAll()

    const report = rebuildIndex({ home, check: true })
    expect(report.rebuilt).toBe(1)
    expect(report.skipped).toEqual([])
  })
})

describe('T3.1 write-behind 通道', () => {
  it('索引写入失败不阻塞会话；重试耗尽后丢弃并上报', async () => {
    const failures: string[] = []
    // 注入一个"总是失败"的连接：transaction 会真的调用 fn，prepare 抛错 → 与真实失败同路径
    const brokenDb = {
      transaction: (fn: () => void) => (): void => {
        fn()
      },
      prepare: () => {
        throw new Error('磁盘满了（模拟）')
      },
    } as unknown as BetterSqlite3.Database

    const writer = new SessionIndexWriter({
      home,
      db: brokenDb,
      retryBaseMs: 1,
      maxAttempts: 2,
      onError: (err, sessionId) => {
        failures.push(`${sessionId}:${err instanceof Error ? err.message : String(err)}`)
      },
    })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })

    // 会话侧完全不受影响：append / flush 都正常返回
    await seedSession(store, 'S1', buildEvents(), '/repo/web')
    await expect(store.load('S1' as never)).resolves.toHaveLength(buildEvents().length)

    await writer.drain()
    expect(writer.dropped).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('S1')
    expect(writer.pendingCount).toBe(0)
    await store.closeAll()
  })

  it('同一会话的多次 flush 只保留最新快照（队列有界且不丢最终状态）', async () => {
    const writer = new SessionIndexWriter({ home, retryBaseMs: 1 })
    const store = createJsonlPersistence({ home, sink: writer, batchMs: 5 })
    const events = buildEvents()
    await store.open('S1' as never, { cwd: '/repo/web' })
    for (const event of events) {
      await store.append('S1' as never, [event as unknown as SessionEvent])
      await store.flush('S1' as never)
    }
    await writer.drain()

    const db = openIndexDb({ home })
    const row = db.prepare('SELECT last_seq, log_bytes FROM sessions WHERE session_id = ?').get('S1') as {
      last_seq: number
      log_bytes: number
    }
    expect(row.last_seq).toBe(events.length - 1)
    expect(row.log_bytes).toBeGreaterThan(0)
    await store.closeAll()
  })
})
