import { describe, expect, it } from 'vitest'
import { createMacosSandbox, createSeatbeltProfile, type MacosSandboxBridge } from './index.ts'

const policy = { mode: 'workspace-write' as const, workspaceRoot: '/repo/app', writableRoots: ['/tmp/lcode'], allowNetwork: false }

describe('sandbox-macos', () => {
  it('非 macOS 没有 sandbox-exec 时明确降级', async () => {
    const sandbox = createMacosSandbox({ platform: 'win32', sandboxExecPath: 'Z:/missing/sandbox-exec' })
    const status = await sandbox.status()
    expect(status).toMatchObject({ available: false, degraded: true, mechanism: 'none' })
    expect((await sandbox.wrap(['node', 'task.mjs'], policy)).enforced).toBe(false)
  })

  it('真实桥接证明后包装 argv，并保留 profile 与网络策略', async () => {
    const bridge: MacosSandboxBridge = {
      async probe() { return { sandboxExec: true, profileSyntax: true } },
      async wrap(argv, input) { return { enforced: true, wrappedArgv: ['sandbox-exec', '-p', createSeatbeltProfile(input), '--', ...argv] } },
    }
    const sandbox = createMacosSandbox({ platform: 'darwin', bridge })
    expect((await sandbox.status()).capabilities.boundaries.filesystem.state).toBe('enforced')
    const wrapped = await sandbox.wrap(['node', 'task.mjs'], policy)
    expect(wrapped.enforced).toBe(true)
    expect(wrapped.wrappedArgv.slice(0, 4)).toEqual(['sandbox-exec', '-p', expect.any(String), '--'])
    expect(wrapped.wrappedArgv.join(' ')).toContain('/repo/app')
    expect(wrapped.wrappedArgv.join(' ')).not.toContain('network-outbound')
  })
})

describe('sandbox-macos 档位与 PTY', () => {
  it('完全访问档不包装 argv（按定义不设文件/网络边界）', async () => {
    const sandbox = createMacosSandbox({ platform: 'darwin', sandboxExecPath: process.execPath })
    await expect(sandbox.wrap(['node', 'task.mjs'], { ...policy, mode: 'danger-full-access' })).resolves.toEqual({
      enforced: true,
      mechanism: 'none (full access)',
      wrappedArgv: ['node', 'task.mjs'],
    })
  })

  it('PTY 与普通命令共用 sandbox-exec 包装，交互终端不再裸启', async () => {
    const sandbox = createMacosSandbox({ platform: 'darwin', sandboxExecPath: process.execPath })
    const wrapped = await sandbox.wrapPty?.(['/bin/zsh'], policy)
    expect(wrapped?.enforced).toBe(true)
    expect(wrapped?.wrappedArgv[0]).toBe(process.execPath)
    expect(wrapped?.wrappedArgv).toContain('-p')
    expect(wrapped?.wrappedArgv.slice(-2)).toEqual(['--', '/bin/zsh'])
  })

  it('只读档 profile 不包含 file-write 规则', async () => {
    const profile = createSeatbeltProfile({ ...policy, mode: 'read-only' })
    expect(profile).not.toContain('file-write*')
  })
})
