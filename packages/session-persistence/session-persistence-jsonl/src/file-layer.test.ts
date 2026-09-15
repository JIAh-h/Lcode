import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@lcode/session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LcodeErrorImpl, normalizePath, workspaceBucket } from '@lcode/util'
import { appendFileSyncDurable, writeFileAtomicSync } from './atomic.ts'
import type { EventFrame, FileHeaderFrame, LogFrame } from './jsonl.ts'
import { encodeJsonl, packFrames, unpackFrames } from './jsonl.ts'
import { loadLog, loadLogWithSpans, parseLogText } from './loader.ts'
import { computeRevision } from './revision.ts'
import { JsonlSessionPersistence, findSessionFile, listSessionFiles } from './session-store.ts'
import type { SessionLogSnapshot } from './sink.ts'
import { scanSpans } from './spans.ts'
import { SessionWriteBehind } from './write-behind.ts'

/**
 * T2 验收（docs/24 §5 阶段 2）与 T2.6 不变量：
 * - T2.1 有界批写：append 同步返回不 await 磁盘；flush 是持久屏障
 * - T2.2 load 与损坏判定：撕裂尾丢弃、中间行报 ES-CORRUPTED、未知版本报 ES-FORMAT_UNSUPPORTED
 * - T2.3 原子物化：不留临时文件、可覆盖已有目标
 * - T2.4 revision：内容不变则不变，追加即变
 * - T2.5 分桶：workspace-key 分目录，无 cwd 落 _unknown，可按 sessionId 反查
 * - T2.6 不变量 I1 / I2 / I5（含负例）
 */

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-jsonl-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 测试用事件构造：`seq` 由测试显式指定，time 用 seq 派生以便断言 */
function ev(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 1_757_491_200_000 + seq, data } as unknown as SessionEvent
}

const HEADER: FileHeaderFrame = {
  kind: 'file-header',
  formatVersion: 1,
  sessionId: 'S1',
  createdAt: 1_757_491_200_000,
  cwd: '/repo/web',
  parentSession: null,
  seedLength: 0,
  codec: 'none',
  keyId: null,
}

describe('T2.1 有界批写', () => {
  it('append() 同步返回、不 await 磁盘；flush() 之后才可见', async () => {
    const file = join(home, 's.jsonl')
    const wb = new SessionWriteBehind({ file, header: HEADER, batchMs: 60_000 })
    wb.open()
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1) // 只有头部帧

    wb.append([{ type: 'turn/start', seq: 0, time: HEADER.createdAt, data: { turn: 1 } } satisfies EventFrame])
    // 批写窗口远未到期：此刻磁盘上仍只有头部帧
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)

    await wb.flush()
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!) as EventFrame).toMatchObject({ type: 'turn/start', seq: 0 })
    await wb.close()
  })

  it('flush() 后另一读者能读到全部事件（持久屏障语义）', async () => {
    const file = join(home, 's.jsonl')
    const wb = new SessionWriteBehind({ file, header: HEADER, batchMs: 60_000 })
    wb.open()
    wb.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ])
    await wb.flush()
    await wb.close()
    // 独立读者：重新解析文件
    const loaded = loadLog(file)
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1])
    expect(loaded.events.map((e) => e.type)).toEqual(['turn/start', 'step/start'])
  })

  it('超过水位立即落盘（队列有界，不吃光内存）', async () => {
    const file = join(home, 's.jsonl')
    const wb = new SessionWriteBehind({ file, header: HEADER, batchMs: 60_000, maxPendingBytes: 10 })
    wb.open()
    wb.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2) // 立即写了
    await wb.close()
  })

  it('open() 幂等：重复调用不重复写头部帧', async () => {
    const file = join(home, 's.jsonl')
    const wb = new SessionWriteBehind({ file, header: HEADER, batchMs: 10 })
    wb.open()
    wb.open()
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
    await wb.close()
  })
})

