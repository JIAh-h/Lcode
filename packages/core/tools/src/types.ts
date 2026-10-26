import type { ErrorCode, JsonValue } from '@lcode/util'
import type { CardType } from '@lcode/session'

/**
 * 工具契约（文档 08 / 20 §5.3 / 21 §3）。
 * 工具返回**结构化规范值** + 纯投影渲染；同一份值同时服务模型、Code Mode、UI（D8）。
 */

/** 轻量 JSON Schema 子集（骨架阶段用；完整校验随批次 ⑤） */
export interface ToolInputSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, { readonly type: string; readonly description?: string; readonly enum?: readonly string[] }>>
  readonly required?: readonly string[]
  readonly description?: string
}

/** 模型可见的工具 schema（system-prompt 装配时使用） */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
}

/** 一次工具调用的入参（文档 06 §2.2：arguments 是未解析的原始 JSON 字符串，D9） */
export interface ToolCall {
  readonly callId: string
  readonly name: string
  /** ⚠️ 未解析的原始 JSON 字符串，不是对象；参数不可被中间件改写 */
  readonly arguments: string
}

/** 工具定义：TIn 是解析后的入参类型，TOut 是规范值类型 */
export interface ToolDefinition<TIn = JsonValue, TOut = JsonValue> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
  /** 声明式卡片意图（UI 投影，08 §8） */
  readonly card?: CardType
  /**
   * 从已解析参数和规范值生成可重放的 UI 元数据。
   * 纯函数、不得 I/O；结果会落在 `tool/result.meta`，实时与回放共用。
   */
  readonly presentationMeta?: (args: TIn, value: JsonValue) => JsonValue
  /** 超时预算（毫秒）；超时 → ET-TIMEOUT */
  readonly timeoutMs?: number
  /**
   * **申报这次调用的动作意图**（审批与权限判定的输入，12 §5.4 / §9.3）。
   *
   * 为什么由**工具**申报而不是让策略去解析 `arguments`：只有工具知道自己的参数
   * 里哪个字段是"要写的路径"、哪个是"要跑的命令"。让策略去猜 JSON 结构，
   * 会在每个工具加参数时静默失效——而那正是**该问的没问**这一类事故的形态。
   *
   * 省略 = 这个工具不产生外部副作用（如纯计算的 `todo_write`），策略直接放行。
   */
  describeAction?(parsed: TIn): ToolActionIntent
  /** 执行体：收到"原始串 + 解析值"，返回规范值或抛 LcodeError */
  execute(call: ToolCall & { readonly parsed: TIn }, opts: ExecuteOpts): Promise<TOut> | TOut
}

/**
 * 工具申报的"我要干什么"。
 *
 * 字段与 `permission-presets` 的 `ActionIntent` 结构兼容——但**类型摆在 core/tools**
 * 是因为这是工具契约的一部分，而 `core/tools` 不能反向依赖策略包（20 §3 的依赖方向）。
 */
export interface ToolActionIntent {
  /** 一句话摘要（给用户看，不是 JSON dump） */
  readonly summary: string
  readonly paths?: readonly { readonly path: string; readonly mode: 'read' | 'write' }[] | undefined
  readonly argv?: readonly string[] | undefined
  readonly domains?: readonly string[] | undefined
  /** web 工具请求的完整 URL；域名之外的路径/查询同样会离开本机。 */
  readonly url?: string | undefined
  /** 这条命令需要访问网络：策略层会弹审批，批准后按 `networkScope` 放开。 */
  readonly network?: boolean | undefined
  /** 联网授权的生命周期；默认 `call`（仅本次调用），终端是 `terminal`（关闭前有效）。 */
  readonly networkScope?: 'call' | 'terminal' | undefined
  /** 环境变量**名**（只给名字不给值，I7） */
  readonly env?: readonly string[] | undefined
}

export interface ExecuteOpts {
  readonly signal: AbortSignal
  readonly scope?: unknown
}

/**
 * 工具结果（规范值包装，可重放）。
 * 工具失败永不终结轮（08 §4.4）：ET-* 一律作为 result 交给模型。
 */
export interface ToolResult {
  readonly callId: string
  readonly name: string
  readonly ok: boolean
  /** 规范值（无损 JSON，I5） */
  readonly value?: JsonValue
  readonly error?: { readonly name: string; readonly code: ErrorCode }
  /** 可重放的 UI 元数据（如 diff hunk；由 presentationMeta 产生） */
  readonly meta?: JsonValue
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}

