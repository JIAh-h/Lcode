import type { Context } from '@lcode/context'
import type { ModelSelection } from '@lcode/agent-default-model'
import type { AssistantMessage, ModelMessage, SessionService } from '@lcode/session'
import { deriveRequestItems, deriveTurnMarkers, deriveVisibleSurfaceItems, isUserPrompt, type VisibleSurfaceItem } from '@lcode/session'
import { buildRequestBody } from '@lcode/agent-loop'

export interface CompactionSummaryInput {
  readonly sessionId: string
  readonly session: SessionService
  /** 只保留最近 N 轮；省略则按字符预算保留 */
  readonly keepRecentTurns?: number | undefined
}

/** 手动压缩时由宿主提供的摘要器；不参与任何自动触发。 */
export type CompactionSummarizer = (input: CompactionSummaryInput) => Promise<string> | string

/**
 * 模型摘要器：把"较早的历史前缀"压成一段给下一个请求继续用的摘要。
 *
 * 只有用户点「压缩上下文」时才会执行；不做步前检测，也不在请求失败后自动重试。
 */

export interface CompactionRangePlan {
  /** 永远从可见表面的 0 开始：只压前缀，保留最近上下文 */
  readonly start: 0
  /** 前缀右端点（[0, end) 被替换成摘要）；`items[end]` 一定是一条用户提问 */
  readonly end: number
  readonly prefixChars: number
  readonly keptItems: number
  /** 压缩区间内的消息数（= end） */
  readonly compactedItems: number
  /** 当前可见表面总消息数 */
  readonly totalItems: number
  /** 保留的完整用户轮次 */
  readonly keptTurns: number
  /** 总用户轮次（含被固定的） */
  readonly totalTurns: number
  /** 因用户固定而不可进入压缩区间的轮次 */
  readonly pinnedTurns: number
}

export interface CompactionRangeOptions {
  /** 至少给最近上下文留多少字符（默认 12k；与 keepRecentTurns 二选一） */
  readonly keepRecentChars?: number | undefined
  /** 至少保留最近 N 个用户轮次；优先于字符预算 */
  readonly keepRecentTurns?: number | undefined
  /** 至少要压掉多少字符，避免"压了但没省"（默认 1500） */
  readonly minimumSavingsChars?: number | undefined
}

const DEFAULT_KEEP_RECENT_CHARS = 12_000
const MIN_PREFIX_CHARS = 1_500
/** 摘要请求本身的输入上限：超出就丢掉前缀最老的部分（保留最近） */
const MAX_TRANSCRIPT_CHARS = 60_000
const MAX_ITEM_CHARS = 2_000
const SUMMARY_MAX_TOKENS = 2_000
const SUMMARY_TIMEOUT_MS = 90_000

/**
 * 选一个**安全前缀**：只切在一条真正的用户提问之前。
 *
 * 为什么不按 token 精确切：切点必须落在轮边界，落在工具调用中间会让日志派生出一个
 * 没有配对的 tool result（`compaction-summary` 会 fail-closed，但那时已经付过摘要成本）。
 * 一条用户提问之前天然是工具事务的闭合点，这也是 09 §6.2 的边界选择算法在单会话里的落地。
 */
export function chooseCompactionRange(
  session: SessionService,
  options: CompactionRangeOptions = {},
): CompactionRangePlan | undefined {
  const items = deriveVisibleSurfaceItems(session.events())
  if (items.length < 2) return undefined

  const chars = items.map((item) => messageChars(item.message))
  const prefix = new Array<number>(items.length + 1).fill(0)
  for (let index = 0; index < items.length; index += 1) {
    prefix[index + 1] = (prefix[index] ?? 0) + (chars[index] ?? 0)
  }
  const total = prefix[items.length] ?? 0

  const keepRecentChars = Math.max(0, options.keepRecentChars ?? DEFAULT_KEEP_RECENT_CHARS)
  const minimumSavings = Math.max(MIN_PREFIX_CHARS, options.minimumSavingsChars ?? 0)
  const markers = deriveTurnMarkers(session.events())

  // 候选切点：用户提问（不含工具结果消息），且不能是第一条——前面没有东西可压
  const boundaries: number[] = []
  const allPrompts: number[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined || !isUserPrompt(item.message)) continue
    allPrompts.push(index)
    if (index > 0) boundaries.push(index)
  }
  // 固定轮次从**所有**提问算起：第一条被固定时，前面没有任何可压区间
  const pinned = allPrompts.filter((index) => {
    const item = items[index]
    return item !== undefined && markers.get(item.sourceSeq)?.pinned === true
  })
  const pinnedTurns = pinned.length
  // 固定轮次绝不能被吞进摘要：压缩右端点必须落在最早的固定轮之前
  const firstPinned = pinned[0]
  const pinnedLimit = firstPinned ?? items.length
  // end === pinnedLimit 是合法的：区间 [0,end) 正好在该轮开始前结束
  const viable = boundaries.filter((end) => end <= pinnedLimit && (prefix[end] ?? 0) >= minimumSavings && end < items.length)
  if (viable.length === 0) return undefined

  const turnCountAfter = (end: number): number => boundaries.filter((boundary) => boundary >= end).length
  const keepRecentTurns = options.keepRecentTurns
  let end: number | undefined
  if (keepRecentTurns !== undefined) {
    // 从后往前挑：留下至少 N 轮的前提下尽可能多压
    for (let index = viable.length - 1; index >= 0; index -= 1) {
      const candidate = viable[index]
      if (candidate !== undefined && turnCountAfter(candidate) >= Math.max(1, keepRecentTurns)) {
        end = candidate
        break
      }
    }
    end ??= viable[0]
  } else {
    /*
     * 从后往前挑：尽可能多压，但最近上下文至少留 keepRecentChars。
     * 一个都满足不了时退回**最早**的切点——宁可少压一点，也不能把最近几轮抹掉。
     */
    for (let index = viable.length - 1; index >= 0; index -= 1) {
      const candidate = viable[index]
      if (candidate === undefined) continue
      if (total - (prefix[candidate] ?? 0) >= keepRecentChars) {
        end = candidate
        break
      }
    }
    end ??= viable[0]
  }
  if (end === undefined) return undefined
  return {
    start: 0,
    end,
    prefixChars: prefix[end] ?? 0,
    keptItems: items.length - end,
    compactedItems: end,
    totalItems: items.length,
    keptTurns: turnCountAfter(end),
    totalTurns: allPrompts.length,
    pinnedTurns,
  }
}

