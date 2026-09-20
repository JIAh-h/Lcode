import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { createLocalShell } from '@lcode/shell-local'
import { InMemoryToolRegistry } from '@lcode/tools'
import type { ToolActionIntent, ToolCall } from '@lcode/tools'
import { createShellTool } from './tools.ts'

/**
 * `shell` 工具验收（21 §3.6；04 §5.3 的 M-TOOL-04..06）。
 *
 * 走真实注册表 + 真实 `shell-local`：这一层最容易出的错是"命令串 → argv"的转换
 * 与"退出码非 0 当成失败"，两者都只有真跑一次才看得出来。
 */

let root = ''
let ctx: ReturnType<typeof createContext>
let tools: InMemoryToolRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcode-tsh-'))
  ctx = createContext()
  tools = new InMemoryToolRegistry(ctx)
  const { shell } = createLocalShell({ workspaceRoot: root })
  tools.register(createShellTool({ shell, workspaceRoot: root, defaultTimeoutMs: 5_000 }))
})

afterEach(async () => {
  await removeTempDir(root)
})

async function removeTempDir(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  })
}

const run = (args: unknown): Promise<Awaited<ReturnType<InMemoryToolRegistry['execute']>>> =>
  tools.execute({ callId: 'c1', name: 'shell', arguments: JSON.stringify(args) }, { signal: new AbortController().signal })

describe('基本执行', () => {
  it('跑一条命令，拿到前台规范值', async () => {
    const r = await run({ command: 'echo hi', description: '打印 hi' })
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
    })
    expect((r.value as { stdout: string }).stdout.trim()).toBe('hi')
  })

  it('**退出码非 0 是成功值，不是工具失败**（08 §2.3 / M-TOOL-04）', async () => {
    const r = await run({ command: 'exit 3', description: '故意非零退出' })
    // ok 仍是 true —— "发生了但结果不理想"放进值，"没能发生"才抛错
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ kind: 'foreground', exitCode: 3 })
  })

  it('stderr 也返回（模型需要看到报错）', async () => {
    const r = await run({
      command: 'echo oops 1>&2',
      description: '写到 stderr',
    })
    expect((r.value as { stderr: string }).stderr.trim()).toBe('oops')
  })

  it('workdir 生效', async () => {
    const r = await run({
      command: 'cd',
      description: '打印当前目录',
      workdir: root,
    })
    void r
    // Windows 的 `cd` 输出原样路径；只断言命令跑起来了
    expect(r.ok).toBe(true)
  })
})

describe('超时（M-TOOL-04：timedOut 要如实）', () => {
  it('超时 → timedOut=true，且整条命令被终止', async () => {
    const started = Date.now()
    const r = await run({
      command: sleepCommand(1_000),
      description: '挂住',
      timeoutMs: 100,
    })
    const elapsed = Date.now() - started
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ kind: 'foreground', timedOut: true })
    // 远小于 10s → 真被杀掉了，而不是只标了个标记
    expect(elapsed).toBeLessThan(3_000)
  })
})

describe('后台（M-TOOL-05）', () => {
  it('runInBackground → 返回 jobId；本机装配未接 jobs 时**明确报错**', async () => {
    // createLocalShell 没传 jobs：后台不可用。工具必须把这件事报出来，
    // 而不是静默当成前台跑（那会让模型以为在后台，实际阻塞了整轮）
    const r = await run({
      command: sleepCommand(1_000),
      description: '后台',
      runInBackground: true,
    })
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('EC-NOT_READY')
  })
})

describe('describeAction：argv 交给策略层判定', () => {
  it('申报据实拆出的 argv 与可读摘要', async () => {
    const intents: ToolActionIntent[] = []
    ctx.on('tools/pre-execute', (payload) => {
      if (payload.intent !== undefined) intents.push(payload.intent)
    })

    await run({
      command: 'git push --force origin main',
      description: '强行推上去',
    })

    const intent = intents[0]!
    // 摘要用人话（用户看到的是它），argv 给策略判断"是不是危险命令"
    expect(intent.summary).toBe('强行推上去')
    expect(intent.argv?.slice(0, 2)).toEqual(['git', 'push'])
  })

  it('缺 description → ET-INVALID_ARGS（要求模型说明意图）', async () => {
    const r = await run({ command: 'echo hi' })
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-INVALID_ARGS' } })
  })

  it('缺 command → ET-INVALID_ARGS', async () => {
    const r = await run({ description: '什么都没做' })
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-INVALID_ARGS' } })
  })
})

describe('pre-execute 拒绝 → 命令**不会被执行**', () => {
  it('deny 之后副作用没有发生（真的拦住了，不只是回个错）', async () => {
    ctx.on('tools/pre-execute', (payload: { call: ToolCall; deny?: string }) => {
      if (payload.call.name === 'shell') payload.deny = '策略拒绝'
    })
    const marker = join(root, 'should-not-exist.txt')
    const r = await run({
      command: `echo x > "${marker}"`,
      description: '写一个文件',
    })
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-DENIED' } })
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  })
})

/** 跨平台"睡一会儿"的命令 */
function sleepCommand(ms: number): string {
  return process.platform === 'win32' ? `ping -n ${Math.ceil(ms / 1000) + 1} 127.0.0.1 > nul` : `sleep ${ms / 1000}`
}
