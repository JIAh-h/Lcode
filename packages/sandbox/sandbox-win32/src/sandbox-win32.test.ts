import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import type { SandboxWrapResult } from '@lcode/sandbox'
import type { SandboxHelperSubprocess } from './index.ts'
import { createWindowsSandbox, createWindowsSandboxBridge } from './index.ts'

const policy = { mode: 'workspace-write' as const, workspaceRoot: 'C:/repo/lcode' }

describe('WindowsSandboxProvider', () => {
  it('没有原生桥时如实降级，不把普通 Node 子进程当成 AppContainer', async () => {
    const sandbox = createWindowsSandbox({ platform: 'win32' })
    const status = await sandbox.status()

    expect(status).toMatchObject({ available: false, degraded: true, mechanism: 'none' })
    expect(status.reason).toContain('桥尚未安装')
    expect(status.capabilities.boundaries.filesystem.state).toBe('unavailable')
    await expect(sandbox.wrap(['cmd.exe', '/c', 'echo ok'], policy)).resolves.toMatchObject({ enforced: false })
  })

  it('只有 AppContainer、ACL、网络能力和 Job Object 全部成立才报告 enforced', async () => {
    const sandbox = createWindowsSandbox({
      platform: 'win32',
      bridge: {
        probe: async () => ({ appContainer: true, workspaceAcl: true, networkPolicy: true, jobObject: true }),
        wrap: async (argv): Promise<SandboxWrapResult> => ({ enforced: true, wrappedArgv: ['lcode-win32-sandbox.exe', '--', ...argv] }),
      },
    })

    const status = await sandbox.status()
    expect(status).toMatchObject({ available: true, degraded: false, mechanism: 'AppContainer + Job Object' })
    expect(Object.values(status.capabilities.boundaries).every((entry) => entry.state === 'enforced')).toBe(true)
    await expect(sandbox.wrap(['cmd.exe', '/c', 'echo ok'], policy)).resolves.toEqual({
      enforced: true,
      wrappedArgv: ['lcode-win32-sandbox.exe', '--', 'cmd.exe', '/c', 'echo ok'],
    })
  })

  it('桥在真正启动时失效就拒绝，而非使用未包装 argv', async () => {
    const sandbox = createWindowsSandbox({
      platform: 'win32',
      bridge: {
        probe: async () => ({ appContainer: true, workspaceAcl: true, networkPolicy: true, jobObject: true }),
        wrap: async () => ({ enforced: false, wrappedArgv: [], degradationReason: 'Job Object 创建失败' }),
      },
    })

    await sandbox.status()
    await expect(sandbox.wrap(['cmd.exe', '/c', 'echo should-not-run'], policy)).rejects.toMatchObject({
      code: 'EC-NOT_READY',
      userMessage: 'Windows 原生沙箱启动失败，已拒绝运行该命令。',
    })
  })

  it('非 Windows 环境永不宣称启用了 AppContainer', async () => {
    const status = await createWindowsSandbox({ platform: 'linux' }).status()
    expect(status).toMatchObject({ available: false, degraded: true, mechanism: 'none' })
    expect(status.reason).toContain('不是 Windows')
  })

  it('原生 helper 只在返回完整 JSON 自检后包装命令', async () => {
    const bridge = createWindowsSandboxBridge({
      subprocess: probeSubprocess(
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
      ),
      helperPaths: ['C:/lcode/lcode-sandbox-win32.exe'],
      workspaceRoot: 'C:/repo/lcode',
    })

    await expect(bridge.probe()).resolves.toEqual({ appContainer: true, workspaceAcl: true, networkPolicy: true, jobObject: true })
    await expect(bridge.wrap(['cmd.exe', '/c', 'echo ok'], policy)).resolves.toEqual({
      enforced: true,
      wrappedArgv: ['C:/lcode/lcode-sandbox-win32.exe', '--run', '--workspace', 'C:/repo/lcode', '--network', 'deny', '--', 'cmd.exe', '/c', 'echo ok'],
    })
  })

  it('策略明确允许网络时，将 allow 原样交给原生 helper，而不是静默沿用 deny', async () => {
    const bridge = createWindowsSandboxBridge({
      subprocess: probeSubprocess(
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
      ),
      helperPaths: ['C:/lcode/lcode-sandbox-win32.exe'],
      workspaceRoot: 'C:/repo/lcode',
    })
    await bridge.probe()
    await expect(bridge.wrap(['cmd.exe', '/c', 'echo ok'], { ...policy, allowNetwork: true })).resolves.toEqual({
      enforced: true,
      wrappedArgv: ['C:/lcode/lcode-sandbox-win32.exe', '--run', '--workspace', 'C:/repo/lcode', '--network', 'allow', '--', 'cmd.exe', '/c', 'echo ok'],
    })
  })

  it('wrapPty 与普通命令使用同一受约束 helper 包装，而非返回原始 shell', async () => {
    const bridge = createWindowsSandboxBridge({
      subprocess: probeSubprocess(
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
      ),
      helperPaths: ['C:/lcode/lcode-sandbox-win32.exe'],
      workspaceRoot: 'C:/repo/lcode',
    })
    await bridge.probe()
    await expect(bridge.wrapPty?.(['cmd.exe'], policy)).resolves.toEqual({
      enforced: true,
      wrappedArgv: ['C:/lcode/lcode-sandbox-win32.exe', '--run', '--workspace', 'C:/repo/lcode', '--network', 'deny', '--', 'cmd.exe'],
    })
  })

  it('首次工作区只有 ACL 未准备时，获批后的 helper 预检可以完成授权再包装', async () => {
    const bridge = createWindowsSandboxBridge({
      subprocess: probeSubprocess(
        '{"appContainer":true,"workspaceAcl":false,"networkPolicy":true,"jobObject":true,"reason":"ACL pending"}',
        '{"appContainer":true,"workspaceAcl":true,"networkPolicy":true,"jobObject":true}',
      ),
      helperPaths: ['C:/lcode/lcode-sandbox-win32.exe'],
      workspaceRoot: 'C:/repo/lcode',
    })
    const sandbox = createWindowsSandbox({ platform: 'win32', bridge })

    await expect(sandbox.status()).resolves.toMatchObject({ available: false, degraded: true })
    await expect(sandbox.wrap(['cmd.exe', '/c', 'echo ok'], policy)).resolves.toMatchObject({ enforced: true })
  })

  it('helper 没有可解析的自检结果时保持降级且不产生包装 argv', async () => {
    const bridge = createWindowsSandboxBridge({
      subprocess: probeSubprocess('not json'),
      helperPaths: ['C:/lcode/lcode-sandbox-win32.exe'],
      workspaceRoot: 'C:/repo/lcode',
    })

    await expect(bridge.probe()).resolves.toMatchObject({ appContainer: false, workspaceAcl: false, jobObject: false })
    await expect(bridge.wrap(['cmd.exe', '/c', 'echo ok'], policy)).resolves.toMatchObject({ enforced: false })
  })

  it('取消工作区信任时，bridge 只接受原生 helper 的结构化 ACL 撤销回执', async () => {
    const bridge = createWindowsSandboxBridge({
      subprocess: probeSubprocess('{"released":true}'),
      helperPaths: ['C:/lcode/lcode-sandbox-win32.exe'],
      workspaceRoot: 'C:/repo/lcode',
    })

    await expect(bridge.releaseWorkspace?.('C:/repo/lcode')).resolves.toEqual({ released: true })
  })

  it('原生 bridge 的 ACL 撤销失败会保留失败原因，不会伪装为已释放', async () => {
    const sandbox = createWindowsSandbox({
      platform: 'win32',
      bridge: {
        probe: async () => ({ appContainer: true, workspaceAcl: true, networkPolicy: true, jobObject: true }),
        wrap: async (argv): Promise<SandboxWrapResult> => ({ enforced: true, wrappedArgv: [...argv] }),
        releaseWorkspace: async () => {
          throw new Error('access denied')
        },
      },
    })

    await expect(sandbox.releaseWorkspace?.('C:/repo/lcode')).resolves.toEqual({
      released: false,
      reason: '撤销 Windows 工作区 ACL 失败：access denied',
    })
  })
})

function probeSubprocess(...outputs: string[]): SandboxHelperSubprocess {
  let index = 0
  return {
    async spawn() {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let resolveExit: ((value: { code: number | null; signal: string | null }) => void) | undefined
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve })
      setTimeout(() => {
        stdout.end(outputs[index++] ?? '')
        stderr.end()
        resolveExit?.({ code: 0, signal: null })
      }, 0)
      return {
        pid: 1,
        stdout,
        stderr,
        exited,
      }
    },
  }
}