export interface ModelCompactionSummarizerOptions {
  readonly ctx: Context
  readonly keepRecentChars?: number | undefined
  /** 注入点（测试用）；默认走 `ctx.get('llm')` + 默认模型 */
  readonly signal?: AbortSignal | undefined
}

export function createModelCompactionSummarizer(options: ModelCompactionSummarizerOptions): CompactionSummarizer {
  return async ({ session, keepRecentTurns }) => {
    const selection = options.ctx.get('agentDefaultModel').get()
    if (selection === undefined) throw new Error('没有默认模型，无法执行上下文摘要')

    const adapter = options.ctx.get('llm').get(selection.provider)
    if (adapter === undefined) throw new Error(`没有注册模型适配器：${selection.provider}`)

    const plan = chooseCompactionRange(session, {
      ...(keepRecentTurns === undefined
        ? { keepRecentChars: options.keepRecentChars }
        : { keepRecentTurns }),
    })
    if (plan === undefined) throw new Error('没有可压缩的安全范围')

    // 屏蔽轮次既然不进入模型请求，也不该被摘要成"之前讨论过"的内容
    const allowed = new Set(deriveRequestItems(session.events()).map((item) => item.sourceSeq))
    const items = deriveVisibleSurfaceItems(session.events())
      .slice(0, plan.end)
      .filter((item) => allowed.has(item.sourceSeq))
    const transcript = renderTranscript(items)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const prepared = await adapter.prepareCall(withSummaryParams(selection), { signal: controller.signal })
      const call = {
        ...prepared,
        request: {
          ...prepared.request,
          body: buildRequestBody(
            SUMMARY_SYSTEM_PROMPT,
            [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
            [],
          ),
        },
      }
      let streamed = ''
      let finalText = ''
      for await (const chunk of adapter.stream(call, controller.signal)) {
        if (chunk.type === 'text-delta') streamed += chunk.text
        if (chunk.type === 'done') finalText = assistantText(chunk.message)
      }
      const summary = (finalText === '' ? streamed : finalText).trim()
      if (summary === '') throw new Error('摘要模型返回了空内容')
      return summary
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 摘要请求只是文本生成：不暴露工具、压低温度、限制输出长度 */
function withSummaryParams(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    params: {
      ...(selection.params ?? {}),
      temperature: 0.2,
      maxTokens: SUMMARY_MAX_TOKENS,
    },
  }
}

/** 模型可见消息 → 摘要输入；工具调用/结果也保留形状，否则摘要会丢失"做过什么" */
export function renderTranscript(items: readonly VisibleSurfaceItem[]): string {
  const pieces: string[] = []
  for (const item of items) {
    const message = item.message
    const label = isToolResult(message)
      ? 'tool-result'
      : message.role === 'assistant'
        ? 'assistant'
        : 'user'
    pieces.push(`### ${label}\n${messageText(message).slice(0, MAX_ITEM_CHARS)}`)
  }
  const joined = pieces.join('\n\n')
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined
  // 前缀太长时保留最近的一大段：越靠近当前，越决定下一步怎么做
  const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.2)
  const tail = MAX_TRANSCRIPT_CHARS - head
  return `${joined.slice(0, head)}\n\n... [older transcript omitted] ...\n\n${joined.slice(-tail)}`
}

const SUMMARY_SYSTEM_PROMPT = [
  '你是 Lcode 的上下文压缩器。把给定的历史对话压缩成一段供同一个编码代理继续工作的摘要。',
  '',
  '必须保留：',
  '- 用户的目标、约束和明确要求；',
  '- 已完成的改动（文件路径、关键函数/接口名）与验证结果；',
  '- 重要决策及原因；',
  '- 尚未完成的事项与下一步。',
  '',
  '不要编造未发生的事实；不要保留寒暄和重复内容。用简洁的 Markdown 条目输出，',
  '不超过 1200 个汉字。只输出摘要本身，不要加前言。',
].join('\n')

function messageChars(message: ModelMessage): number {
  return messageText(message).length
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image' || block.type === 'image-ref') parts.push('[image]')
    else if (block.type === 'file-ref') parts.push(`[attachment: ${block.path}]\n${block.content}`)
    else if (block.type === 'skill') parts.push(`[skill: ${block.name}]`)
    else if (block.type === 'tool_use') parts.push(`[tool call ${block.name}] ${safeJson(block.input)}`)
    else if (block.type === 'tool_result') parts.push(`[tool result] ${typeof block.content === 'string' ? block.content : safeJson(block.content)}`)
  }
  return parts.join('\n')
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

function isToolResult(message: ModelMessage): message is Extract<ModelMessage, { readonly toolCallId: string }> {
  return message.role === 'user' && typeof (message as { readonly toolCallId?: unknown }).toolCallId === 'string'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
