import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryToolRegistry } from '@lcode/tools'
import type { ToolActionIntent, ToolCall, ToolDefinition } from '@lcode/tools'
import { createContext } from '@lcode/context'
import { createLocalFs } from '@lcode/fs-local'
import { createFsTools } from './tools.ts'

/**
 * 文件工具族验收（21 §3.1–3.5；04 §5.3 的 M-TOOL-01..03）。
 *
 * 走**真实的注册表**（而不是直接调工具函数）：`describeAction` → `pre-execute` →
 * 执行 这条链是工具契约的一部分，绕过它测就测不到"策略层能不能看到意图"。
 */

let root = ''
let ctx: ReturnType<typeof createContext>
let tools: InMemoryToolRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcode-tfs-'))
  ctx = createContext()
  tools = new InMemoryToolRegistry(ctx)
  for (const t of createFsTools({ fs: createLocalFs({ workspaceRoot: root }), workspaceRoot: root })) {
    tools.register(t as ToolDefinition)
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const call = (name: string, args: unknown): ToolCall => ({ callId: 'c1', name, arguments: JSON.stringify(args) })
const run = (name: string, args: unknown): ReturnType<InMemoryToolRegistry['execute']> =>
  tools.execute(call(name, args), { signal: new AbortController().signal })

describe('工具清单', () => {
  it('注册了五个文件工具', () => {
    expect(tools.schemas().map((s) => s.name).sort()).toEqual(['edit', 'glob', 'grep', 'read', 'write'])
  })

  it('每个工具都有 description 与 inputSchema（模型靠它决定怎么调）', () => {
    for (const s of tools.schemas()) {
      expect(s.description.length, s.name).toBeGreaterThan(10)
      expect(s.inputSchema.type).toBe('object')
    }
  })
})

describe('read', () => {
  it('返回带行号的窗口', async () => {
    await run('write', { path: 'a.ts', content: 'l1\nl2\nl3\n' })
    const r = await run('read', { path: 'a.ts' })
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({
      offset: 1,
      totalLines: 3,
      truncated: false,
      lines: [
        { number: 1, text: 'l1' },
        { number: 2, text: 'l2' },
        { number: 3, text: 'l3' },
      ],
    })
  })

  it('缺 path → ET-INVALID_ARGS（结构化错误，会话继续）', async () => {
    const r = await run('read', {})
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-INVALID_ARGS' } })
  })

  it('参数不是合法 JSON → ET-INVALID_ARGS（不是崩）', async () => {
    const r = await tools.execute({ callId: 'c', name: 'read', arguments: '{坏' }, { signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-INVALID_ARGS' } })
  })

  it('未知工具名 → ET-UNKNOWN_TOOL，且不中断（M-TOOL-07）', async () => {
    const r = await run('definitely_not_a_tool', {})
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-UNKNOWN_TOOL' } })
  })
})

describe('describeAction：策略层拿得到意图', () => {
  it('read / write / edit 申报路径与读写模式', async () => {
    const seen: ToolActionIntent[] = []
    ctx.on('tools/pre-execute', (payload) => {
      if (payload.intent !== undefined) seen.push(payload.intent)
    })

    await run('write', { path: 'src/a.ts', content: 'x' })
    await run('read', { path: 'src/a.ts' })
    await run('edit', { path: 'src/a.ts', old: 'x', new: 'y' })

    expect(seen.map((i) => i.paths?.[0])).toEqual([
      { path: 'src/a.ts', mode: 'write' },
      { path: 'src/a.ts', mode: 'read' },
      { path: 'src/a.ts', mode: 'write' },
    ])
    // 摘要要人能看懂，不是 JSON dump
    expect(seen[0]!.summary).toBe('写入 src/a.ts')
  })

  it('glob / grep 不申报路径（只读、不返回文件内容，不该触发审批）', async () => {
    const intents: unknown[] = []
    ctx.on('tools/pre-execute', (payload: { intent?: unknown }) => {
      intents.push(payload.intent)
    })
    await run('glob', { pattern: '**/*.ts' })
    expect(intents).toEqual([undefined])
  })
})

describe('edit：不唯一时报错，且**告诉模型出现几次**', () => {
  it('唯一匹配成功', async () => {
    await run('write', { path: 'a.ts', content: 'const a = 1\n' })
    const r = await run('edit', { path: 'a.ts', old: 'const a = 1', new: 'const a = 42' })
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ applied: 1 })
  })

  it('多处匹配 → 失败，诊断里带上出现次数（模型据此补上下文）', async () => {
    await run('write', { path: 'a.ts', content: 'x\nx\nx\n' })
    const r = await run('edit', { path: 'a.ts', old: 'x', new: 'y' })
    expect(r.ok).toBe(false)
    // 次数在 diagnostic 里——模型看不到文件，这是它唯一的线索
    expect(JSON.stringify(r.meta)).toContain('3')
  })
})

describe('失败永不终结轮：一律是 result 不是异常（08 §4.4）', () => {
  it('读不存在的文件 → ok:false + 错误码，不抛', async () => {
    const r = await run('read', { path: 'nope.ts' })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('ET-ERROR')
  })
})

describe('pre-execute 可以拒掉（策略层的接缝）', () => {
  it('处理器填 deny → 工具不执行，返回 ET-DENIED', async () => {
    let executed = false
    tools.register({
      name: 'spy',
      description: '记账用',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        executed = true
        return { ran: true }
      },
    })
    // 只拒那个叫 spy 的工具，其余放行
    ctx.on('tools/pre-execute', (payload: { call: ToolCall; deny?: string }) => {
      if (payload.call.name === 'spy') payload.deny = '策略拒绝'
    })
    const r = await run('spy', {})
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-DENIED' } })
    // **没有执行**：拒绝必须真的拦住副作用，而不只是回一个错误
    expect(executed).toBe(false)
  })
})