describe('T2.2 load() 与损坏判定（报错不猜）', () => {
  it('撕裂尾记录：丢弃最后一条且不报错', () => {
    const good = encodeJsonl([HEADER, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
    const truncated = good + '{"type":"turn/end","seq":1,"ti' // 半条
    const loaded = parseLogText(truncated)
    expect(loaded.tornTailDiscarded).toBe(true)
    expect(loaded.events).toHaveLength(1)
  })

  it('中间行损坏 → ES-CORRUPTED（不猜、不降级解析）', () => {
    const text =
      encodeJsonl([HEADER, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]) +
      '{"broken\n' +
      encodeJsonl([{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } }])
    expect(() => parseLogText(text)).toThrow(/中间行损坏/)
    try {
      parseLogText(text)
    } catch (err) {
      expect((err as LcodeErrorImpl).code).toBe('ES-CORRUPTED')
    }
  })

  it('头部帧损坏 → ES-CORRUPTED（提示导出抢救）', () => {
    const text = '{"kind":"file-head\n' + encodeJsonl([{ type: 'turn/start', seq: 0, time: 1, data: {} }])
    try {
      parseLogText(text)
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as LcodeErrorImpl).code).toBe('ES-CORRUPTED')
    }
  })

  it('空文件 → ES-CORRUPTED', () => {
    expect(() => parseLogText('')).toThrow(/为空/)
  })

  it('formatVersion 未知 → ES-FORMAT_UNSUPPORTED（绝不尽力解析）', () => {
    const future = { ...HEADER, formatVersion: 99 }
    const text = encodeJsonl([future as LogFrame])
    try {
      parseLogText(text)
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as LcodeErrorImpl).code).toBe('ES-FORMAT_UNSUPPORTED')
    }
  })

  it('头部帧声明 codec:zstd 但内容是明文 → 照样能解析（codec 描述文件编码，不影响明文解析）', () => {
    // T6.2 之后：解压发生在 `readLogBytes()`（按**魔数**判定），`parseLogText()` 拿到的
    // 一定是明文。所以带 `codec:'zstd'` 的明文文本是可以被解析的——`codec` 记录的是
    // "这份日志的文件形态"，不是"读它的人该做什么"。
    // 反过来：真的压缩件被改名成 `.jsonl` 时，`readLogBytes()` 会按魔数认出它并解压。
    const text = encodeJsonl([{ ...HEADER, codec: 'zstd' }])
    expect(parseLogText(text).header.codec).toBe('zstd')
  })

  it('未知的 codec 值 → ES-FORMAT_UNSUPPORTED（不猜）', () => {
    const text = encodeJsonl([{ ...HEADER, codec: 'lz4' as unknown as 'none' }])
    try {
      parseLogText(text)
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as LcodeErrorImpl).code).toBe('ES-FORMAT_UNSUPPORTED')
    }
  })

  it('seq 不连续 → ES-SEQ_DISCONTINUOUS', () => {
    const text = encodeJsonl([
      HEADER,
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 5, time: 2, data: { turn: 1, reason: 'completed' } },
    ])
    try {
      parseLogText(text)
      throw new Error('应当抛错')
    } catch (err) {
      expect((err as LcodeErrorImpl).code).toBe('ES-SEQ_DISCONTINUOUS')
    }
  })

  it('杀掉进程后仍能 load（文件完整时）', async () => {
    const file = join(home, 's.jsonl')
    const wb = new SessionWriteBehind({ file, header: HEADER, batchMs: 5 })
    wb.open()
    wb.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
    await wb.flush()
    // 故意不 close（模拟进程被杀）
    expect(loadLog(file).events).toHaveLength(1)
  })
})

