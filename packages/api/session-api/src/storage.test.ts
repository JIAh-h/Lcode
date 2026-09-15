import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initZstd } from '@lcode/session-persistence-jsonl'
import { closeAllIndexDbs, openIndexDb } from '@lcode/session-persistence-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSessionsApi } from './sessions-api.ts'
import { TRASH_RETENTION_MS } from './storage.ts'

/**
 * T6.3 验收（docs/24 §5 阶段 6；[22 §9.3/§9.5](../../../docs/22-数据字典与DDL.md) / 11 §9.3）。
 *
 * 这一组测试盯的是**"用户的数据到底还在不在"**，所以每条断言都落在磁盘与索引上：
 * - 软删只隐藏、**文件不动**；恢复能撤回
 * - 硬删**前必须确认可导出**（未确认回 `EC-CONFLICT`）；确认后文件进 `trash/`
 * - 硬删**不留孤儿行**（外键 CASCADE + `file_changes` 显式清理）
 * - `trash/` 到期清理按条目**自带的删除时刻**判定，未到期的**绝不**动
 * - `cache/` 按 LRU 淘汰，且**永不碰 `sessions/`**
 */

const NOW = 1_700_000_000_000
let home = ''
let api: LocalSessionsApi

beforeEach(async () => {
  await initZstd()
  home = mkdtempSync(join(tmpdir(), 'lcode-store-'))
  api = new LocalSessionsApi({ home, now: () => NOW })
})

afterEach(async () => {
  await api.close()
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
})

const CWD = '/repo/web'

async function seedSession(title = '测试'): Promise<string> {
  const { session_id } = await api.create({ cwd: CWD, title })
  await api.append({ session_id, type: 'turn/start', data: { turn: 1 } as never })
  await api.append({ session_id, type: 'user/message', data: { role: 'user', content: '把 parse.ts 换掉' } as never })
  await api.append({ session_id, type: 'turn/end', data: { turn: 1, reason: 'completed' } as never })
  await api.flush({ session_id })
  return session_id
}

async function logPathOf(session_id: string): Promise<string> {
  return join(home, (await api.meta({ session_id })).header.log_path)
}

describe('T6.3 软删 / 恢复（22 §9.3：隐藏但不销毁）', () => {
  it('软删后从 list 消失，但**文件仍在**、索引行仍在', async () => {
    const session_id = await seedSession()
    const file = await logPathOf(session_id)
    expect((await api.list()).items.map((s) => s.session_id)).toEqual([session_id])

    const result = await api.delete({ session_id })
    expect(result.deleted_at).toBe(NOW)

    expect((await api.list()).items).toEqual([])
    expect(existsSync(file)).toBe(true) // 关键：文件不动
    const row = openIndexDb({ home }).prepare('SELECT deleted_at FROM sessions WHERE session_id = ?').get(session_id)
    expect(row).toMatchObject({ deleted_at: NOW })
  })

  it('恢复撤销软删；幂等（再恢复一次也不报错）', async () => {
    const session_id = await seedSession()
    await api.delete({ session_id })
    await api.restore({ session_id })
    expect((await api.list()).items.map((s) => s.session_id)).toEqual([session_id])
    await expect(api.restore({ session_id })).resolves.toMatchObject({ restored: true })
  })

  it('软删的会话不进全文搜索（22 未决问题倾向：已删除搜不到）', async () => {
    const session_id = await seedSession()
    const hitsBefore = (await api.list()).items.length
    expect(hitsBefore).toBe(1)

    await api.delete({ session_id })
    const { searchMessages } = await import('@lcode/session-persistence-sqlite')
    const db = openIndexDb({ home })
    expect(searchMessages(db, 'parse').some((h) => h.sessionId === session_id)).toBe(false)
  })

  it('软删标记不会被重投影覆盖（否则删除会"自己长回来"）', async () => {
    const session_id = await seedSession()
    await api.delete({ session_id })
    // 触发一次重投影（meta 在索引缺行时会补投影；这里直接调 flush 走索引侧）
    await api.flush({ session_id })
    const row = openIndexDb({ home }).prepare('SELECT deleted_at FROM sessions WHERE session_id = ?').get(session_id)
    expect(row).toMatchObject({ deleted_at: NOW })
  })
})

