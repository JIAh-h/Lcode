import { Context } from '@lcode/context'
import type { Disposer, JsonValue } from '@lcode/util'
import type { CardType } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl, isJsonValue } from '@lcode/util'
import type { ToolActionIntent, ToolCall, ToolDefinition, ToolGuard, ToolResult, ToolSchema } from './types.ts'

/**
 * ToolRegistry —— 作用域工具注册表 + 受守卫的执行流水线（文档 20 §5.3）。
 */
export interface ToolRegistry {
  /** 注册工具（返回 disposer） */
  register<TIn, TOut>(tool: ToolDefinition<TIn, TOut>): Disposer
  /** 当前可见的 schema 列表（受作用域与 restrict 影响） */
  schemas(): readonly ToolSchema[]
  /** 查询工具声明的卡片类型；用于在结果落盘前生成 pending 卡片。 */
  card?(name: string): CardType | undefined
  /** 收窄可见集合（只能收窄） */
  restrict(ids: readonly string[]): Disposer
  /** 注册守卫：类型上只有 deny 与"弃权"，没有 allow */
  guard(guard: ToolGuard): Disposer
  /** 执行（唯一入口；调用方不得绕过） */
  execute(call: ToolCall, opts: { readonly signal: AbortSignal; readonly scope?: unknown }): Promise<ToolResult>
}

