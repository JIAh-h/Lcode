import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalShell } from './shell-local.ts'
import { createLocalJobs } from '@lcode/jobs-local'
import type { JobsService } from '@lcode/jobs'
import type { ShellService } from '@lcode/shell'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import type { SpawnOpts, SpawnedProcess, SubprocessService } from '@lcode/subprocess'

/**
 * `shell-local` 验收（04 §5.3 的 M-TOOL-04/05）。
 *
 * 盯三件事：
 * - 退出码/信号/超时**如实**返回（`exitCode !== 0` 是成功值，不是错误——08 §2.3）
 * - 超时**真的把进程树杀掉**（不是只 kill 顶层）
 * - 沙箱降级**如实上报**（`enforced: false`），不假装有约束
 */

let root = ''
let shell: ShellService
let jobs: JobsService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcode-sh-'))
  jobs = createLocalJobs()
  shell = createLocalShell({ workspaceRoot: root, jobs }).shell
})

afterEach(async () => {
  await jobs.dispose()
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

const node = process.execPath

describe('前台执行：退出码与输出', () => {
  it('成功命令：exitCode 0，stdout 有内容', async () => {
    const r = await shell.run([node, '-e', 'process.stdout.write("hello")'])
    expect(r).toMatchObject({
      kind: 'foreground',
      exitCode: 0,
      timedOut: false,
      aborted: false,
    })
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.stdout).toBe('hello')
    expect(r.stderr).toBe('')
  })

  it('**非零退出码是成功值，不抛错**（grep 没匹配到会返回 1）', async () => {
    const r = await shell.run([node, '-e', 'process.exit(1)'])
    expect(r).toMatchObject({ kind: 'foreground', exitCode: 1 })
  })

  it('stderr 与 stdout 分开收集', async () => {
    const r = await shell.run([node, '-e', 'process.stdout.write("out");process.stderr.write("err")'])
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.stdout).toBe('out')
    expect(r.stderr).toBe('err')
  })

  it('命令不存在 → exitCode -1（不是 0，0 会被读成成功）', async () => {
    const r = await shell.run(['definitely-not-a-real-binary-xyz'])
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.exitCode).toBe(-1)
  })
})

describe('超时：必须杀掉整个进程树', () => {
  it('超时 → timedOut=true，且进程真的停了（不是只标个标记）', async () => {
    const started = Date.now()
    // 子进程挂 10s；超时 300ms 就该被杀掉。若只 kill 顶层而不杀树，
    // 这个 node 会继续跑到 10s —— 那会让这个断言"看起来通过"却留了孤儿。
    const r = await shell.run([node, '-e', 'setTimeout(()=>{},10000)'], {
      timeoutMs: 300,
    })
    const elapsed = Date.now() - started
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.timedOut).toBe(true)
    // 远小于 10s 说明真被杀了
    expect(elapsed).toBeLessThan(5000)
  })

  it('结果里带上本次生效的 timeoutMs（模型据此判断是不是自己给短了）', async () => {
    const r = await shell.run([node, '-e', '0'], { timeoutMs: 1234 })
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.timeoutMs).toBe(1234)
  })
})

describe('取消：aborted 与 timedOut 是两个不同的事实', () => {
  it('外部 abort → aborted=true', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 200)
    const r = await shell.run([node, '-e', 'setTimeout(()=>{},10000)'], {
      signal: ctrl.signal,
      timeoutMs: 10000,
    })
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.aborted).toBe(true)
    // 被取消不是因为超时——两个字段分开正是为了让上层能区分
    expect(r.timedOut).toBe(false)
  })
})

