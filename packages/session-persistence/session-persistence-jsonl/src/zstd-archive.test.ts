import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveLogFile, archivedPathOf, restoreLogFile, restoredPathOf } from './archive.ts'
import { loadLog } from './loader.ts'
import type { EventFrame, FileHeaderFrame } from './jsonl.ts'
import { packFrames } from './jsonl.ts'
import { ARCHIVE_IDLE_MS, applyRetention } from './retention.ts'
import { createJsonlPersistence, listSessionFiles } from './session-store.ts'
import { initZstd, looksLikeZstd, setZstdForTest, zstdCompress, zstdDecompress, zstdReady } from './zstd.ts'

/**
 * T6.2 验收（docs/24 §5 阶段 6；[22 §9.2/§9.4](../../../docs/22-数据字典与DDL.md)、11 §9.2）。
 *
 * 判据（逐条）：
 * - 空闲 ≥ 30 天 → `.jsonl` → `.jsonl.zst`；**开放中的会话永不压缩**
 * - 压缩走**原子物化**；压缩后 `load()` **仍能还原**（透明解压）
 * - 一文件一 `codec`；**先打包再整体 zstd**
 * - **绝不自动删会话**（压缩只换形态，不减少会话数）
 * - 归档件可被 `open()` 还原回 `.jsonl` 再续写（resume 的路径）
 */

let home = ''
const cleanups: (() => void)[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-zstd-'))
})

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
  rmSync(home, { recursive: true, force: true })
})

const HEADER: FileHeaderFrame = {
  kind: 'file-header',
  formatVersion: 1,
  sessionId: 'S1',
  createdAt: 1,
  cwd: '/repo/web',
  parentSession: null,
  seedLength: 0,
  codec: 'none',
  keyId: null,
}

/** 写一个"够大、够真实"的会话文件（含连续 chunk，好让打包生效） */
function writeLog(sessionId: string, opts?: { chunks?: number; mtimeMs?: number }): string {
  const bucket = join(home, 'sessions', 'bkt')
  const file = join(bucket, `${sessionId}.jsonl`)
  const events: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown): void => {
    events.push({ type, seq: seq++, time: 1000 + seq, data } as unknown as SessionEvent)
  }
  push('turn/start', { turn: 1 })
  push('user/message', { role: 'user', content: '把 parse.ts 换成结构化解析' })
  push('step/start', { turn: 1, step: 1 })
  const n = opts?.chunks ?? 120
  for (let i = 0; i < n; i++) {
    push('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: `片段${i}：这是一段用于压缩测试的重复文本。` } })
  }
  push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '改完了' }] } })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: 'completed' })

  const frames = packFrames({ ...HEADER, sessionId }, events.map(toFrame))
  const text = frames.map((f) => JSON.stringify(f)).join('\n') + '\n'
  mkdirSync(bucket, { recursive: true })
  writeFileSync(file, text)
  if (opts?.mtimeMs !== undefined) {
    const t = opts.mtimeMs / 1000
    utimesSync(file, t, t)
  }
  return file
}

function toFrame(event: SessionEvent): EventFrame {
  return { type: event.type, seq: event.seq, time: event.time, data: event.data }
}

function sessionsDir(): string {
  return join(home, 'sessions', 'bkt')
}

function entries(): string[] {
  return existsSync(sessionsDir()) ? readdirSync(sessionsDir()).sort() : []
}