describe('T2.3 原子物化', () => {
  it('写入后不留临时文件，内容正确', () => {
    const target = join(home, 'out.txt')
    writeFileAtomicSync(target, 'hello')
    expect(readFileSync(target, 'utf8')).toBe('hello')
    expect(readdirSync(home).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('覆盖已存在目标（旧内容不残留）', () => {
    const target = join(home, 'out.txt')
    writeFileSync(target, 'old-content-longer')
    writeFileAtomicSync(target, 'new')
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readdirSync(home).filter((f) => f.includes('.tmp-') || f.includes('.old-'))).toEqual([])
  })

  it('目标目录不存在时自动创建', () => {
    const target = join(home, 'a', 'b', 'out.txt')
    writeFileAtomicSync(target, 'x')
    expect(existsSync(target)).toBe(true)
  })

  it('appendFileSyncDurable 追加并返回字节数', () => {
    const target = join(home, 'log.txt')
    expect(appendFileSyncDurable(target, 'a')).toBe(1)
    expect(appendFileSyncDurable(target, '中')).toBe(3) // UTF-8 三字节
    expect(readFileSync(target, 'utf8')).toBe('a中')
  })
})

describe('T2.4 revision', () => {
  it('内容不变 → revision 不变；追加一字节 → 变化', () => {
    const file = join(home, 's.jsonl')
    writeFileSync(file, 'a')
    const r1 = computeRevision(file).revision
    expect(computeRevision(file).revision).toBe(r1)
    appendFileSyncDurable(file, 'b')
    expect(computeRevision(file).revision).not.toBe(r1)
  })

  it('精度不足时记录实际精度（不假装纳秒）', () => {
    const file = join(home, 's.jsonl')
    writeFileSync(file, 'a')
    const { precision } = computeRevision(file)
    expect(['ns', 'ms']).toContain(precision)
  })
})

describe('T2.5 分桶与反查', () => {
  it('会话落在 sessions/<workspace-key>/ 下；无 cwd 落 _unknown', async () => {
    const store = new JsonlSessionPersistence({ home })
    await store.open('S1' as never, { cwd: '/repo/web' })
    await store.open('S2' as never)
    await store.flush('S1' as never)
    await store.flush('S2' as never)

    const buckets = readdirSync(join(home, 'sessions')).sort()
    expect(buckets).toEqual([workspaceBucket('/repo/web'), '_unknown'].sort())
    // 入库路径一律用 `/`（22 §7.3），所以期望值也要规范化，不能拿 Windows 的 `\` 去比
    expect(store.filePathOf('S1')).toBe(
      normalizePath(join(home, 'sessions', workspaceBucket('/repo/web'), 'S1.jsonl')),
    )
    await store.closeAll()
  })

  it('可按 sessionId 反查路径并列出全部会话文件', async () => {
    const store = new JsonlSessionPersistence({ home })
    await store.open('S1' as never, { cwd: '/repo/web' })
    await store.flush('S1' as never)
    await store.closeAll()

    expect(findSessionFile(home, 'S1')).toContain('S1.jsonl')
    expect(findSessionFile(home, 'NOPE')).toBeNull()
    expect(listSessionFiles(home).map((x) => x.sessionId)).toEqual(['S1'])
  })

  it('续写已有文件：不重复写头部帧，事件接着走', async () => {
    const store = new JsonlSessionPersistence({ home, batchMs: 5 })
    await store.open('S1' as never, { cwd: '/repo/web' })
    await store.append('S1' as never, [ev('turn/start', 0, { turn: 1 })])
    await store.flush('S1' as never)
    await store.closeAll()

    const again = new JsonlSessionPersistence({ home, batchMs: 5 })
    await again.open('S1' as never, { cwd: '/repo/web' })
    await again.append('S1' as never, [ev('turn/end', 1, { turn: 1, reason: 'completed' })])
    await again.flush('S1' as never)
    await again.closeAll()

    const file = findSessionFile(home, 'S1')!
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3) // 1 头部 + 2 事件
    expect(loadLog(file).events.map((e) => e.seq)).toEqual([0, 1])
  })
})

describe('T2.6 不变量', () => {
  it('I1：打包 → 解包往返一致（chunk 批不丢信息）', () => {
    const events: EventFrame[] = [
      { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
      { type: 'assistant/chunk', seq: 1, time: 110, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '你' } } },
      { type: 'assistant/chunk', seq: 2, time: 130, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '好' } } },
      { type: 'assistant/chunk', seq: 3, time: 130, data: { turn: 1, step: 1, chunk: { type: 'done', message: { role: 'assistant', content: [] } } } },
      { type: 'turn/end', seq: 4, time: 200, data: { turn: 1, reason: 'completed' } },
    ]
    const packed = packFrames(HEADER, events)
    // header + turn/start + 一个 chunk 批帧 + turn/end —— 3 条连续 chunk 合成 1 条记录
    expect(packed).toHaveLength(4)
    expect((packed[2] as { type: string }).type).toBe('assistant/chunk/batch')
    const round = unpackFrames(packed)
    expect(round.events).toEqual(events)
  })

  it('I2 负例 A：批帧声称的跨度与条数不符 → 报错（不静默解包成短序列）', () => {
    const broken: LogFrame[] = [
      HEADER,
      {
        type: 'assistant/chunk/batch',
        seqFirst: 0,
        seqLast: 2,
        time: 1,
        data: { turn: 1, step: 1, chunks: [{ dt: 0, c: { type: 'text-delta', text: 'a' } }] }, // 只 1 条但声称 0..2
      },
    ]
    expect(() => unpackFrames(broken)).toThrow(/跨度与条数不符/)
  })

  it('I2 负例 B：事件 seq 跳号 → 报错', () => {
    const broken: LogFrame[] = [
      HEADER,
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }, // 少了 seq 0
    ]
    expect(() => unpackFrames(broken)).toThrow(/seq 不连续/)
  })

  it('I5：无损 JSON —— 拒绝 BigInt / NaN / 循环引用 / undefined / Date', () => {
    const base = { kind: 'file-header', formatVersion: 1, sessionId: 'S', createdAt: 1, cwd: null, parentSession: null, seedLength: 0, codec: 'none', keyId: null } satisfies FileHeaderFrame
    const bad = (data: unknown): (() => string) => () => encodeJsonl([base, { type: 'x', seq: 0, time: 1, data } as unknown as LogFrame])

    expect(bad({ n: 1n })).toThrow(/BigInt/)
    expect(bad({ n: Number.NaN })).toThrow(/NaN/)
    expect(bad({ d: new Date() })).toThrow(/Date/)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(bad(cyclic)).toThrow(/循环引用/)
    expect(bad({ u: undefined })).toThrow(/undefined/)

    expect(() => encodeJsonl([base])).not.toThrow()
  })
})

