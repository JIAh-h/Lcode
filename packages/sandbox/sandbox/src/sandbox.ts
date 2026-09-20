/**
 * SandboxService —— OS 原生沙箱约束（文档 12 §4.7 / D13）。
 *
 * ## 这个接口的边界在哪
 *
 * 它**只接收即将 spawn 的 argv、返回被包装后的 argv**，不理解任何工具逻辑（12 §4.7）。
 * 这样 `shell-sandbox` / `fs-sandbox` / `terminal-pty` / `lsp-stdio` 这些消费者
 * **全都不感知平台差异**——换平台换的是这一个实现。
 *
 * ## 为什么"降级"必须显式
 *
 * 沙箱没生效却当它生效了，是**最坏的一种失败**：用户以为有约束，实际裸跑。
 * 所以 `enforced: false` 一定要能被上层看见，并据 12 §4.2 走 fail-closed 三分支：
 * `ask` 档把"沙箱不可用"作为审批影响面展示、`never` 档直接拒绝、并写 `sandbox/degraded`。
 * **不允许静默降级为裸跑。**
 */

/** 沙箱档位（12 §3.1 的两轴之一；另一轴是 `approval/policy`） */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 一次 spawn 的约束策略（由 `permission-presets` 从预设解出来） */
export interface ResolvedSandboxPolicy {
  readonly mode: SandboxMode
  /** 工作区根：`read-only` 与 `workspace-write` 的可达范围都由它界定 */
  readonly workspaceRoot: string
  /** 额外可写根（如 `/tmp` 的私有区）。12 §3.1 允许 `workspace-write` 带这个 */
  readonly writableRoots?: readonly string[] | undefined
  /** 网络是否放行（`read-only` / `workspace-write` 默认禁） */
  readonly allowNetwork?: boolean | undefined
}

/** 包装结果（12 §4.7 的返回形状） */
export interface SandboxWrapResult {
  /** 约束**是否真的生效**。false = 降级，上层必须按 fail-closed 处理 */
  readonly enforced: boolean
  /** 被包装后的 argv（可能带了 `sandbox-exec -f profile …` 之类的前缀） */
  readonly wrappedArgv: readonly string[]
  /** profile 文本（macOS 的 SBPL 等）；会写进 `sandbox/profile` 事件供回放 */
  readonly profile?: string | undefined
  /** 降级原因（仅在 `enforced: false` 时有意义，必须是**可读的**） */
  readonly degradationReason?: string | undefined
}

/** 沙箱状态（doctor --sandbox 的输出） */
export interface SandboxStatus {
  readonly available: boolean
  readonly mechanism: string
  readonly knownEscapeSurfaces: readonly string[]
  readonly degraded: boolean
  /** 降级时的可读原因；`degraded: false` 时为 undefined */
  readonly reason?: string | undefined
  /** 文件、网络、进程三项的实际约束能力；不能由 UI 或文案自行推断。 */
  readonly capabilities: PlatformSandboxCapabilities
}

/** 显式取消信任工作区后，Provider 对自己曾授予的 OS 级访问权的撤销结果。 */
export interface SandboxReleaseResult {
  readonly released: boolean
  /** 未能撤销时的可读原因；本地策略仍会立即停止信任该目录。 */
  readonly reason?: string | undefined
}

export interface SandboxService {
  status(): Promise<SandboxStatus>
  /**
   * 约束即将 spawn 的 argv。
   *
   * **不做"允不允许"的判断**——那是策略层的事。这里要么给出被包装的 argv，
   * 要么如实报告"我没能约束住"（`enforced: false`）。
   */
  wrap(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  /** 强制沙箱下的交互 PTY 必须由原生 Provider 显式接管。 */
  wrapPty?(argv: readonly string[], policy: ResolvedSandboxPolicy): Promise<SandboxWrapResult>
  /**
   * 取消信任精确工作区时撤销 Provider 曾授予的本机权限。非原生 Provider 可以省略。
   * 调用方仍须移除自己的信任记录，不能因 cleanup 失败继续把目录视为可信。
   */
  releaseWorkspace?(workspace: string): Promise<SandboxReleaseResult>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    sandbox: SandboxService
  }
  interface Events {
    /** 沙箱降级（12 §4.2）：已落盘的事件类型，降级时必须发 */
    'sandbox/degraded': { readonly reason: string; readonly mechanism: string }
    /** 本次生成的 profile（供回放当时的约束） */
    'sandbox/profile': { readonly profile: string; readonly mode: SandboxMode }
  }
}

import type { PlatformSandboxCapabilities } from './capabilities.ts'