/**
 * 守卫：单调终局策略（D10）。
 * 返回值里**没有 allow**——只能拒绝或弃权；无应答者 = fail-closed（D11）。
 */
export interface ToolGuard {
  (call: ToolCall, ctx: GuardCtx): 'deny' | 'abstain' | Promise<'deny' | 'abstain'>
}

export interface GuardCtx {
  readonly reason?: string
  readonly scope?: unknown
}

/**
 * 执行 scope 上携带的沙箱策略。
 *
 * 由权限钩子在 `tools/pre-execute` 阶段按**当前预设**写入，工具执行器据此向
 * OS 沙箱申请同一档位。之前工具各自硬编码 `workspace-write`，导致「只读」仍能
 * 通过 shell 写文件、「完全访问」仍被工作区 ACL 限制。
 */
export interface ExecutionSandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
  readonly allowNetwork?: boolean | undefined
}

/** 从工具执行 scope 读取沙箱策略；没有（直接调用/测试）时返回 undefined。 */
export function sandboxPolicyOf(scope: unknown): ExecutionSandboxPolicy | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { sandboxPolicy?: unknown }).sandboxPolicy
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const mode = record.mode
  const workspaceRoot = record.workspaceRoot
  if (
    (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') ||
    typeof workspaceRoot !== 'string' ||
    workspaceRoot === ''
  ) {
    return undefined
  }
  return {
    mode,
    workspaceRoot,
    ...(typeof record.allowNetwork === 'boolean' ? { allowNetwork: record.allowNetwork } : {}),
  }
}

/** 把沙箱策略合入 scope（权限钩子用）。 */
export function withSandboxPolicy(scope: unknown, policy: ExecutionSandboxPolicy): Record<string, unknown> {
  const base = typeof scope === 'object' && scope !== null ? { ...(scope as Record<string, unknown>) } : {}
  return { ...base, sandboxPolicy: policy }
}

/**
 * 执行 scope 上的 web 域名边界。
 *
 * 策略 hook 放行后写入；`web_fetch` 执行时据此校验初始 URL 与每次重定向。
 * 这不替代审批，而是补上“审批之后 URL 还能跳去别处”的能力旁路。
 */
export interface WebNetworkPolicy {
  /** 本次调用已获批准的精确主机名（不含 `*`） */
  readonly approvedHosts: readonly string[]
  /** 当前工作区已记住的主机名 */
  readonly allowlistedHosts: readonly string[]
}

/** 从执行 scope 读取 web 域名边界；没有（直接调用/测试）时返回 undefined。 */
export function webNetworkPolicyOf(scope: unknown): WebNetworkPolicy | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { webNetworkPolicy?: unknown }).webNetworkPolicy
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const approvedHosts = stringArray(record.approvedHosts)
  const allowlistedHosts = stringArray(record.allowlistedHosts)
  if (approvedHosts === undefined || allowlistedHosts === undefined) return undefined
  return { approvedHosts, allowlistedHosts }
}

/** 把 web 域名边界合入 scope（权限钩子用）。 */
export function withWebNetworkPolicy(scope: unknown, policy: WebNetworkPolicy): Record<string, unknown> {
  const base = typeof scope === 'object' && scope !== null ? { ...(scope as Record<string, unknown>) } : {}
  return { ...base, webNetworkPolicy: policy }
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return value as readonly string[]
}

/** 事件声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Events {
    /**
     * 执行前（waterfall）。
     *
     * 处理器可以：`deny` 一条理由（拒掉）、或什么都不做（放行）。`intent` 是
     * **已经被解析过的**动作申报——策略层不需要、也不该去解析 `call.arguments` 的 JSON。
     */
    'tools/pre-execute': {
      call: ToolCall
      /** 工具申报的动作意图（工具没申报则为 undefined） */
      intent?: ToolActionIntent
      /** 引擎传下来的执行 scope（会话身份）——策略层拿它定位工作区与落盘会话 */
      scope?: unknown
      deny?: string
    }
    'tools/execute': { call: ToolCall; result: ToolResult }
    'tools/post-execute': { call: ToolCall; result: ToolResult }
  }
  /** ctx key（文档 20 §5.3）：注册表 */
  interface Services {
    tools: import('./registry.ts').ToolRegistry
  }
}
