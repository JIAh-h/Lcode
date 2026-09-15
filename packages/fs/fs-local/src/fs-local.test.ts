import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizePath } from '@lcode/fs'
import { createLocalFs } from './fs-local.ts'
import type { FsService } from '@lcode/fs'

/**
 * `fs-local` 验收（04 §5.3 的 M-TOOL-01..04；21 §3.1–3.5 的规范值形状）。
 *
 * 盯的是**几处容易做错、错了又不容易发现**的地方：
 * - 行窗口的行号（模型拿它当 `edit` 的坐标系，错一个就改错地方）
 * - `edit` 的"不唯一就报错、不猜"（M-TOOL-02 的硬要求）
 * - 截断**必须显式标注**（否则模型以为看到了全部）
 */

let root = ''
let fs: FsService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcode-fs-'))
  fs = createLocalFs({ workspaceRoot: root })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (rel: string, content: string): void => {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

describe('read：行窗口与行号', () => {
  it('整文件读：行号从 1 起，totalLines 不含尾部空行', async () => {
    write('a.ts', 'one\ntwo\nthree\n')
    const r = await fs.read('a.ts')
    expect(r.lines).toEqual([
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ])
    // 尾部的 `\n` 不算一行——否则模型看到的行号会比编辑器里多一个
    expect(r.totalLines).toBe(3)
    expect(r.truncated).toBe(false)
  })

  it('offset/limit 给出**真实行号**（不是窗口内的 1..n）', async () => {
    write('a.ts', 'l1\nl2\nl3\nl4\nl5\n')
    const r = await fs.read('a.ts', { offset: 3, limit: 2 })
    expect(r.lines.map((l) => [l.number, l.text])).toEqual([
      [3, 'l3'],
      [4, 'l4'],
    ])
    // totalLines 说的是**整个文件**，不是窗口长度——模型据此知道还有多少没看
    expect(r.totalLines).toBe(5)
    expect(r.truncated).toBe(true)
  })

  it('空文件是 0 行，不是 1 行', async () => {
    write('empty.txt', '')
    const r = await fs.read('empty.txt')
    expect(r.lines).toEqual([])
    expect(r.totalLines).toBe(0)
  })

  it('返回**绝对路径**（规范化后），供上层做边界判定', async () => {
    write('a.ts', 'x')
    const r = await fs.read('a.ts')
    expect(r.path).toBe(normalizePath(join(root, 'a.ts')))
  })
})

describe('write：created 标记', () => {
  it('新建 → created=true；覆盖 → created=false', async () => {
    const first = await fs.write('new.ts', 'hello')
    expect(first).toMatchObject({ created: true, bytesWritten: 5 })

    const second = await fs.write('new.ts', 'hello world')
    expect(second).toMatchObject({ created: false, bytesWritten: 11 })
  })

  it('默认自动建目录', async () => {
    await fs.write('deep/nested/x.ts', 'x')
    expect((await fs.read('deep/nested/x.ts')).lines[0]!.text).toBe('x')
  })
})

describe('edit：不唯一就报错、不猜（M-TOOL-02）', () => {
  it('唯一匹配 → 替换成功，hunks 给出改动的行区间', async () => {
    write('a.ts', 'const a = 1\nconst b = 2\n')
    const r = await fs.edit({ path: 'a.ts', oldText: 'const a = 1', newText: 'const a = 42' })
    expect(r.applied).toBe(1)
    expect(r.hunks).toEqual([{ start: 1, end: 1, oldLines: ['const a = 1'], newLines: ['const a = 42'] }])
    expect((await fs.read('a.ts')).lines[0]!.text).toBe('const a = 42')
  })

  it('**匹配到 0 处 → 报错，且文件不动**', async () => {
    write('a.ts', 'const a = 1\n')
    await expect(fs.edit({ path: 'a.ts', oldText: '不存在的内容', newText: 'x' })).rejects.toMatchObject({
      code: 'ET-INVALID_ARGS',
    })
    expect((await fs.read('a.ts')).lines[0]!.text).toBe('const a = 1')
  })

  it('**匹配到多处 → 报错，且提示出现次数；不开 replaceAll 绝不改**', async () => {
    write('a.ts', 'let x = 1\nlet x = 1\nlet x = 1\n')
    await expect(fs.edit({ path: 'a.ts', oldText: 'let x = 1', newText: 'let x = 2' })).rejects.toMatchObject({
      code: 'ET-INVALID_ARGS',
    })
    // 用户消息里要给出次数，否则他不知道自己该补多少上下文
    await fs
      .edit({ path: 'a.ts', oldText: 'let x = 1', newText: 'let x = 2' })
      .catch((err: { userMessage?: string }) => expect(err.userMessage).toContain('3'))
    // 文件原样
    expect((await fs.read('a.ts')).totalLines).toBe(3)
  })

  it('replaceAll=true 才替换全部', async () => {
    write('a.ts', 'let x = 1\nlet x = 1\n')
    const r = await fs.edit({ path: 'a.ts', oldText: 'let x = 1', newText: 'let x = 2', replaceAll: true })
    expect(r.applied).toBe(2)
    expect((await fs.read('a.ts')).lines.map((l) => l.text)).toEqual(['let x = 2', 'let x = 2'])
  })

  it('多行替换的 hunks 行区间正确', async () => {
    write('a.ts', 'l1\nl2\nl3\nl4\n')
    const r = await fs.edit({ path: 'a.ts', oldText: 'l2\nl3', newText: 'X' })
    expect(r.hunks[0]).toMatchObject({ start: 2, end: 3, oldLines: ['l2', 'l3'], newLines: ['X'] })
  })

  it('oldText 为空 → 报错（空串会匹配到每一处）', async () => {
    write('a.ts', 'x')
    await expect(fs.edit({ path: 'a.ts', oldText: '', newText: 'y' })).rejects.toMatchObject({
      code: 'ET-INVALID_ARGS',
    })
  })
})

describe('glob / grep：截断必须显式标注', () => {
  it('glob 按 maxResults 截断，truncated 与 total 都如实给出', async () => {
    for (let i = 0; i < 5; i++) write(`src/f${i}.ts`, 'x')
    const r = await fs.glob('**/*.ts', { maxResults: 2 })
    expect(r.paths).toHaveLength(2)
    expect(r.truncated).toBe(true)
    // total 说的是"本来有多少"——只有它在，模型才能判断该不该收窄模式
    expect(r.total).toBe(5)
  })

  it('glob 不截断时 truncated=false', async () => {
    write('src/a.ts', 'x')
    const r = await fs.glob('**/*.ts')
    expect(r).toMatchObject({ truncated: false, total: 1 })
  })

  it('grep 给出 path/line/column/text', async () => {
    write('src/a.ts', 'const a = 1\nconst b = 2\n')
    const r = await fs.grep('const b')
    expect(r.matches).toEqual([{ path: 'src/a.ts', line: 2, column: 1, text: 'const b = 2' }])
  })

  it('grep 的 column 是 1 起', async () => {
    write('a.ts', 'xxTARGET')
    const r = await fs.grep('TARGET')
    expect(r.matches[0]!.column).toBe(3)
  })

  it('grep 截断时 truncated=true，但 total 仍是真实命中数', async () => {
    write('a.ts', 'hit\nhit\nhit\n')
    const r = await fs.grep('hit', { maxResults: 1 })
    expect(r.matches).toHaveLength(1)
    expect(r.truncated).toBe(true)
    expect(r.total).toBe(3)
  })

  it('grep 非法正则 → ET-INVALID_ARGS（不是崩）', async () => {
    write('a.ts', 'x')
    await expect(fs.grep('([')).rejects.toMatchObject({ code: 'ET-INVALID_ARGS' })
  })

  it('grep 跳过 node_modules（否则一项就吃掉全部预算）', async () => {
    write('node_modules/pkg/index.js', 'NEEDLE')
    write('src/a.ts', 'NEEDLE')
    const r = await fs.grep('NEEDLE')
    expect(r.matches.map((m) => m.path)).toEqual(['src/a.ts'])
  })

  it('grep 遇二进制/读不动的文件跳过，不毁掉整次搜索', async () => {
    write('a.ts', 'NEEDLE')
    // 写一个含非法 UTF-8 的"二进制"
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const r = await fs.grep('NEEDLE')
    expect(r.matches.map((m) => m.path)).toEqual(['a.ts'])
  })

  it('include 过滤生效', async () => {
    write('a.ts', 'NEEDLE')
    write('b.md', 'NEEDLE')
    const r = await fs.grep('NEEDLE', { include: '*.md' })
    expect(r.matches.map((m) => m.path)).toEqual(['b.md'])
  })
})

describe('stat / readdir', () => {
  it('stat 分辨 file / dir', async () => {
    write('a.ts', 'x')
    mkdirSync(join(root, 'sub'))
    expect((await fs.stat('a.ts')).kind).toBe('file')
    expect((await fs.stat('sub')).kind).toBe('dir')
  })

  it('readdir 排序返回', async () => {
    write('d/b.ts', 'x')
    write('d/a.ts', 'x')
    expect(await fs.readdir('d')).toEqual(['a.ts', 'b.ts'])
  })
})

describe('路径：相对工作区解析成绝对路径', () => {
  it('`..` 会被解析掉（上层仍须再做边界判定）', async () => {
    const r = await fs.write('../outside.txt', 'x')
    // fs-local 只负责解析，**不负责拦**——"算不算工作区内"是接口层的事（20 §6.1）
    expect(r.path).toBe(normalizePath(join(root, '..', 'outside.txt')))
    rmSync(join(root, '..', 'outside.txt'), { force: true })
  })
})
