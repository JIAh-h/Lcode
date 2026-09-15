import { join } from 'node:path'
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { closeAllIndexDbs, dropIndexDb, openIndexDb } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSessionsApi } from './sessions-api.ts'

/**
 * T6.4 验收（docs/24 §5 阶段 6；[22 §1.3](../../../docs/22-数据字典与DDL.md)）：
 *
 * > `lcode doctor --index` 逐会话比对 `log_revision` 与真实文件，报告需重索引者；
 * > **手工改一个 jsonl 后 doctor 能报出不一致**。
 *
 * 体检是只读的：它只 stat 文件、读 `sessions` 表，不改任何东西。
 */

let home = ''
let api: LocalSessionsApi

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-doctor-'))
  api = new LocalSessionsApi({ home })
})

afterEach(async () => {
  await api.close()
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/repo/web'

/** 建一个已落盘并被索引的会话 */
async function seedSession(): Promise<string> {
  const { session_id } = await api.create({ cwd: CWD })
  await api.append({ session_id, type: 'turn/start', data: { turn: 1 } as never })
  await api.append({
    session_id,
    type: 'user/message',
    data: { role: 'user', content: '你好' } as never,
  })
  await api.append({ session_id, type: 'turn/end', data: { turn: 1, reason: 'completed' } as never })
  await api.flush({ session_id })
  return session_id
}

async function logPathOf(session_id: string): Promise<string> {
  return join(home, (await api.meta({ session_id })).header.log_path)
}

describe('T6.4 doctor --index：索引与日志的一致性', () => {
  it('全部对齐时不报任何问题', async () => {
    await seedSession()
    const report = await api.doctorIndex()
    expect(report.ok).toBe(true)
    expect(report.dbExists).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.needsReindex).toBe(0)
  })

  it('手工改动 jsonl → 报 changed（这是 T6.4 的核心判据）', async () => {
    const session_id = await seedSession()
    const file = await logPathOf(session_id)

    // 模拟"别的工具写入了这个日志"：追加一行合法事件，revision 随之变化
    appendFileSync(file, '{"type":"plan/mode","seq":3,"time":1,"data":{"active":true}}\n')

    const report = await api.doctorIndex()
    expect(report.ok).toBe(false)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ sessionId: session_id, reason: 'changed' })
    expect(report.needsReindex).toBe(1)
  })

  it('重建后不再报问题（体检结论能靠 index rebuild 收敛）', async () => {
    const session_id = await seedSession()
    const file = await logPathOf(session_id)
    appendFileSync(file, '{"type":"plan/mode","seq":3,"time":1,"data":{"active":true}}\n')
    expect((await api.doctorIndex()).needsReindex).toBe(1)

    await api.close()
    closeAllIndexDbs()
    api = new LocalSessionsApi({ home })
    api.reindex(session_id)
    const after = await api.doctorIndex()
    expect(after.findings).toEqual([])
    expect(after.ok).toBe(true)
  })

  it('日志存在但索引没行 → 报 not-indexed', async () => {
    const session_id = await seedSession()
    // 删掉索引行（模拟索引落后/缺行）
    openIndexDb({ home }).prepare('DELETE FROM sessions WHERE session_id = ?').run(session_id)

    const report = await api.doctorIndex()
    expect(report.findings).toEqual([expect.objectContaining({ sessionId: session_id, reason: 'not-indexed' })])
    expect(report.needsReindex).toBe(1)
  })

  it('索引有行但日志文件不在 → 报 missing（不计入 needsReindex）', async () => {
    const session_id = await seedSession()
    rmSync(await logPathOf(session_id))

    const report = await api.doctorIndex()
    expect(report.findings).toEqual([expect.objectContaining({ sessionId: session_id, reason: 'missing' })])
    // missing 不是"重建能救回的"——重建也读不到文件
    expect(report.needsReindex).toBe(0)
    expect(report.ok).toBe(false)
  })

  it('索引库不存在 → 报告库缺失并建议重建，而不是抛错', async () => {
    await seedSession()
    await api.close()
    closeAllIndexDbs()
    dropIndexDb(home)
    api = new LocalSessionsApi({ home })

    const report = await api.doctorIndex()
    expect(report.dbExists).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.note).toMatch(/rebuild/)
    // 库没了，所有日志都算 not-indexed
    expect(report.findings.every((f) => f.reason === 'not-indexed')).toBe(true)
  })

  it('体检是只读的：跑两次结果一致，且文件大小与 mtime 不变', async () => {
    const session_id = await seedSession()
    const file = await logPathOf(session_id)
    const before = `${statSync(file).size}:${statSync(file).mtimeMs}`

    const first = await api.doctorIndex()
    const second = await api.doctorIndex()
    expect(first.findings).toEqual(second.findings)
    expect(`${statSync(file).size}:${statSync(file).mtimeMs}`).toBe(before)
    expect(first.ok).toBe(true)
    expect(session_id).toBeTruthy()
  })
})