describe('T6.3 硬删（22 §9.3：先提示导出，再移入回收站）', () => {
  it('未确认导出 → 拒绝执行（EC-CONFLICT），文件与索引都不动', async () => {
    const session_id = await seedSession()
    const file = await logPathOf(session_id)

    await expect(api.purge({ session_id })).rejects.toMatchObject({ code: 'EC-CONFLICT' })
    expect(existsSync(file)).toBe(true)
    expect((await api.list()).items.map((s) => s.session_id)).toEqual([session_id])
  })

  it('exported: true → 文件进 trash/，索引行与派生行全部清掉', async () => {
    const session_id = await seedSession()
    const file = await logPathOf(session_id)

    const result = await api.purge({ session_id, exported: true })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(result.trashed_path)).toBe(true)
    expect(result.trashed_path).toContain(join('trash', `${session_id}.jsonl.`))

    const db = openIndexDb({ home })
    for (const table of ['sessions', 'turns', 'steps', 'events', 'messages_projection', 'session_log_index']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(session_id)
      expect(row, `${table} 应无孤儿行`).toMatchObject({ n: 0 })
    }
    // 被删会话搜不到
    const { searchMessages } = await import('@lcode/session-persistence-sqlite')
    expect(searchMessages(db, 'parse').some((h) => h.sessionId === session_id)).toBe(false)
  })

  it('force: true 可跳过导出提示（危险路径必须显式）', async () => {
    const session_id = await seedSession()
    await expect(api.purge({ session_id, force: true })).resolves.toMatchObject({
      trashed_path: expect.stringContaining('trash'),
    })
  })

  it('硬删后 listTrash 能列出它，且带剩余保留时间', async () => {
    const session_id = await seedSession()
    await api.purge({ session_id, exported: true })

    const trash = await api.listTrash()
    expect(trash.items).toHaveLength(1)
    expect(trash.items[0]).toMatchObject({ session_id })
    expect(trash.items[0]!.expires_in_ms).toBeGreaterThan(0)
    expect(trash.items[0]!.expires_in_ms).toBeLessThanOrEqual(TRASH_RETENTION_MS)
  })
})

describe('T6.3b 回收站到期清理（22 §9.2：7 天）', () => {
  /**
   * 把回收站条目"变老"：直接改文件名里的 `deleted_at`。
   *
   * 为什么改名字而不是 `utimesSync` 改 mtime：判定用的是**条目自带的删除时刻**
   * （`trash/<id>.jsonl.<ts>` 里的 ts），不是文件系统 mtime。见 `readTrashEntry` 的注释。
   */
  function backtrack(path: string, ms: number): string {
    const aged = path.replace(/\.(\d+)$/, (_m, ts: string) => `.${Number(ts) - ms}`)
    renameSync(path, aged)
    return aged
  }

  it('超过 7 天的条目被删；未到期的**绝不**动', async () => {
    const a = await seedSession('老的')
    const b = await seedSession('新的')
    const ra = await api.purge({ session_id: a, exported: true })
    const rb = await api.purge({ session_id: b, exported: true })

    const agedPath = backtrack(ra.trashed_path, TRASH_RETENTION_MS + 60_000) // 8 天前删的

    const result = await api.prune({ cache: false })
    expect(result.trash.removed).toBe(1)
    expect(existsSync(agedPath)).toBe(false)
    expect(existsSync(rb.trashed_path)).toBe(true)
    expect(result.trash.kept).toBe(1)
  })

  it('清空回收站跳过 7 天窗口，立即硬删', async () => {
    const session_id = await seedSession()
    await api.purge({ session_id, exported: true })
    expect((await api.listTrash()).items).toHaveLength(1)

    const result = await api.prune({ emptyTrash: true, cache: false })
    expect(result.trash.removed).toBe(1)
    expect((await api.listTrash()).items).toEqual([])
  })

  it('**绝不**删会话：prune 跑几轮，sessions/ 里的东西一个不少', async () => {
    const session_id = await seedSession()
    const before = readFileSync(await logPathOf(session_id)).length
    for (let i = 0; i < 3; i++) await api.prune()
    expect(readFileSync(await logPathOf(session_id)).length).toBe(before)
  })
})

