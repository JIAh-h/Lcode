import type { ResolvedSandboxPolicy, SandboxService, SandboxStatus, SandboxWrapResult } from '@lcode/sandbox'

/**
 * `sandbox-local` —— **无约束**的兜底实现（12 §4.7）。
 *
 * ## 它存在的意义是"如实报告"，不是"假装有沙箱"
 *
 * 三平台原生沙箱（Seatbelt / Landlock / AppContainer）按 14 §3.5 的缓解策略**分批发布**。
 * 未完成的平台不能凭空拒绝一切命令（那让产品没法用），也不能假装有约束（那让人误以为
 * 有保护，是**最坏**的一种失败）。所以这里的契约是：
 *
 * - `wrap()` **原样返回 argv**，并如实标 `enforced: false` + 一条可读的降级原因；
 * - 策略层据此走 12 §4.2 的 fail-closed 三分支（`ask` 档把它作为审批影响面展示、
 *   `never` 档直接拒绝、并写 `sandbox/degraded` 事件）。
 *
 * **它不做任何路径检查**。真正的边界强制是策略层 + 审批的事，而"路径判定"在接口层
 * 统一（20 §6.1）。把半吊子的路径检查塞进这里，只会制造"以为拦住了"的错觉。
 */

export interface LocalSandboxOptions {
  /**
   * 降级原因（会进 `sandbox/degraded` 事件与 doctor 输出）。
   * 默认按平台给一句可读的话——用户看到"为什么没沙箱"比只看到一个布尔有用得多。
   */
  readonly reason?: string | undefined
}

export function createLocalSandbox(options: LocalSandboxOptions = {}): SandboxService {
  const reason = options.reason ?? defaultReason()
  const status: SandboxStatus = {
    available: false,
    mechanism: 'none',
    knownEscapeSurfaces: ['文件系统（无约束）', '网络（无约束）', '进程（无约束）'],
    degraded: true,
    reason,
  }

  return {
    async status(): Promise<SandboxStatus> {
      return status
    },

    async wrap(argv: readonly string[], _policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult> {
      // `_policy` 被忽略是**刻意的**：这里没有任何强制能力，按策略"演"一遍
      // 只会让上层以为约束生效了。参数留着是为了满足接口形状。
      void _policy
      return { enforced: false, wrappedArgv: [...argv], degradationReason: reason }
    },
  }
}

function defaultReason(): string {
  const platform = process.platform
  if (platform === 'win32') {
    return 'Windows 原生沙箱（AppContainer + Job Object）尚未接入，命令在无约束下运行。'
  }
  if (platform === 'darwin') {
    return 'macOS 沙箱（Seatbelt）尚未接入，命令在无约束下运行。'
  }
  if (platform === 'linux') {
    return 'Linux 沙箱（Landlock + seccomp）尚未接入，命令在无约束下运行。'
  }
  return `当前平台（${platform}）没有可用的沙箱实现，命令在无约束下运行。`
}