describe('T6.2 zstd 原语（22 §9.4）', () => {
  it('往返一致（压缩 → 解压得到同一段文本）', async () => {
    const text = '把 parse.ts 换成结构化解析\n'.repeat(40)
    const packed = zstdCompress(new TextEncoder().encode(text))
    expect(looksLikeZstd(packed)).toBe(true)
    expect(new TextDecoder().decode(zstdDecompress(packed))).toBe(text)
  })

  it('未就绪时给可路由的错误（不静默、不假装成功）', async () => {
    setZstdForTest(null)
    try {
      expect(() => zstdCompress(new Uint8Array([1, 2, 3]))).toThrowError(/zstd/)
    } finally {
      // 恢复：交给根目录 setup 之外的下一次 initZstd
      await initZstd()
    }
    expect(zstdReady()).toBe(true)
  })

  it('魔数判定：明文不会被误认成 zstd', () => {
    expect(looksLikeZstd(new TextEncoder().encode('{"kind":"file-header"}'))).toBe(false)
    expect(looksLikeZstd(new Uint8Array([]))).toBe(false)
  })

  it('路径变换成对出现', () => {
    expect(archivedPathOf('/x/a.jsonl')).toBe('/x/a.jsonl.zst')
    expect(restoredPathOf('/x/a.jsonl.zst')).toBe('/x/a.jsonl')
  })
})

describe('T6.2 归档与还原（22 §9.4）', () => {
  it('.jsonl → .jsonl.zst 后原文件不再存在，且体积显著变小', () => {
    const file = writeLog('S1')
    const before = statSync(file).size
    const loaded = loadLog(file)
    const result = archiveLogFile(file, packFrames(loaded.header, loaded.events))

    expect(existsSync(file)).toBe(false)
    expect(existsSync(result.path)).toBe(true)
    expect(result.path).toBe(`${file}.zst`)
    expect(result.compressedBytes).toBeLessThan(before)
    expect(result.ratio).toBeGreaterThan(1.5) // 重复文本应有可观的压缩比
  })

  it('归档件能被 loadLog 透明读取（内容与归档前逐帧一致）', () => {
    const file = writeLog('S2')
    const original = loadLog(file)
    const result = archiveLogFile(file, packFrames(original.header, original.events))

    const readBack = loadLog(result.path)
    expect(readBack.header).toEqual(original.header)
    expect(readBack.events).toEqual(original.events)
  })

  it('还原回 .jsonl 后能继续当活文件用（resume 的路径）', () => {
    const file = writeLog('S3')
    const loaded = loadLog(file)
    const archived = archiveLogFile(file, packFrames(loaded.header, loaded.events))

    const restored = restoreLogFile(archived.path, zstdDecompress)
    expect(restored.path).toBe(file)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(archived.path)).toBe(false)
    expect(restored.frames.length).toBe(loaded.frames.length)
  })

  it('把压缩件改名成 .jsonl 也不会被按明文解析（按魔数判定）', () => {
    const file = writeLog('S4')
    const loaded = loadLog(file)
    const archived = archiveLogFile(file, packFrames(loaded.header, loaded.events))

    const disguised = join(sessionsDir(), 'S4-disguised.jsonl')
    writeFileSync(disguised, readFileSync(archived.path))
    expect(() => loadLog(disguised)).not.toThrow()
    expect(loadLog(disguised).events.length).toBe(loaded.events.length)
  })

  it('非 zstd 内容被喂给解压路径 → 明确报错，不猜', () => {
    const fake = join(home, 'not-zstd.zst')
    writeFileSync(fake, '{"kind":"file-header"}')
    expect(() => restoreLogFile(fake, zstdDecompress)).toThrow(/不是 zstd 帧/)
  })
})

