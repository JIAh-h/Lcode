import type { Context } from '@lcode/context'
import type { SessionEvent, SessionService, VisibleSurfaceItem } from '@lcode/session'
import { deriveVisibleSurfaceItems } from '@lcode/session'
import type { ToolSchema } from '@lcode/tools'
import type { Disposer } from '@lcode/util'

export interface TokenMeasurement {
  /** 取样时的日志长度；日志变更后该快照即过期。 */
  readonly revision: number
  readonly surfaceTokens: number
  readonly systemTokens: number
  readonly toolSchemaTokens: number
  readonly total: number
  /** provider 已返回的真实用量，只用于校准和审计，绝不再重复相加到 total。 */
  readonly observedInputTokens: number
  readonly observedOutputTokens: number
  /**
   * 以最近一次仍有效的供应商 usage 为基线的当前上下文大小：
   * `input + output + 其后新增表面的估算`。没有可用基线时缺省。
   */
  readonly providerTotal?: number | undefined
  /** providerTotal 中属于"基线之后新增内容"的估算部分；0 表示整段来自实测。 */
  readonly providerDeltaTokens?: number | undefined
}

export interface ContextBudgetService {
  measure(input: { readonly session: SessionService; readonly system: string; readonly tools: readonly ToolSchema[] }): TokenMeasurement
}

declare module '@lcode/context' {
  interface Services { contextBudget: ContextBudgetService }
}

/** 只提供测量快照；是否压缩、何时压缩由用户显式触发，不做任何自动动作。 */
export function registerContextBudget(input: { readonly ctx: Context }): Disposer {
  return input.ctx.set('contextBudget', { measure })
}

export function measure(input: { readonly session: SessionService; readonly system: string; readonly tools: readonly ToolSchema[] }): TokenMeasurement {
  const events = input.session.events()
  const items = deriveVisibleSurfaceItems(events)
  const surface = items.map((item) => JSON.stringify(item.message)).join('\n')
  const schemas = JSON.stringify(input.tools)
  let observedInputTokens = 0
  let observedOutputTokens = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    observedInputTokens += event.data.usage?.input ?? 0
    observedOutputTokens += event.data.usage?.output ?? 0
  }
  const provider = providerBaseline(events, items)
  const systemTokens = estimateTokens(input.system)
  const toolSchemaTokens = estimateTokens(schemas)
  const surfaceTokens = estimateTokens(surface)
  return Object.freeze({
    revision: input.session.length,
    surfaceTokens,
    systemTokens,
    toolSchemaTokens,
    total: surfaceTokens + systemTokens + toolSchemaTokens,
    observedInputTokens,
    observedOutputTokens,
    ...(provider === undefined ? {} : { providerTotal: provider.total, providerDeltaTokens: provider.delta }),
  })
}

/**
 * 最近一次仍可对齐到当前表面的供应商 usage。
 *
 * usage 是请求**发出时**的 prompt 大小；之后的助手输出、工具结果和用户消息
 * 只能按估算补进来。压缩或回退会改写表面，旧基线随之作废。
 */
function providerBaseline(
  events: readonly SessionEvent[],
  items: readonly VisibleSurfaceItem[],
): { readonly total: number; readonly delta: number } | undefined {
  let baselineIndex = -1
  let baseline: { readonly seq: number; readonly input: number; readonly output: number } | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined || usage.input <= 0) continue
    baselineIndex = index
    baseline = { seq: event.seq, input: usage.input, output: usage.output }
  }
  if (baseline === undefined) return undefined
  for (let index = baselineIndex + 1; index < events.length; index += 1) {
    const type = events[index]?.type
    if (type === 'compaction/start' || type === 'compaction/end' || type === 'session/rewound') return undefined
  }
  const itemIndex = items.findIndex((item) => item.sourceSeq === baseline.seq)
  if (itemIndex < 0) return undefined
  let delta = 0
  for (const item of items.slice(itemIndex + 1)) delta += estimateTokens(JSON.stringify(item.message))
  return { total: baseline.input + baseline.output + delta, delta }
}

/**
 * 本地估算：CJK 字符约 1 token/字，其余字符约 1 token/3.5 字符。
 * 供应商返回 usage 时以实测为准，这里只负责补齐"上次请求之后新增"的部分。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isCjk(code)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 3.5)
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // 部首扩展、CJK 统一表意文字
    (code >= 0xac00 && code <= 0xd7af) || // 韩文
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
    (code >= 0xff00 && code <= 0xffef) // 全角标点/字符
  )
}
