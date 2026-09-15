import type { ResolvedSandboxPolicy } from '@lcode/sandbox'

/**
 * ShellService —— 执行命令（21 §3.6 的规范值形状；沙箱约束的是**即将 spawn 的 argv**）。
 *
 * ## 为什么结果是 `oneOf`（前台 / 后台）而不是一个大对象
 *
 * 前台和后台**没有共同的必填字段**：后台只有 `jobId`（没有退出码，它还在跑），
 * 前台有退出码与输出（没有 jobId）。合成一个"字段都可选"的形状会让消费方
 * 到处写 `if (result.exitCode !== undefined)`——那正是 oneOf 想避免的。
 *
 * ## 关于"命令退出码非 0"
 *
 * **不是错误**（08 §2.3）：`grep` 没匹配到会返回 1，那是一次成功的执行。
 * 所以 `exitCode !== 0` 走**成功值**这条道，不抛错。只有"命令压根没能执行"
 * （spawn 失败、被沙箱拒、超时）才抛。
 */

/** 前台执行的规范值 */
export interface ShellForegroundResult {
  readonly kind: 'foreground'
  readonly exitCode: number
  /** 被杀时的信号名（如 `SIGTERM`）；正常退出为 null */
  readonly signal: string | null
  readonly timedOut: boolean
  /** 是否被调用方主动中止 */
  readonly aborted: boolean
  /** 本次生效的超时预算（模型据此判断"是不是我给的太短"） */
  readonly timeoutMs: number
  readonly stdout: string
  readonly stderr: string
  /** 沙箱是否真的生效；false 时上层应按 fail-closed 处理（12 §4.2） */
  readonly sandbox: { readonly enforced: boolean }
}

/** 后台执行的规范值（**没有退出码**——它还在跑） */
export interface ShellBackgroundResult {
  readonly kind: 'background'
  readonly jobId: string
}

export type ShellResult = ShellForegroundResult | ShellBackgroundResult

export interface ShellRunOpts {
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
  /** 放到后台跑（立即返回 `jobId`，不等结果） */
  readonly runInBackground?: boolean | undefined
  /** 沙箱策略（由策略层从预设解出；执行器把它交给 `ctx.sandbox.wrap`） */
  readonly sandboxPolicy?: ResolvedSandboxPolicy | undefined
}

export interface ShellService {
  /**
   * 执行一条命令。
   *
   * `argv` 而不是命令行字符串：**沙箱要包装的是 argv**（12 §4.7），而字符串得先经过
   * 一层 shell 解析才能拿到 argv——那一层解析正是注入的入口。调用方（工具）负责
   * 决定"这条命令要用哪个 shell 跑"，执行器不猜。
   */
  run(argv: readonly string[], opts?: ShellRunOpts): Promise<ShellResult>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    shell: ShellService
  }
}
