import { platformSandboxCapabilities } from '@lcode/sandbox'
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
  const capabilities = platformSandboxCapabilities()
  const reason = options.reason ?? capabilities.reason
  const status: SandboxStatus = {
    available: false,
    mechanism: 'none',
    knownEscapeSurfaces: Object.entries(capabilities.boundaries)
      .filter(([, boundary]) => boundary.state !== 'enforced')
      .map(([name]) => ({ filesystem: '文件系统', network: '网络', spawn: '进程' }[name] ?? name) + '（无约束）'),
    degraded: true,
    reason,
    capabilities,
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