describe('沙箱：降级必须如实上报', () => {
  it('没装沙箱 → enforced=false（不假装有约束）', async () => {
    const r = await shell.run([node, '-e', '0'])
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(r.sandbox.enforced).toBe(false)
  })

  it('沙箱包装器生效时 enforced=true，且**真正用的是包装后的 argv**', async () => {
    const wrapped: string[][] = []
    const s = createLocalShell({
      workspaceRoot: root,
      // 一个"假沙箱"：在 argv 前面插一段忽略参数的 node 脚本
      wrap: async (argv) => {
        wrapped.push([...argv])
        return {
          enforced: true,
          wrappedArgv: [node, '-e', 'process.stdout.write("sandboxed")', ...argv],
        }
      },
    }).shell
    const r = await s.run([node, '-e', 'process.stdout.write("raw")'])
    if (r.kind !== 'foreground') throw new Error('应为前台')
    expect(wrapped[0]).toEqual([node, '-e', 'process.stdout.write("raw")'])
    // 输出来自包装后的 argv，不是原始那份 —— 证明包装真的起作用了
    expect(r.stdout).toBe('sandboxed')
    expect(r.sandbox.enforced).toBe(true)
  })

  it('把执行 scope 交给包装器（供会话审计回写）', async () => {
    let seen: unknown
    const s = createLocalShell({
      workspaceRoot: root,
      wrap: async (argv, _policy, scope) => {
        seen = scope
        return { enforced: true, wrappedArgv: [...argv] }
      },
    }).shell
    await s.run([node, '-e', '0'], { scope: { sessionId: 'sess-1' } })
    expect(seen).toEqual({ sessionId: 'sess-1' })
  })
})

describe('执行 Provider', () => {
  it('Shell 把包装后的 argv 委托给可替换的 subprocess Provider', async () => {
    const local = createLocalSubprocess()
    const seen: SpawnOpts[] = []
    const subprocess: SubprocessService = {
      async spawn(opts): Promise<SpawnedProcess> {
        seen.push(opts)
        return await local.spawn(opts)
      },
    }
    const s = createLocalShell({ workspaceRoot: root, subprocess }).shell
    const result = await s.run([node, '-e', 'process.stdout.write("provider")'])
    if (result.kind !== 'foreground') throw new Error('应为前台')
    expect(result.stdout).toBe('provider')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.argv).toEqual([node, '-e', 'process.stdout.write("provider")'])
  })
})

describe('后台作业', () => {
  it('返回 jobId 并且**不阻塞**（毫秒级返回）', async () => {
    const started = Date.now()
    const r = await shell.run([node, '-e', 'setTimeout(()=>{},5000)'], {
      runInBackground: true,
    })
    const elapsed = Date.now() - started
    expect(r).toMatchObject({ kind: 'background' })
    expect(elapsed).toBeLessThan(2000)
    if (r.kind !== 'background') throw new Error('应为后台')
    expect(jobs.list()).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: r.jobId, status: 'running' })]))
    await jobs.kill({ jobId: r.jobId })
  })

  it('没装配 jobs 时**报错**，而不是假装在跑', async () => {
    const s = createLocalShell({ workspaceRoot: root }).shell
    await expect(s.run([node, '-e', '0'], { runInBackground: true })).rejects.toMatchObject({
      code: 'EC-NOT_READY',
    })
  })

  it('外层调用取消不会停止已经发布的作业', async () => {
    const outer = new AbortController()
    const r = await shell.run([node, '-e', 'setTimeout(()=>{},10000)'], {
      runInBackground: true,
      signal: outer.signal,
      ownerAgentId: 'agent-a',
    })
    if (r.kind !== 'background') throw new Error('应为后台')
    outer.abort()
    // 给外层 abort 一个事件循环；后台必须仍由 jobs 自己的 signal 管理。
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(jobs.status({ jobId: r.jobId, ownerAgentId: 'agent-a' }).status).toBe('running')
    await jobs.kill({ jobId: r.jobId, ownerAgentId: 'agent-a' })
  })
})

describe('边界', () => {
  it('空 argv → ET-INVALID_ARGS', async () => {
    await expect(shell.run([])).rejects.toMatchObject({
      code: 'ET-INVALID_ARGS',
    })
  })

  it('cwd 生效', async () => {
    const r = await shell.run([node, '-e', 'process.stdout.write(process.cwd())'], { cwd: root })
    if (r.kind !== 'foreground') throw new Error('应为前台')
    // Windows 路径大小写不敏感，统一小写比较
    expect(r.stdout.toLowerCase().replace(/\\/g, '/')).toContain(root.toLowerCase().replace(/\\/g, '/').slice(-12))
  })
})
