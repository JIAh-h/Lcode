import type { PlatformSandboxCapabilities, ResolvedSandboxPolicy, SandboxReleaseResult, SandboxService, SandboxStatus, SandboxWrapResult } from '@lcode/sandbox'

export interface LinuxSandboxProbe {
  readonly landlock: boolean
  readonly seccomp: boolean
  readonly workspacePolicy: boolean
  readonly networkPolicy: boolean
  readonly reason?: string | undefined
}

export interface LinuxSandboxBridge {
  probe(): Promise<LinuxSandboxProbe>
  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  wrapPty?(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  releaseWorkspace?(workspace: string): Promise<SandboxReleaseResult>
}

export interface LinuxSandboxOptions {
  readonly bridge?: LinuxSandboxBridge | undefined
  readonly platform?: NodeJS.Platform | undefined
}

const MECHANISM = 'Landlock + seccomp'

/** Linux Provider 只信任 native helper 返回的四项证明，不在 TypeScript 中模拟内核边界。 */
export function createLinuxSandbox(options: LinuxSandboxOptions = {}): SandboxService {
  const platform = options.platform ?? process.platform
  let lastProbe: LinuxSandboxProbe | undefined
  const probe = async (): Promise<LinuxSandboxProbe> => {
    if (platform !== 'linux') return { landlock: false, seccomp: false, workspacePolicy: false, networkPolicy: false, reason: '当前不是 Linux，不能启用 Landlock + seccomp。' }
    if (options.bridge === undefined) return { landlock: false, seccomp: false, workspacePolicy: false, networkPolicy: false, reason: 'Linux 原生沙箱 helper 尚未安装。' }
    return options.bridge.probe()
  }
  const status = async (): Promise<SandboxStatus> => {
    lastProbe = await safeProbe(probe)
    const enforced = isEnforced(lastProbe)
    const reason = enforced ? undefined : lastProbe.reason ?? missingReason(lastProbe)
    return {
      available: enforced,
      mechanism: enforced ? MECHANISM : 'none',
      knownEscapeSurfaces: enforced ? ['旧内核或过宽 seccomp 白名单需要持续回归'] : ['文件系统（无约束）', '网络（无约束）', '进程（无约束）'],
      degraded: !enforced,
      ...(reason === undefined ? {} : { reason }),
      providerAvailable: isEnforced(lastProbe),
      capabilities: capabilities(enforced, reason),
    }
  }
  return {
    status,
    async wrap(argv, policy) {
      if (policy.mode === 'danger-full-access') return { enforced: true, mechanism: 'none (full access)', wrappedArgv: [...argv] }
      const current = lastProbe ?? await safeProbe(probe)
      lastProbe = current
      if (!isEnforced(current) || options.bridge === undefined) return { enforced: false, wrappedArgv: [...argv], degradationReason: current.reason ?? missingReason(current) }
      const wrapped = await options.bridge.wrap(argv, policy)
      if (!wrapped.enforced || wrapped.wrappedArgv.length === 0) throw new Error(`Linux 原生沙箱 helper 未能包装命令：${wrapped.degradationReason ?? 'unknown'}`)
      return { ...wrapped, mechanism: wrapped.mechanism ?? MECHANISM, wrappedArgv: [...wrapped.wrappedArgv] }
    },
    ...(options.bridge?.wrapPty === undefined ? {} : { async wrapPty(argv: readonly string[], policy: ResolvedSandboxPolicy) {
      const result = await options.bridge!.wrapPty!(argv, policy)
      if (!result.enforced || result.wrappedArgv.length === 0) throw new Error(`Linux 原生 PTY 沙箱未能包装命令：${result.degradationReason ?? 'unknown'}`)
      return { ...result, wrappedArgv: [...result.wrappedArgv] }
    } }),
    async releaseWorkspace(workspace) {
      if (options.bridge?.releaseWorkspace === undefined) return { released: true, reason: `Landlock 规则随进程退出，无需撤销工作区 ACL：${workspace}` }
      return options.bridge.releaseWorkspace(workspace)
    },
  }
}

function isEnforced(probe: LinuxSandboxProbe): boolean { return probe.landlock && probe.seccomp && probe.workspacePolicy && probe.networkPolicy }
function missingReason(probe: LinuxSandboxProbe): string {
  const missing = [!probe.landlock && 'Landlock', !probe.seccomp && 'seccomp', !probe.workspacePolicy && '工作区规则', !probe.networkPolicy && '网络规则'].filter(Boolean)
  return `Linux 原生沙箱未完整生效：${missing.join('、')}。`
}
function capabilities(enforced: boolean, reason: string | undefined): PlatformSandboxCapabilities {
  const state = enforced ? 'enforced' as const : 'unavailable' as const
  const message = reason ?? 'Landlock 与 seccomp 已由原生 helper 应用。'
  const boundary = { state, plannedMechanism: MECHANISM, message }
  return { platform: 'linux', mechanism: enforced ? MECHANISM : 'none', boundaries: { filesystem: boundary, network: boundary, spawn: boundary }, reason: message }
}
async function safeProbe(fn: () => Promise<LinuxSandboxProbe>): Promise<LinuxSandboxProbe> {
  try { return await fn() } catch (cause) { return { landlock: false, seccomp: false, workspacePolicy: false, networkPolicy: false, reason: `Linux 原生沙箱自检失败：${cause instanceof Error ? cause.message : String(cause)}` } }
}
