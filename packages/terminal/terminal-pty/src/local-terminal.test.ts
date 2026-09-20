import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalTerminalService } from './local-terminal.ts'

let root = ''
let terminals: LocalTerminalService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lcode-pty-'))
  terminals = new LocalTerminalService({ workspaceRoot: root, maxTerminals: 2, maxOutputBytes: 1024 })
})

afterEach(async () => {
  await terminals.dispose()
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function readUntil(terminalId: string, marker: string, sinceOffset = 0): Promise<{ readonly data: string; readonly offset: number }> {
  const deadline = Date.now() + 5_000
  let offset = sinceOffset
  let data = ''
  while (Date.now() < deadline) {
    const result = await terminals.read({ ownerAgentId: 'agent-a', terminalId, sinceOffset: offset })
    data += result.data
    offset = result.offset
    if (data.includes(marker)) return { data, offset }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`终端未输出标记：${marker}`)
}

function lineEnd(): string {
  return process.platform === 'win32' ? '\r\n' : '\n'
}

describe('LocalTerminalService', () => {
  it('同时维护多个 PTY，输出可以从 offset 断点续读', async () => {
    const first = await terminals.open({ ownerAgentId: 'agent-a' })
    const second = await terminals.open({ ownerAgentId: 'agent-a' })
    await terminals.send({ ownerAgentId: 'agent-a', terminalId: first.terminalId, data: `echo P3_FIRST${lineEnd()}` })
    await terminals.send({ ownerAgentId: 'agent-a', terminalId: second.terminalId, data: `echo P3_SECOND${lineEnd()}` })

    const firstRead = await readUntil(first.terminalId, 'P3_FIRST')
    const secondRead = await readUntil(second.terminalId, 'P3_SECOND')
    expect(firstRead.data).toContain('P3_FIRST')
    expect(secondRead.data).toContain('P3_SECOND')

    await terminals.send({ ownerAgentId: 'agent-a', terminalId: first.terminalId, data: `echo P3_AFTER_OFFSET${lineEnd()}` })
    const resumed = await readUntil(first.terminalId, 'P3_AFTER_OFFSET', firstRead.offset)
    expect(resumed.data).toContain('P3_AFTER_OFFSET')
    // 前一个命令的回显可能在 marker 被观察到后才到达；关键是已消费的 bytes
    // 不会在下一次使用返回 offset 的 read 中重放。
    const drained = await terminals.read({ ownerAgentId: 'agent-a', terminalId: first.terminalId, sinceOffset: resumed.offset })
    expect(drained.data).toBe('')
  })

  it('跨 owner 的访问一律被拒绝，列表只返回自己的终端', async () => {
    const opened = await terminals.open({ ownerAgentId: 'agent-a' })
    await expect(terminals.read({ ownerAgentId: 'agent-b', terminalId: opened.terminalId })).rejects.toMatchObject({
      code: 'EP-DENIED_CROSS_SCOPE',
    })
    await expect(
      terminals.send({ ownerAgentId: 'agent-b', terminalId: opened.terminalId, data: `echo forbidden${lineEnd()}` }),
    ).rejects.toMatchObject({ code: 'EP-DENIED_CROSS_SCOPE' })
    expect(terminals.list({ ownerAgentId: 'agent-b' })).toEqual([])
    expect(terminals.list({ ownerAgentId: 'agent-a' })).toHaveLength(1)
  })

  it('达到上限时失败，close 保持幂等', async () => {
    const first = await terminals.open({ ownerAgentId: 'agent-a' })
    await terminals.open({ ownerAgentId: 'agent-a' })
    await expect(terminals.open({ ownerAgentId: 'agent-a' })).rejects.toMatchObject({ code: 'EJ-LIMIT_REACHED' })
    await expect(terminals.close({ ownerAgentId: 'agent-a', terminalId: first.terminalId })).resolves.toEqual({ closed: true })
    await expect(terminals.close({ ownerAgentId: 'agent-a', terminalId: first.terminalId })).resolves.toEqual({ closed: true })
  })

  it('signal 返回可重试的终端控制确认', async () => {
    const opened = await terminals.open({ ownerAgentId: 'agent-a' })
    await expect(terminals.signal({ ownerAgentId: 'agent-a', terminalId: opened.terminalId, signal: 'SIGINT' })).resolves.toEqual({
      sent: true,
    })
  })

  it('owner 释放时只关闭自己的终端', async () => {
    const mine = await terminals.open({ ownerAgentId: 'agent-a' })
    await terminals.open({ ownerAgentId: 'agent-b' })
    await terminals.disposeOwner('agent-a')
    expect(terminals.list({ ownerAgentId: 'agent-a' })).toEqual([])
    expect(terminals.list({ ownerAgentId: 'agent-b' })).toHaveLength(1)
    await expect(terminals.read({ ownerAgentId: 'agent-a', terminalId: mine.terminalId })).rejects.toMatchObject({ code: 'EC-NOT_FOUND' })
  })

  it('系统级 Provider 未实现受控 PTY 时拒绝打开，不能回退为 node-pty', async () => {
    const guarded = new LocalTerminalService({
      workspaceRoot: root,
      sandbox: { status: async () => ({ degraded: false }) },
    })
    await expect(guarded.open({ ownerAgentId: 'agent-a' })).rejects.toMatchObject({
      code: 'EC-NOT_READY',
      userMessage: '当前安全环境尚不支持受控交互终端，已拒绝打开终端。',
    })
  })

  it('系统级 Provider 提供 wrapPty 时，PTY 宿主只能启动包装后的 helper argv', async () => {
    const launches: unknown[] = []
    const guarded = new LocalTerminalService({
      workspaceRoot: root,
      sandbox: {
        status: async () => ({ degraded: false }),
        wrapPty: async () => ({ enforced: true, wrappedArgv: ['lcode-sandbox-win32.exe', '--run', '--', 'cmd.exe'] }),
      },
      subprocess: {
        spawn: async () => { throw new Error('not used') },
        spawnPty: async (opts) => {
          launches.push(opts)
          return { pid: 1, write: () => undefined, kill: () => undefined, onData: () => undefined, onExit: () => undefined }
        },
      },
    })
    await guarded.open({ ownerAgentId: 'agent-a' })
    expect(launches).toEqual([expect.objectContaining({ shell: 'lcode-sandbox-win32.exe', args: ['--run', '--', 'cmd.exe'] })])
    await guarded.dispose()
  })

  it('首次准备工作区 ACL 的降级状态也只能走受控 helper，不能裸启 shell', async () => {
    const launches: unknown[] = []
    const guarded = new LocalTerminalService({
      workspaceRoot: root,
      sandbox: {
        status: async () => ({ degraded: true, reason: '工作区 ACL 尚未准备' }),
        wrapPty: async () => ({ enforced: true, wrappedArgv: ['lcode-sandbox-win32.exe', '--run', '--', 'cmd.exe'] }),
      },
      subprocess: {
        spawn: async () => { throw new Error('not used') },
        spawnPty: async (opts) => {
          launches.push(opts)
          return { pid: 1, write: () => undefined, kill: () => undefined, onData: () => undefined, onExit: () => undefined }
        },
      },
    })
    await guarded.open({ ownerAgentId: 'agent-a' })
    expect(launches).toEqual([expect.objectContaining({ shell: 'lcode-sandbox-win32.exe', args: ['--run', '--', 'cmd.exe'] })])
    await guarded.dispose()
  })

  it('无法读取系统级沙箱状态时拒绝打开终端', async () => {
    const guarded = new LocalTerminalService({
      workspaceRoot: root,
      sandbox: { status: async () => { throw new Error('bridge unavailable') } },
    })
    await expect(guarded.open({ ownerAgentId: 'agent-a' })).rejects.toMatchObject({ code: 'EC-NOT_READY' })
  })
})
