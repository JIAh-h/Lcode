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
  /** 超时预算（毫秒）；超时 → ET-TIMEOUT */
  readonly timeoutMs?: number
  /** 执行体：收到"原始串 + 解析值"，返回规范值或抛 LcodeError */
  execute(call: ToolCall & { readonly parsed: TIn }, opts: ExecuteOpts): Promise<TOut> | TOut
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

/** 事件声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Events {
    /** 执行前（waterfall：可 allow/deny/ask；D10） */
    'tools/pre-execute': { call: ToolCall; deny?: string }
    'tools/execute': { call: ToolCall; result: ToolResult }
    'tools/post-execute': { call: ToolCall; result: ToolResult }
  }
}