/** 内存实现 */
export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, ToolDefinition<unknown, unknown>>()
  private guards: ToolGuard[] = []
  /** 收窄堆栈：每个 restrict 产生一层过滤 */
  private restrictLayers: Array<readonly string[]> = []

  constructor(private readonly ctx: Context) {}

  register<TIn, TOut>(tool: ToolDefinition<TIn, TOut>): Disposer {
    if (this.tools.has(tool.name)) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_CONFLICT,
        message: `tool already registered: ${tool.name}`,
        userMessage: '这个功能已经存在了，没有重复注册。',
      })
    }
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>)
    return () => {
      this.tools.delete(tool.name)
    }
  }

  schemas(): readonly ToolSchema[] {
    const allowed = this.currentVisibleIds()
    return [...this.tools.values()]
      .filter((t) => allowed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }

  card(name: string): CardType | undefined {
    return this.tools.get(name)?.card
  }

  restrict(ids: readonly string[]): Disposer {
    this.restrictLayers.push(ids)
    const idx = this.restrictLayers.length - 1
    return () => {
      this.restrictLayers[idx] = undefined as unknown as string[]
    }
  }

  guard(guard: ToolGuard): Disposer {
    this.guards.push(guard)
    const idx = this.guards.length - 1
    return () => {
      this.guards[idx] = undefined as unknown as ToolGuard
    }
  }

  async execute(call: ToolCall, opts: { readonly signal: AbortSignal; readonly scope?: unknown }): Promise<ToolResult> {
    // 1. 工具可见性
    const tool = this.tools.get(call.name)
    if (!tool) {
      return this.fail(call, ERROR_CODES.ET_UNKNOWN_TOOL, 'tool not found or not visible')
    }
    if (!this.currentVisibleIds().has(call.name)) {
      return this.fail(call, ERROR_CODES.ET_UNKNOWN_TOOL, 'tool not visible in current scope')
    }

    // 2. 参数解析（D9：不改写，只解析）
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments)
    } catch {
      return this.fail(call, ERROR_CODES.ET_INVALID_ARGS, `arguments 不是合法 JSON：${truncate(call.arguments)}`)
    }
    const invalid = validateInput(tool.inputSchema, parsed)
    if (invalid) {
      return this.fail(call, ERROR_CODES.ET_INVALID_ARGS, invalid)
    }

    /*
     * 3. 审批接缝（`tools/pre-execute` waterfall）。
     *
     * **必须在参数解析之后**：策略层要看的 `intent` 是从解析后的值算出来的，
     * 拿原始 JSON 串去判定会退化成"策略自己解析参数"——那正是我们要避免的。
     *
     * 顺序纪律（12 §6.4 / 14 §3.5）：审批在**守卫之前**。先问人、后过红线；
     * 反过来会让"用户批准了"变成绕过守卫的通行证。
     */
    const intent = tool.describeAction === undefined ? undefined : tool.describeAction(parsed)
    const pre: { call: ToolCall; intent?: ToolActionIntent; scope?: unknown; signal: AbortSignal; deny?: string } = {
      call,
      signal: opts.signal,
      ...(intent === undefined ? {} : { intent }),
      ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    }
    await this.ctx.waterfall<'tools/pre-execute', typeof pre, typeof pre>('tools/pre-execute', pre, undefined, async () => pre)
    if (pre.deny !== undefined) {
      return this.fail(call, ERROR_CODES.ET_DENIED, pre.deny)
    }

    // 4. 守卫链（T2：只有 deny / abstain；任一 deny 即拦截）
    for (const guard of this.guards) {
      if (!guard) continue
      const verdict = await guard(call, { scope: opts.scope })
      if (verdict === 'deny') {
        return this.fail(call, ERROR_CODES.ET_DENIED, 'denied by guard')
      }
    }

    // 5. 执行
    let value: unknown
    try {
      value = await tool.execute({ ...call, parsed }, opts)
    } catch (err) {
      return this.fail(call, toCode(err), err instanceof Error ? err.message : String(err))
    }

    // 6. 规范值校验（T3 / C5：必须无损 JSON）
    if (!isJsonValue(value)) {
      return this.fail(call, ERROR_CODES.ET_INVALID_OUTPUT, '工具返回的不是无损 JSON 规范值')
    }

    const presentation = this.presentationMeta(tool, parsed, value)
    const meta = this.cardMeta(tool.card, presentation)
    const result: ToolResult = {
      callId: call.callId,
      name: call.name,
      ok: true,
      value,
      ...(meta === undefined ? {} : { meta }),
    }
    await this.ctx.emit('tools/execute', { call, result })
    await this.ctx.emit('tools/post-execute', { call, result })
    return result
  }

  private presentationMeta(tool: ToolDefinition<unknown, unknown>, parsed: unknown, value: unknown): JsonValue | undefined {
    if (tool.presentationMeta === undefined) return undefined
    try {
      const meta = tool.presentationMeta(parsed, value as JsonValue)
      return isJsonValue(meta) ? meta : undefined
    } catch {
      // 卡片只是投影；展示函数出错不能把一个已经完成的工具变成失败。
      return undefined
    }
  }

  private cardMeta(card: CardType | undefined, presentation: JsonValue | undefined): JsonValue | undefined {
    if (card === undefined && presentation === undefined) return undefined
    if (presentation !== undefined && isRecord(presentation)) {
      return { ...presentation, ...(card === undefined ? {} : { card }) } as JsonValue
    }
    return { card: card ?? 'generic', ...(presentation === undefined ? {} : { value: presentation }) }
  }

  private currentVisibleIds(): Set<string> {
    const visible = new Set(this.tools.keys())
    for (const layer of this.restrictLayers) {
      if (!layer) continue
      const keep = new Set(layer)
      for (const id of [...visible]) {
        if (!keep.has(id)) visible.delete(id)
      }
    }
    return visible
  }

  private fail(call: ToolCall, code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string): ToolResult {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      error: { name: 'LcodeError', code },
      // 诊断细节只进 details（I7：不含凭据值）
      meta: { diagnostic: message },
    }
  }
}

function validateInput(schema: ToolDefinition<unknown, unknown>['inputSchema'], parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return '参数必须是 JSON 对象'
  }
  const obj = parsed as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (obj[key] === undefined) return `缺少必填参数：${key}`
  }
  return undefined
}

function toCode(err: unknown): (typeof ERROR_CODES)[keyof typeof ERROR_CODES] {
  if (err instanceof LcodeErrorImpl) return err.code
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code: string }).code
    if (Object.values(ERROR_CODES).includes(c as never)) return c as (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
  }
  return ERROR_CODES.ET_ERROR
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
