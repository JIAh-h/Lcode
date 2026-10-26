import { existsSync } from 'node:fs'
import type { PlatformSandboxCapabilities, ResolvedSandboxPolicy, SandboxReleaseResult, SandboxService, SandboxStatus, SandboxWrapResult } from '@lcode/sandbox'

export interface MacosSandboxProbe {
  readonly sandboxExec: boolean
  readonly profileSyntax: boolean
  readonly reason?: string | undefined
}

export interface MacosSandboxBridge {
  probe(): Promise<MacosSandboxProbe>
  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  wrapPty?(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  releaseWorkspace?(workspace: string): Promise<SandboxReleaseResult>
}

export interface MacosSandboxOptions {
  readonly bridge?: MacosSandboxBridge | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly sandboxExecPath?: string | undefined
}

const MECHANISM = 'Seatbelt (sandbox-exec)'

/** macOS Provider：按回合生成 SBPL，直接以 argv 调用 sandbox-exec，不经过 shell。 */
export function createMacosSandbox(options: MacosSandboxOptions = {}): SandboxService {
  const platform = options.platform ?? process.platform
  const path = options.sandboxExecPath ?? '/usr/bin/sandbox-exec'
  let lastProbe: MacosSandboxProbe | undefined
  const probe = async (): Promise<MacosSandboxProbe> => {
    if (platform !== 'darwin') return { sandboxExec: false, profileSyntax: false, reason: '当前不是 macOS，不能启用 Seatbelt。' }
    if (options.bridge !== undefined) return options.bridge.probe()
    return existsSync(path) ? { sandboxExec: true, profileSyntax: true } : { sandboxExec: false, profileSyntax: false, reason: `未找到 macOS sandbox-exec：${path}` }
  }
  const status = async (): Promise<SandboxStatus> => {
    lastProbe = await safeProbe(probe)
    const enforced = isEnforced(lastProbe)
    const reason = enforced ? undefined : lastProbe.reason ?? 'macOS Seatbelt 未通过自检。'
    return {
      available: enforced,
      mechanism: enforced ? MECHANISM : 'none',
      knownEscapeSurfaces: enforced ? ['sandbox-exec 已废弃，需随 macOS 版本持续回归'] : ['文件系统（无约束）', '网络（无约束）', '进程（无约束）'],
      degraded: !enforced,
      ...(reason === undefined ? {} : { reason }),
      providerAvailable: isEnforced(lastProbe),
      capabilities: capabilities(enforced, reason),
    }
  }
  const wrap = async (argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult> => {
    // 完全访问按定义不设文件/网络边界：不包装，也不假装有沙箱。
    if (policy.mode === 'danger-full-access') return { enforced: true, mechanism: 'none (full access)', wrappedArgv: [...argv] }
    const current = lastProbe ?? await safeProbe(probe)
    lastProbe = current
    if (!isEnforced(current)) return { enforced: false, wrappedArgv: [...argv], degradationReason: current.reason ?? 'macOS Seatbelt 未通过自检。' }
    if (options.bridge !== undefined) return requireEnforced(await options.bridge.wrap(argv, policy), 'macOS 原生桥')
    const profile = createSeatbeltProfile(policy)
    return { enforced: true, mechanism: MECHANISM, wrappedArgv: [path, '-p', profile, '--', ...argv], profile }
  }
  return {
    status,
    wrap,
    // PTY 与普通命令使用同一 SBPL 包装：node-pty 的 shell 就是 sandbox-exec，
    // 交互终端的 stdin/stdout 仍连着 pty。
    async wrapPty(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult> {
      if (options.bridge?.wrapPty !== undefined) {
        return requireEnforced(await options.bridge.wrapPty(argv, policy), 'macOS 原生 PTY 桥')
      }
      return wrap(argv, policy)
    },
    async releaseWorkspace(workspace) {
      if (options.bridge?.releaseWorkspace === undefined) return { released: true, reason: `Seatbelt 不持久化工作区 ACL，无需撤销：${workspace}` }
      return options.bridge.releaseWorkspace(workspace)
    },
  }
}

export function createSeatbeltProfile(policy: ResolvedSandboxPolicy): string {
  const roots = [policy.workspaceRoot, ...(policy.writableRoots ?? [])]
  const readRules = roots.map((root) => `(allow file-read* (subpath ${quote(root)}))`).join('\n')
  const writeRules = policy.mode === 'read-only' ? '' : roots.map((root) => `(allow file-write* (subpath ${quote(root)}))`).join('\n')
  const network = policy.allowNetwork === true ? '(allow network-outbound)' : ''
  return [
    '(version 1)', '(deny default)', '(allow process*)', '(allow sysctl-read)',
    '(allow file-read* (subpath "/usr"))', '(allow file-read* (subpath "/System"))', '(allow file-read* (subpath "/Library"))',
    readRules, writeRules, network,
  ].filter(Boolean).join('\n')
}

function quote(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` }
function isEnforced(probe: MacosSandboxProbe): boolean { return probe.sandboxExec && probe.profileSyntax }
function capabilities(enforced: boolean, reason: string | undefined): PlatformSandboxCapabilities {
  const state = enforced ? 'enforced' as const : 'unavailable' as const
  const message = reason ?? 'Seatbelt profile 已由 sandbox-exec 应用。'
  const boundary = { state, plannedMechanism: MECHANISM, message }
  return { platform: 'darwin', mechanism: enforced ? MECHANISM : 'none', boundaries: { filesystem: boundary, network: boundary, spawn: boundary }, reason: message }
}
async function safeProbe(fn: () => Promise<MacosSandboxProbe>): Promise<MacosSandboxProbe> {
  try { return await fn() } catch (cause) { return { sandboxExec: false, profileSyntax: false, reason: `macOS Seatbelt 自检失败：${cause instanceof Error ? cause.message : String(cause)}` } }
}
function requireEnforced(result: SandboxWrapResult, name: string): SandboxWrapResult {
  if (!result.enforced || result.wrappedArgv.length === 0) throw new Error(`${name} 未返回受约束的启动命令：${result.degradationReason ?? 'unknown'}`)
  return { ...result, wrappedArgv: [...result.wrappedArgv] }
}
