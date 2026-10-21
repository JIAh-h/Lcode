import { describe, expect, it } from 'vitest'
import { createLinuxSandbox, type LinuxSandboxBridge } from './index.ts'

const policy = { mode: 'workspace-write' as const, workspaceRoot: '/repo/app', allowNetwork: false }

describe('sandbox-linux', () => {
  it('没有 Linux native helper 时 fail-closed', async () => {
    const sandbox = createLinuxSandbox({ platform: 'linux' })
    expect((await sandbox.status()).capabilities.boundaries.filesystem.state).toBe('unavailable')
    expect((await sandbox.wrap(['node', 'task.mjs'], policy)).enforced).toBe(false)
  })

  it('只有 Landlock、seccomp、工作区和网络证明齐全才允许启动', async () => {
    const bridge: LinuxSandboxBridge = {
      async probe() { return { landlock: true, seccomp: true, workspacePolicy: true, networkPolicy: true } },
      async wrap(argv) { return { enforced: true, wrappedArgv: ['lcode-sandbox-linux', '--', ...argv] } },
    }
    const sandbox = createLinuxSandbox({ platform: 'linux', bridge })
    expect((await sandbox.status()).available).toBe(true)
    expect(await sandbox.wrap(['node', 'task.mjs'], policy)).toEqual({ enforced: true, wrappedArgv: ['lcode-sandbox-linux', '--', 'node', 'task.mjs'] })
  })
})