describe('T6.2 保留策略（22 §9.2：空闲 30 天）', () => {
  const now = 2_000_000_000_000

  it('空闲 ≥ 30 天的会话被归档；未到期的**绝不**动', () => {
    writeLog('OLD', { mtimeMs: now - ARCHIVE_IDLE_MS - 60_000 })
    writeLog('NEW', { mtimeMs: now - 1000 })

    const report = applyRetention({ home, now })
    expect(report.archived.map((a) => a.sessionId)).toEqual(['OLD'])
    expect(report.skippedIdle).toBe(1)
    expect(entries()).toEqual(['NEW.jsonl', 'OLD.jsonl.zst'].sort())
  })

  it('**开放中的会话永不压缩**（22 §9.2），哪怕它很老', () => {
    writeLog('OPEN', { mtimeMs: now - ARCHIVE_IDLE_MS * 5 })
    const report = applyRetention({ home, now, openSessionIds: ['OPEN'] })
    expect(report.archived).toEqual([])
    expect(report.skippedOpen).toBe(1)
    expect(entries()).toEqual(['OPEN.jsonl'])
  })

  it('dryRun 只报告不写盘', () => {
    writeLog('DRY', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    const report = applyRetention({ home, now, dryRun: true })
    expect(report.archived).toHaveLength(1)
    expect(entries()).toEqual(['DRY.jsonl']) // 文件形态没变
  })

  it('**绝不删会话**：归档只换形态，会话数一个不少', () => {
    writeLog('A', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    writeLog('B', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    writeLog('C', { mtimeMs: now - 1 })
    const beforeCount = entries().length

    applyRetention({ home, now })
    expect(entries()).toHaveLength(beforeCount)
    // 每个会话仍可按 sessionId 找回（两种扩展名都认）
    for (const id of ['A', 'B', 'C']) {
      expect(existsSync(join(sessionsDir(), `${id}.jsonl`)) || existsSync(join(sessionsDir(), `${id}.jsonl.zst`))).toBe(true)
    }
  })

  it('归档过的会话仍出现在 listSessionFiles 里（否则会从索引重建/导出里消失）', async () => {
    writeLog('KEEP', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    applyRetention({ home, now })
    const found = listSessionFiles(home).find((e) => e.sessionId === 'KEEP')
    expect(found).toBeDefined()
    expect(found?.state).toBe('archived')
  })

  it('压缩后的会话集被 load 全部读回（归档没有"读不出来"的会话）', () => {
    writeLog('R1', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    writeLog('R2', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    applyRetention({ home, now })
    for (const name of entries()) {
      expect(loadLog(join(sessionsDir(), name)).events.length).toBeGreaterThan(0)
    }
  })
})

describe('T6.2 归档件被 open() 打开时先还原（resume 路径）', () => {
  it('打开归档会话 → 解压回 .jsonl 并能继续追加', async () => {
    const now = Date.now()
    const file = writeLog('RESUME', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    applyRetention({ home, now })
    expect(entries()).toEqual(['RESUME.jsonl.zst'])

    const persistence = createJsonlPersistence({ home, batchMs: 5 })
    cleanups.push(() => void persistence.closeAll())
    await persistence.open(asSessionId('RESUME'), { cwd: '/repo/web' })

    // 已被还原成活文件（否则 write-behind 会往 zstd 帧后面写明文）
    expect(existsSync(file)).toBe(true)
    expect(existsSync(archivedPathOf(file))).toBe(false)

    // 能接着追加，且读回来是完整的（seq 必须接在既有日志之后——这是 I2）
    const before = loadLog(file)
    const nextSeq = before.events.length
    await persistence.append(asSessionId('RESUME'), [
      { type: 'plan/mode', seq: nextSeq, time: now, data: { active: true } } as unknown as SessionEvent,
    ])
    await persistence.flush(asSessionId('RESUME'))
    const after = loadLog(file)
    expect(after.events.length).toBe(before.events.length + 1)
    expect(after.events[after.events.length - 1]!.type).toBe('plan/mode')
  })

  it('没有 zstd 时打开归档件 → 可路由的错误，不静默降级', async () => {
    const now = Date.now()
    const file = writeLog('NOZSTD', { mtimeMs: now - ARCHIVE_IDLE_MS - 1 })
    applyRetention({ home, now })

    setZstdForTest(null)
    const persistence = createJsonlPersistence({ home, batchMs: 5 })
    cleanups.push(() => void persistence.closeAll())
    try {
      await expect(persistence.open(asSessionId('NOZSTD'), { cwd: '/repo/web' })).rejects.toMatchObject({
        code: 'ES-FORMAT_UNSUPPORTED',
      })
      // 文件仍是归档形态（没有半途改成明文）
      expect(existsSync(archivedPathOf(file))).toBe(true)
    } finally {
      await initZstd()
    }
  })
})
