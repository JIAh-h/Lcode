import type { Context } from '@lcode/context'
import type { ContentBlock, ModelMessage, SessionEvent, SessionService, VisibleSurfaceItem } from '@lcode/session'
import { deriveRequestItems } from '@lcode/session'
import type { ToolSchema } from '@lcode/tools'
import type { Disposer } from '@lcode/util'

export interface TokenMeasurement {
  /** 取样时的日志长度；日志变更后该快照即过期。 */
  readonly revision: number
  readonly surfaceTokens: number
  readonly systemTokens: number
  readonly toolSchemaTokens: number
  /** 对话里图片的固定预算部分（已含在 surfaceTokens 内） */
  readonly imageTokens: number
  /** 当前表面上的压缩摘要估算（已含在 surfaceTokens 内） */
  readonly summaryTokens: number
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
  // 屏蔽的轮次不进入请求，也不应该计入"下一次请求"的预算
  const items = deriveRequestItems(events)
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
  const surfaceTokens = items.reduce((sum, item) => sum + messageTokens(item.message), 0)
  const imageTokens = items.reduce((sum, item) => sum + messageImageTokens(item.message), 0)
  const summaryTokens = items.reduce((sum, item) => sum + messageSummaryTokens(item.message), 0)
  return Object.freeze({
    revision: input.session.length,
    surfaceTokens,
    systemTokens,
    toolSchemaTokens,
    imageTokens,
    summaryTokens,
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
    if (type === 'compaction/start' || type === 'compaction/end' || type === 'compaction/undo' || type === 'session/rewound') return undefined
  }
  const itemIndex = items.findIndex((item) => item.sourceSeq === baseline.seq)
  if (itemIndex < 0) return undefined
  let delta = 0
  for (const item of items.slice(itemIndex + 1)) delta += messageTokens(item.message)
  return { total: baseline.input + baseline.output + delta, delta }
}

/**
 * 图片按固定预算计（base64 字符数不代表 token）；技能指令和文本按字符估算。
 * 供应商返回 usage 后，实测值会覆盖这些估算。
 */
const IMAGE_TOKENS = 1_200

function messageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') return estimateTokens(message.content)
  return message.content.reduce((sum, block) => sum + blockTokens(block), 0)
}

function blockTokens(block: ContentBlock): number {
  if (block.type === 'text') return estimateTokens(block.text)
  if (block.type === 'image' || block.type === 'image-ref') return IMAGE_TOKENS
  // 附件正文随消息进入请求；文件夹只有目录结构，实际内容仍由工具按需读取
  if (block.type === 'file-ref') return estimateTokens(block.content) + 24
  // 技能只在本轮请求里生效；历史轮次的技能块会被请求层剥掉，不占上下文
  if (block.type === 'skill') return 0
  if (block.type === 'tool_use') return estimateTokens(`${block.name}\n${JSON.stringify(block.input)}`)
  if (typeof block.content === 'string') return estimateTokens(block.content)
  return block.content.reduce((sum, nested) => sum + blockTokens(nested), 0)
}

function messageImageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') return 0
  return message.content.reduce((sum, block) => {
    if (block.type === 'image' || block.type === 'image-ref') return sum + IMAGE_TOKENS
    if (block.type === 'tool_result' && typeof block.content !== 'string') {
      return sum + block.content.reduce((nested, item) => nested + (item.type === 'image' || item.type === 'image-ref' ? IMAGE_TOKENS : 0), 0)
    }
    return sum
  }, 0)
}

function messageSummaryTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') return message.content.startsWith('[Conversation summary]') ? estimateTokens(message.content) : 0
  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  return text.startsWith('[Conversation summary]') ? estimateTokens(text) : 0
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
