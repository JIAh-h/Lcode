import type { PlatformSandboxCapabilities, ResolvedSandboxPolicy, SandboxReleaseResult, SandboxService, SandboxStatus, SandboxWrapResult } from '@lcode/sandbox'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/** 原生桥自检的最小证明。四项中缺任何一项，都不能把命令当作受保护执行。 */
export interface WindowsSandboxProbe {
  readonly appContainer: boolean
  readonly workspaceAcl: boolean
  readonly networkPolicy: boolean
  readonly jobObject: boolean
  readonly reason?: string | undefined
}

/**
 * Win32 原生桥。
 *
 * AppContainer 的扩展启动属性、SID ACL 与 Job Object 都是 Win32 API，不能由 Node 的
 * `child_process` 模拟。未来的 native helper/addon 只需实现这个小接口；Provider 不会
 * 因为桥接“看起来存在”就宣称受保护，必须由 probe 给出四项可验证事实。
 */
export interface WindowsSandboxBridge {
  probe(): Promise<WindowsSandboxProbe>
  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  wrapPty?(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  releaseWorkspace?(workspace: string): Promise<SandboxReleaseResult>
}

export interface WindowsSandboxOptions {
  /** 注入原生 helper/addon；省略时明确降级，不尝试伪造 AppContainer。 */
  readonly bridge?: WindowsSandboxBridge | undefined
  /** 仅供测试模拟非 Windows 平台；生产环境不应传入。 */
  readonly platform?: NodeJS.Platform | undefined
}

export interface WindowsSandboxBridgeOptions {
  /**
   * 统一进程 Provider 的最小消费协议；`@lcode/subprocess` 结构化满足它。
   * 桥接不直接依赖 Node 的 child_process，也不要求所有宿主携带完整 PTY 能力。
   */
  readonly subprocess: SandboxHelperSubprocess
  /** 开发态/便携包的原生 helper 路径。按顺序尝试，首个能自检的路径会被固定。 */
  readonly helperPaths?: readonly string[] | undefined
  /** 用来验证当前工作区 ACL 的根目录。 */
  readonly workspaceRoot: string
}

export interface SandboxHelperSubprocess {
  spawn(options: { readonly argv: readonly string[] }): Promise<{
    readonly stdout: NodeJS.ReadableStream
    readonly stderr: NodeJS.ReadableStream
    readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  }>
}

const MECHANISM = 'AppContainer + Job Object'

/**
 * 通过小型 Win32 helper 接入 OS 边界。
 *
 * helper 用一行 JSON 回答 probe；首次获批执行会先以 `--prepare` 授予工作区 ACL、
 * 验证所需网络 capability 并复检，实际命令才由 `--run --workspace ... --` 接管。
 * 它在目标进程退出前持续持有 Job Object，因此关闭 helper 会清理整个子进程树。
 */
export function createWindowsSandboxBridge(options: WindowsSandboxBridgeOptions): WindowsSandboxBridge {
  const paths = options.helperPaths ?? defaultHelperPaths()
  let helperPath: string | undefined

  return {
    async probe(): Promise<WindowsSandboxProbe> {
      for (const candidate of helperPath === undefined ? paths : [helperPath]) {
        const result = await invoke(options.subprocess, [candidate, '--probe', '--workspace', options.workspaceRoot])
        const parsed = parseProbe(result.stdout)
        if (parsed !== undefined) {
          helperPath = candidate
          return parsed
        }
      }
      return {
        appContainer: false,
        workspaceAcl: false,
        networkPolicy: false,
        jobObject: false,
        reason: '未找到可用的 Windows 原生沙箱 helper。请安装包含 lcode-sandbox-win32.exe 的桌面包。',
      }
    },
    async wrap(argv, policy): Promise<SandboxWrapResult> {
      const candidate = helperPath
      if (candidate === undefined) {
        return { enforced: false, wrappedArgv: [...argv], degradationReason: 'Windows 原生沙箱 helper 尚未通过自检。' }
      }
      const prepared = await invoke(options.subprocess, [
        candidate, '--prepare', '--workspace', policy.workspaceRoot,
        '--network', policy.allowNetwork === true ? 'allow' : 'deny',
        '--mode', policy.mode,
      ])
      const proof = parseProbe(prepared.stdout)
      const ready = proof === undefined
        ? false
        : policy.mode === 'danger-full-access'
          ? proof.jobObject
          : isEnforced(proof)
      if (!ready || proof === undefined) {
        return {
          enforced: false,
          wrappedArgv: [...argv],
          degradationReason: proof?.reason ?? (prepared.stderr.trim() || 'Windows 原生 helper 未能完成工作区预检。'),
        }
      }
      // helper 自己继承 Node 已设置好的 cwd / env；所以这里仅写 argv，不把环境变量
      // 或路径参数拼进 shell 字符串。
      return {
        enforced: true,
        mechanism: MECHANISM,
        wrappedArgv: [candidate, '--run', '--workspace', policy.workspaceRoot, '--network', policy.allowNetwork === true ? 'allow' : 'deny', '--mode', policy.mode, '--', ...argv],
      }
    },
    async wrapPty(argv, policy): Promise<SandboxWrapResult> {
      return this.wrap(argv, policy)
    },
    async releaseWorkspace(workspace): Promise<SandboxReleaseResult> {
      const candidates = helperPath === undefined ? paths : [helperPath]
      for (const candidate of candidates) {
        const result = await invoke(options.subprocess, [candidate, '--revoke', '--workspace', workspace])
        const parsed = parseRelease(result.stdout)
        if (parsed !== undefined) {
          helperPath = candidate
          return parsed
        }
      }
      return { released: false, reason: '未找到可用的 Windows 原生沙箱 helper，无法撤销 AppContainer ACL。' }
    },
  }
}

/**
 * Windows 沙箱 Provider。
 *
 * `bridge` 尚未安装时，这是比 `sandbox-local` 更具体的降级 Provider：它明确说明缺少哪类
 * 原生实现。桥接随后报错或返回未强制结果时，`wrap` 会拒绝启动，绝不回退为裸 argv。
 */
export function createWindowsSandbox(options: WindowsSandboxOptions = {}): SandboxService {
  const platform = options.platform ?? process.platform
  let lastProbe: WindowsSandboxProbe | undefined

  const probe = async (): Promise<WindowsSandboxProbe> => {
    if (platform !== 'win32') return { appContainer: false, workspaceAcl: false, networkPolicy: false, jobObject: false, reason: '当前不是 Windows，不能启用 AppContainer。' }
    if (options.bridge === undefined) {
      return {
        appContainer: false,
        workspaceAcl: false,
        networkPolicy: false,
        jobObject: false,
        reason: 'Windows 原生沙箱桥尚未安装；不会把普通 Node 子进程误报为 AppContainer。',
      }
    }
    try {
      return await options.bridge.probe()
    } catch (cause) {
      return {
        appContainer: false,
        workspaceAcl: false,
        networkPolicy: false,
        jobObject: false,
        reason: `Windows 原生沙箱桥自检失败：${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }
  }

  const status = async (): Promise<SandboxStatus> => {
    lastProbe = await probe()
    const enforced = isEnforced(lastProbe)
    const reason = enforced ? undefined : lastProbe.reason ?? missingBoundaryReason(lastProbe)
    return {
      available: enforced,
      mechanism: enforced ? MECHANISM : 'none',
      knownEscapeSurfaces: enforced ? ['网络 capability 只能按回合开关授予，域名级限制仍由策略层负责'] : missingBoundaries(lastProbe),
      degraded: !enforced,
      ...(reason === undefined ? {} : { reason }),
      providerAvailable: canPrepare(lastProbe),
      capabilities: capabilities(enforced, reason),
    }
  }

  return {
    status,
    async wrap(argv, policy) {
      const current = lastProbe ?? await probe()
      lastProbe = current
      if (!canPrepare(current, policy.mode) || options.bridge === undefined) {
        // 策略层会先读 status 并走审批/拒绝分支；这里保持 SandboxService 的降级形状，
        // 不能把“没有桥”伪装成被包装了。
        return { enforced: false, wrappedArgv: [...argv], degradationReason: current.reason ?? missingBoundaryReason(current) }
      }

      let wrapped: SandboxWrapResult
      try {
        wrapped = await options.bridge.wrap(argv, policy)
      } catch (cause) {
        throw bridgeFailed(cause)
      }
      if (!wrapped.enforced || wrapped.wrappedArgv.length === 0) {
        // 自检与真正启动之间发生变化时，不能因为之前的 status=true 就裸跑。
        throw bridgeFailed(wrapped.degradationReason ?? '原生桥没有返回受约束的启动命令。')
      }
      return { ...wrapped, wrappedArgv: [...wrapped.wrappedArgv] }
    },
    ...(options.bridge?.wrapPty === undefined
      ? {}
      : {
          async wrapPty(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult> {
            const wrapped = await options.bridge!.wrapPty!(argv, policy)
            if (!wrapped.enforced || wrapped.wrappedArgv.length === 0) throw bridgeFailed(wrapped.degradationReason ?? '原生桥没有返回受约束 PTY argv。')
            return { ...wrapped, wrappedArgv: [...wrapped.wrappedArgv] }
          },
        }),
    async releaseWorkspace(workspace): Promise<SandboxReleaseResult> {
      if (options.bridge?.releaseWorkspace === undefined) {
        return { released: false, reason: '当前 Windows 原生沙箱桥不支持撤销工作区 ACL。' }
      }
      try {
        return await options.bridge.releaseWorkspace(workspace)
      } catch (cause) {
        return { released: false, reason: `撤销 Windows 工作区 ACL 失败：${cause instanceof Error ? cause.message : String(cause)}` }
      }
    },
  }
}

function isEnforced(probe: WindowsSandboxProbe): boolean {
  return probe.appContainer && probe.workspaceAcl && probe.networkPolicy && probe.jobObject
}

/** 首次执行可在获批后由 helper 授予工作区 ACL；其余边界必须已可用。完全访问只需要 Job Object。 */
function canPrepare(probe: WindowsSandboxProbe, mode: ResolvedSandboxPolicy['mode'] = 'workspace-write'): boolean {
  if (mode === 'danger-full-access') return probe.jobObject
  return probe.appContainer && probe.networkPolicy && probe.jobObject
}

function capabilities(enforced: boolean, reason: string | undefined): PlatformSandboxCapabilities {
  const boundary = (message: string) => ({ state: enforced ? 'enforced' as const : 'unavailable' as const, plannedMechanism: MECHANISM, message })
  return {
    platform: 'win32',
    mechanism: enforced ? MECHANISM : 'none',
    boundaries: {
      filesystem: boundary(enforced ? 'AppContainer SID 的工作区 ACL 已生效' : reason ?? '工作区 ACL 未生效'),
      network: boundary(enforced ? 'AppContainer 的 internetClient capability 可按策略授予' : reason ?? '网络能力未受约束'),
      spawn: boundary(enforced ? '进程已由 Job Object 管理' : reason ?? '进程树未由 Job Object 管理'),
    },
    reason: reason ?? '',
  }
}

function missingBoundaries(probe: WindowsSandboxProbe): string[] {
  const missing: string[] = []
  if (!probe.appContainer) missing.push('AppContainer 未生效')
  if (!probe.workspaceAcl) missing.push('工作区 ACL 未生效')
  if (!probe.networkPolicy) missing.push('网络能力未受约束')
  if (!probe.jobObject) missing.push('Job Object 未生效')
  return missing
}

function missingBoundaryReason(probe: WindowsSandboxProbe): string {
  const missing = missingBoundaries(probe)
  return missing.length === 0 ? 'Windows 原生沙箱状态未知。' : `Windows 原生沙箱未完整生效：${missing.join('、')}。`
}

function bridgeFailed(cause: unknown): LcodeErrorImpl {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_READY,
    message: `Windows 原生沙箱桥启动失败：${detail}`,
    userMessage: 'Windows 原生沙箱启动失败，已拒绝运行该命令。',
    retryable: false,
    cause,
  })
}

function defaultHelperPaths(): readonly string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const result: string[] = []
  if (resourcesPath !== undefined && resourcesPath !== '') result.push(`${resourcesPath}\\app\\native\\lcode-sandbox-win32.exe`)
  // `pnpm --filter @lcode/desktop ...` 与直接从仓库根启动都会落到这两个候选之一。
  result.push(`${process.cwd()}\\packages\\sandbox\\sandbox-win32\\native\\lcode-sandbox-win32.exe`)
  result.push(`${process.cwd()}\\native\\lcode-sandbox-win32.exe`)
  return result
}

async function invoke(subprocess: SandboxHelperSubprocess, argv: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = await subprocess.spawn({ argv })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  await child.exited
  return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
}

function parseProbe(stdout: string): WindowsSandboxProbe | undefined {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.appContainer !== 'boolean' || typeof record.workspaceAcl !== 'boolean' || typeof record.networkPolicy !== 'boolean' || typeof record.jobObject !== 'boolean') return undefined
    return {
      appContainer: record.appContainer,
      workspaceAcl: record.workspaceAcl,
      networkPolicy: record.networkPolicy,
      jobObject: record.jobObject,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    }
  } catch {
    return undefined
  }
}

function parseRelease(stdout: string): SandboxReleaseResult | undefined {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.released !== 'boolean') return undefined
    return { released: record.released, ...(typeof record.reason === 'string' ? { reason: record.reason } : {}) }
  } catch {
    return undefined
  }
}