describe('T6.3b cache 的 LRU 淘汰（22 §9.2：总上限 2GB）', () => {
  function makeCacheEntry(name: string, bytes: number, ageMs: number): string {
    const dir = join(home, 'cache', name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'data.bin')
    writeFileSync(file, Buffer.alloc(bytes, 1))
    const t = (NOW - ageMs) / 1000
    utimesSync(file, t, t)
    utimesSync(dir, t, t)
    return dir
  }

  it('超上限时淘汰最久未被写过的条目', async () => {
    const oldest = makeCacheEntry('repo-map', 400, 3 * 3600_000)
    const middle = makeCacheEntry('web', 400, 2 * 3600_000)
    const newest = makeCacheEntry('spill', 400, 1 * 3600_000)

    // 上限设成 900 B：1200 B 的总量要淘汰至少一个
    const { pruneCache } = await import('./storage.ts')
    const result = pruneCache(home, { limitBytes: 900 })

    expect(result.evicted.map((e) => e.path)).toEqual([oldest])
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(true)
    expect(existsSync(newest)).toBe(true)
    expect(result.remainingBytes).toBeLessThanOrEqual(900)
  })

  it('未超上限时什么都不淘汰', async () => {
    const dir = makeCacheEntry('repo-map', 100, 60_000)
    const { pruneCache } = await import('./storage.ts')
    const result = pruneCache(home, { limitBytes: 10_000 })
    expect(result.evicted).toEqual([])
    expect(result.stillOverLimit).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it('purgeCache 清空整棵 cache（可重建，绝不影响正确性）', async () => {
    makeCacheEntry('repo-map', 100, 60_000)
    const session_id = await seedSession()

    const result = await api.prune({ purgeCache: true, trash: false })
    expect(result.cache.remainingBytes).toBe(0)
    expect(existsSync(join(home, 'cache'))).toBe(false)
    // 会话毫发无损
    expect((await api.list()).items.map((s) => s.session_id)).toEqual([session_id])
  })
})

describe('T6.3b 容量统计（M-DATA-04 存储占用可视化）', () => {
  it('分项统计正确，且 total 等于各项之和', async () => {
    const session_id = await seedSession()
    const usage = await api.storageUsage()

    expect(usage.sessions).toBeGreaterThan(0)
    expect(usage.index).toBeGreaterThan(0)
    expect(usage.total).toBe(usage.sessions + usage.trash + usage.cache + usage.exports + usage.index)
    expect(session_id).toBeTruthy()
  })

  it('空 Home 的各项都是 0，不抛错', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lcode-empty-'))
    try {
      const fresh = new LocalSessionsApi({ home: empty })
      const usage = await fresh.storageUsage()
      expect(usage).toMatchObject({ sessions: 0, trash: 0, exports: 0, index: 0 })
      await fresh.close()
    } finally {
      closeAllIndexDbs()
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('T6.3 全量导出（22 §9.5：`export --all` + manifest）', () => {
  it('逐会话导出 + manifest.json 记 SHA-256，且文件能被重新解析', async () => {
    const a = await seedSession('甲')
    const b = await seedSession('乙')
    const out = join(home, 'backup')

    const result = await api.exportAll({ out, format: 'jsonl' })
    expect(result.entries).toHaveLength(2)
    expect(result.skipped).toEqual([])
    expect(existsSync(result.manifest_path)).toBe(true)

    const manifest = JSON.parse(readFileSync(result.manifest_path, 'utf8')) as {
      count: number
      files: { session_id: string; file: string; bytes: number; sha256: string }[]
    }
    expect(manifest.count).toBe(2)
    expect(manifest.files.map((f) => f.session_id).sort()).toEqual([a, b].sort())
    // manifest 的 sha256 与文件实际内容对得上（这是"用户能自己校验"的全部意义）
    const { createHash } = await import('node:crypto')
    for (const entry of manifest.files) {
      const bytes = readFileSync(join(out, entry.file))
      expect(bytes.length).toBe(entry.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    }

    // 导出的 jsonl 能被 Lcode 重新读回来（22 §9.5：可再导入）
    const { loadLog } = await import('@lcode/session-persistence-jsonl')
    const reloaded = loadLog(join(out, `${a}.jsonl`))
    expect(reloaded.events.length).toBeGreaterThan(0)
    expect(reloaded.header.sessionId).toBe(a)
  })

  it('md 格式：每个会话一份可读文本，manifest 同步', async () => {
    const session_id = await seedSession()
    const out = join(home, 'md-backup')
    const result = await api.exportAll({ out, format: 'md' })
    expect(result.entries).toHaveLength(1)
    const text = readFileSync(join(out, `${session_id}.md`), 'utf8')
    expect(text).toContain('把 parse.ts 换掉')
  })

  it('jsonl 导出是**字节级副本**：损坏会话照样导出（导出不是校验动作）', async () => {
    const bad = await seedSession('坏的')
    const badFile = await logPathOf(bad)
    const lines = readFileSync(badFile, 'utf8').split('\n').filter((l) => l.length > 0)
    lines[1] = '{ 这不是 JSON'
    writeFileSync(badFile, lines.join('\n') + '\n')

    const out = join(home, 'raw-copy')
    const result = await api.exportAll({ out })
    // 关键取舍：`sessions.export` 的契约是"整份原始日志的副本、可再导入"（22 §9.5），
    // 所以它**不解析**内容——解析不了也该原样导出，否则用户连"抢救已解析前缀"都做不到。
    expect(result.entries.map((e) => e.session_id)).toEqual([bad])
    expect(result.skipped).toEqual([])
    expect(readFileSync(join(out, `${bad}.jsonl`), 'utf8')).toBe(readFileSync(badFile, 'utf8'))
  })

  it('md 导出必须解析 → 单个会话损坏记进 skipped，其余照常导出', async () => {
    const good = await seedSession('好的')
    const bad = await seedSession('坏的')
    const badFile = await logPathOf(bad)
    const lines = readFileSync(badFile, 'utf8').split('\n').filter((l) => l.length > 0)
    lines[1] = '{ 这不是 JSON' // 中间行不可解析 → ES-CORRUPTED，不可抢救
    writeFileSync(badFile, lines.join('\n') + '\n')

    const out = join(home, 'partial')
    const result = await api.exportAll({ out, format: 'md' })
    expect(result.entries.map((e) => e.session_id)).toEqual([good])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ session_id: bad })
    // skipped 也写进 manifest，用户才知道"这次备份少了谁"
    const manifest = JSON.parse(readFileSync(result.manifest_path, 'utf8')) as { skipped: unknown[] }
    expect(manifest.skipped).toHaveLength(1)
  })
})

describe('会话标题（22 §3.1：用户元数据，不在 JSONL 里）', () => {
  it('create 的 title 落进索引，且 list / meta 都看得到', async () => {
    const { session_id } = await api.create({ cwd: CWD, title: '登录重构' })
    expect((await api.list()).items[0]).toMatchObject({ session_id, title: '登录重构' })
    expect((await api.meta({ session_id })).header.title).toBe('登录重构')
  })

  it('重投影**不会**把标题清掉（投影不带 title 时保留已有值）', async () => {
    const session_id = await seedSession()
    await api.append({ session_id, type: 'turn/start', data: { turn: 2 } as never })
    openIndexDb({ home })
      .prepare('UPDATE sessions SET title = ? WHERE session_id = ?')
      .run('我给它起个名', session_id)

    // 触发一次完整重投影（jsonl 是重建的输入，不带 title）
    await api.flush({ session_id })
    expect((await api.meta({ session_id })).header.title).toBe('我给它起个名')
  })

  it('index rebuild 后标题仍在（它不在 JSONL 里，靠索引保留）', async () => {
    const session_id = await seedSession()
    openIndexDb({ home })
      .prepare('UPDATE sessions SET title = ? WHERE session_id = ?')
      .run('重建也要留着', session_id)

    await api.close()
    closeAllIndexDbs()
    api = new LocalSessionsApi({ home })
    api.reindex(session_id)
    expect((await api.meta({ session_id })).header.title).toBe('重建也要留着')
  })
})

describe('T6.2 压缩归档（22 §9.2/§9.4）', () => {
  const DAY = 24 * 60 * 60 * 1000
  /** 把文件 mtime 推到过去，模拟"空闲"（保留策略按 mtime 判定） */
  function age(file: string, msAgo: number): void {
    const t = (NOW - msAgo) / 1000
    utimesSync(file, t, t)
  }

  /**
   * 用一个**独立实例**做归档。
   *
   * 为什么要这样：种子会话是经 `api.create()` 建的，它在**那个实例**的内存里是"打开中"的，
   * 而 22 §9.2 要求开放中的会话永不压缩。独立实例看不到那个内存态，于是它看到的是
   * "磁盘上有一个空闲会话"——正是保留策略在真实启动时会遇到的情形。
   */
  async function archiveWithFreshInstance(input?: Parameters<LocalSessionsApi['archive']>[0]) {
    const fresh = new LocalSessionsApi({ home, now: () => NOW })
    try {
      return await fresh.archive(input)
    } finally {
      await fresh.close()
      closeAllIndexDbs()
    }
  }

  it('空闲 ≥30 天的会话被压成 .jsonl.zst；未到期的绝不动', async () => {
    const old = await seedSession('老的')
    const fresh = await seedSession('新的')
    age(await logPathOf(old), 31 * DAY)

    const report = await archiveWithFreshInstance()
    expect(report.zstd_available).toBe(true)
    expect(report.archived.map((a) => a.session_id)).toEqual([old])
    expect(existsSync(`${join(home, 'sessions')}`)).toBe(true)
    const oldPath = join(home, (await api.meta({ session_id: old })).header.log_path)
    const freshPath = join(home, (await api.meta({ session_id: fresh })).header.log_path)
    expect(existsSync(`${oldPath}.zst`)).toBe(true)
    expect(existsSync(freshPath)).toBe(true)
  })

  it('**开放中的会话永不压缩**（22 §9.2）', async () => {
    const id = await seedSession()
    const file = await logPathOf(id)
    age(file, 999 * DAY)

    // 本实例已经把会话打开了，所以显式把它算作"开放中"时应当被跳过
    const report = await api.archive({ openSessionIds: [id] })
    expect(report.archived).toEqual([])
    expect(report.skipped_open).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it('**只读操作不会把归档解压回来**（否则看一眼列表就吃掉 33× 磁盘）', async () => {
    const id = await seedSession()
    const file = await logPathOf(id)
    age(file, 31 * DAY)
    await archiveWithFreshInstance()
    const archived = `${file}.zst`
    expect(existsSync(archived)).toBe(true)

    // 一系列纯读操作（走独立实例）
    const reader = new LocalSessionsApi({ home, now: () => NOW })
    try {
      await reader.derive({ session_id: id })
      await reader.list()
      await reader.meta({ session_id: id })
    } finally {
      await reader.close()
      closeAllIndexDbs()
    }

    // 文件形态不变——归档仍然有效
    expect(existsSync(archived)).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('归档后仍能列出与派生（内容可读，只是形态是压缩的）', async () => {
    const id = await seedSession()
    const file = await logPathOf(id)
    age(file, 31 * DAY)
    await archiveWithFreshInstance()

    const reader = new LocalSessionsApi({ home, now: () => NOW })
    try {
      const listed = (await reader.list()).items.find((s) => s.session_id === id)
      expect(listed).toBeDefined()
      const { messages } = await reader.derive({ session_id: id })
      expect(messages.some((m) => JSON.stringify(m.content).includes('parse.ts'))).toBe(true)
    } finally {
      await reader.close()
      closeAllIndexDbs()
    }
  })

  it('resume 归档会话 → 还原成 .jsonl 并能继续追加（22 §9.2 的 resume 路径）', async () => {
    const id = await seedSession()
    const file = await logPathOf(id)
    age(file, 31 * DAY)
    await archiveWithFreshInstance()
    expect(existsSync(`${file}.zst`)).toBe(true)

    const reader = new LocalSessionsApi({ home, now: () => NOW })
    try {
      const resumed = await reader.resume({ session_id: id })
      expect(resumed.repaired).toBe(false)
      // 一旦要写入，就必须还原
      expect(existsSync(file)).toBe(true)
      expect(existsSync(`${file}.zst`)).toBe(false)

      await reader.append({ session_id: id, type: 'plan/mode', data: { active: true } as never })
      await reader.flush({ session_id: id })
      const { messages } = await reader.derive({ session_id: id })
      expect(messages.length).toBeGreaterThan(0)
    } finally {
      await reader.close()
      closeAllIndexDbs()
    }
  })

  it('dryRun 只报告不写盘', async () => {
    const id = await seedSession()
    const file = await logPathOf(id)
    age(file, 31 * DAY)

    const report = await archiveWithFreshInstance({ dryRun: true })
    expect(report.archived).toHaveLength(1)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.zst`)).toBe(false)
  })
})

describe('T6.3 硬删的顺序（先移文件、后删索引）', () => {
  it('移文件失败时索引不动（不留"索引说没了、文件还在"的半截态）', async () => {
    const session_id = await seedSession()
    // 让回收站路径不可创建：用同名文件占住 `trash`
    writeFileSync(join(home, 'trash'), 'not a dir')

    await expect(api.purge({ session_id, exported: true })).rejects.toBeDefined()
    // 索引行还在 → 用户仍能找到这个会话
    expect((await api.list()).items.map((s) => s.session_id)).toEqual([session_id])
    expect(statSync(await logPathOf(session_id)).size).toBeGreaterThan(0)
  })
})
