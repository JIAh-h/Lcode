/** OS 沙箱需要如实报告的三类边界。 */
export type SandboxBoundary = 'filesystem' | 'network' | 'spawn'

export type SandboxBoundaryState = 'enforced' | 'unavailable'

export interface SandboxBoundaryCapability {
  readonly state: SandboxBoundaryState
  /** 该平台接入原生后应负责的机制；不是“已启用”的声明。 */
  readonly plannedMechanism: string
  /** 当前状态对用户可见的解释。 */
  readonly message: string
}

export interface PlatformSandboxCapabilities {
  readonly platform: string
  readonly mechanism: string
  readonly boundaries: Readonly<Record<SandboxBoundary, SandboxBoundaryCapability>>
  readonly reason: string
}

/**
 * 三平台能力矩阵的唯一来源。
 *
 * 这里是**无原生 Provider 时的降级文案**（`sandbox-local` 使用）；Windows/Linux/macOS
 * 各自的原生 Provider 会给出自己真实的能力快照。原生实现只能在真机验收通过后把
 * 对应 boundary 升为 enforced；不得只改产品文案。
 */
export function platformSandboxCapabilities(platform: string = process.platform): PlatformSandboxCapabilities {
  const descriptor = platformDescriptor(platform)
  const unavailable = (boundary: string): SandboxBoundaryCapability => ({
    state: 'unavailable',
    plannedMechanism: descriptor.mechanism,
    message: `${boundary}尚未受到 ${descriptor.mechanism} 约束`,
  })
  return {
    platform,
    mechanism: 'none',
    boundaries: {
      filesystem: unavailable('文件系统'),
      network: unavailable('网络'),
      spawn: unavailable('进程创建'),
    },
    reason: descriptor.reason,
  }
}

function platformDescriptor(platform: string): { readonly mechanism: string; readonly reason: string } {
  switch (platform) {
    case 'win32':
      return {
        mechanism: 'AppContainer + Job Object',
        reason: '未检测到 Windows 原生沙箱 helper（AppContainer + Job Object）；命令在无约束下运行。',
      }
    case 'darwin':
      return {
        mechanism: 'Seatbelt',
        reason: '未检测到可用的 Seatbelt（sandbox-exec）；命令在无约束下运行。',
      }
    case 'linux':
      return {
        mechanism: 'Landlock + seccomp',
        reason: 'Linux 原生沙箱 helper 尚未安装；命令在无约束下运行。',
      }
    default:
      return {
        mechanism: '无可用原生机制',
        reason: `当前平台（${platform}）没有可用的沙箱实现，命令在无约束下运行。`,
      }
  }
}