describe('T3.6 前提：实时写入的记录定位与重建扫描结果一致', () => {
  it('write-behind 累积的 spans 与按行重扫的 spans 完全相同', async () => {
    const file = join(home, 's.jsonl')
    const captured: SessionLogSnapshot[] = []
    const wb = new SessionWriteBehind({
      file,
      header: HEADER,
      batchMs: 5,
      onFlush: (info) => {
        captured.push({ sessionId: 'S1', header: HEADER, events: [], spans: info.spans, revision: '', bytes: info.bytes, indexedAt: 0 })
      },
    })
    wb.open()
    wb.append([
      { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
      { type: 'assistant/chunk', seq: 1, time: 110, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '甲' } } },
      { type: 'assistant/chunk', seq: 2, time: 120, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '乙' } } },
    ])
    await wb.flush()
    await wb.close()

    const live = captured.at(-1)!.spans
    const rescanned = loadLogWithSpans(file, 0).spans
    expect(rescanned.map((s) => ({ ...s, createdAt: 0 }))).toEqual(live.map((s) => ({ ...s, createdAt: 0 })))
    // 且字节长度确实和文件对得上
    const total = live.reduce((sum, s) => sum + s.byteLength, 0)
    expect(total).toBe(Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8'))
  })

  it('scanSpans 在行帧数不一致时直接报错（不静默错位）', () => {
    expect(() => scanSpans(['a', 'b'], [HEADER], 0)).toThrow(/不一致/)
  })
})

describe('契约实现（SessionPersistenceService）', () => {
  it('load() 还原出完全相同的追加序列（I1 的另一半）', async () => {
    const store = new JsonlSessionPersistence({ home, batchMs: 5 })
    await store.open('S1' as never, { cwd: '/repo/web' })
    const events = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { role: 'user', content: '把 parse.ts 换成结构化解析' }),
      ev('turn/end', 2, { turn: 1, reason: 'completed' }),
    ]
    await store.append('S1' as never, events)
    await store.flush('S1' as never)
    await store.closeAll()

    const reopened = new JsonlSessionPersistence({ home })
    expect(await reopened.load('S1' as never)).toEqual(events)
    await reopened.closeAll()
  })

  it('verify()：正常会话 ok；未配对 tool/call 报 I3', async () => {
    const store = new JsonlSessionPersistence({ home, batchMs: 5 })
    await store.open('S1' as never, { cwd: '/repo/web' })
    await store.append('S1' as never, [
      ev('turn/start', 0, { turn: 1 }),
      ev('tool/call', 1, { turn: 1, step: 1, callId: 'call_a', name: 'read', arguments: '{}' }),
    ])
    await store.flush('S1' as never)
    const report = await store.verify('S1' as never)
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toMatch(/I3/)
    expect(report.eventCount).toBe(2)
    await store.closeAll()
  })

  it('未打开的会话 append 报 ES-SESSION_NOT_FOUND', async () => {
    const store = new JsonlSessionPersistence({ home })
    await expect(store.append('NOPE' as never, [])).rejects.toMatchObject({ code: 'ES-SESSION_NOT_FOUND' })
  })

  it('索引侧 sink 在 flush 后收到完成态快照；sink 抛错不影响会话', async () => {
    const snapshots: SessionLogSnapshot[] = []
    const store = new JsonlSessionPersistence({
      home,
      batchMs: 5,
      sink: {
        onSessionFlushed: (s) => {
          snapshots.push(s)
          throw new Error('索引侧故意失败')
        },
      },
    })
    await store.open('S1' as never, { cwd: '/repo/web' })
    await store.append('S1' as never, [ev('turn/start', 0, { turn: 1 })])
    await expect(store.flush('S1' as never)).resolves.toBeUndefined()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.events).toHaveLength(1)
    expect(snapshots[0]!.spans[0]!.kind).toBe('header')
    expect(snapshots[0]!.bytes).toBeGreaterThan(0)
    await store.closeAll()
  })
})
