import type { ModelSelection, SamplingParams } from '@lcode/agent-default-model'
import type { CredentialsService } from '@lcode/credentials'
import type {
  LlmAdapter,
  ModelInfo,
  PrepareOpts,
  PreparedCall,
  ProviderInfo,
  RetryPolicy,
} from '@lcode/llm'
import type { AssistantMessage, ContentBlock, StreamChunk, TokenUsage } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/**
 * Anthropic Messages API 适配器（自定义「Anthropic Compatible」）。
 *
 * 只负责协议翻译：内部请求体（system/messages/tools）→ `/v1/messages`，SSE 事件 →
 * 统一的 StreamChunk。工具调用与正文一样按内容块顺序累积，`done.message` 是权威结果。
 */

export interface AnthropicCompatibleOptions {
  readonly id: string
  readonly name: string
  /** 默认端点；用户没在设置里覆盖时用 */
  readonly baseUrl: string
  /** 默认凭据引用名；空串表示不需要密钥 */
  readonly apiKeyRef: string
  readonly credentials: CredentialsService
  readonly overrides?: (() => { readonly baseUrl?: string | undefined; readonly apiKeyRef?: string | undefined } | undefined) | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
}

const DEFAULT_TIMEOUT_MS = 120_000
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8_192

interface InternalBody {
  readonly system: string
  readonly messages: readonly { readonly role: string; readonly content?: unknown; readonly toolCallId?: unknown }[]
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]
}

const EMPTY_INTERNAL_BODY: InternalBody = { system: '', messages: [], tools: [] }

export class AnthropicCompatibleAdapter implements LlmAdapter {
  constructor(private readonly options: AnthropicCompatibleOptions) {}

  providerInfo(): ProviderInfo {
    return {
      id: this.options.id,
      name: this.options.name,
      capabilities: { streaming: true, reasoning: false, toolCalls: true },
    }
  }

  async listModels(signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const { baseUrl, headers } = await this.resolveEndpoint()
    const res = await this.request(modelsEndpoint(baseUrl), { method: 'GET', headers, signal })
    // 自定义 Anthropic 网关不一定实现 /models：404 视为“没有目录”，模型名由用户手填
    if (res.status === 404) return []
    if (!res.ok) throw await httpError(res, modelsEndpoint(baseUrl))
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return []
    }
    const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
    if (!Array.isArray(data)) return []
    return data.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      if (typeof record['id'] !== 'string') return []
      return [{
        id: record['id'],
        name: typeof record['display_name'] === 'string' ? record['display_name'] : record['id'],
      }]
    })
  }

  async resolveModel(sel: ModelSelection): Promise<{ provider: string; model: string }> {
    return { provider: this.options.id, model: sel.model }
  }

  async prepareCall(sel: ModelSelection, opts: PrepareOpts): Promise<PreparedCall> {
    opts.signal.throwIfAborted()
    const { baseUrl, headers } = await this.resolveEndpoint()
    return {
      provider: this.options.id,
      model: sel.model,
      ...(sel.params === undefined ? {} : { params: { ...sel.params } }),
      request: {
        endpoint: messagesEndpoint(baseUrl),
        headers: { ...headers, accept: 'text/event-stream' },
        body: EMPTY_INTERNAL_BODY,
      },
      retryPolicy: this.providerRetryPolicy(),
    }
  }

  async *stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const body = buildRequest(call, asInternalBody(call.request.body))
    const res = await this.request(call.request.endpoint, {
      method: 'POST',
      headers: { ...call.request.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw await httpError(res, call.request.endpoint)
    if (res.body === null) throw new LcodeErrorImpl({
      code: ERROR_CODES.EL_MODEL_ERROR,
      message: 'Anthropic 响应没有 body',
      userMessage: '模型服务没有返回内容。',
      retryable: false,
    })

    const blocks = new Map<number, TextBlock | ToolBlock>()
    let inputTokens = 0
    let outputTokens = 0
    for await (const event of parseSse(res.body, signal)) {
      const type = typeof event['type'] === 'string' ? event['type'] : ''
      if (type === 'message_start') {
        const message = event['message']
        const usage = typeof message === 'object' && message !== null
          ? readUsage((message as Record<string, unknown>)['usage'])
          : { input: 0, output: 0 }
        inputTokens = usage.input
        continue
      }
      if (type === 'content_block_start') {
        const index = typeof event['index'] === 'number' ? event['index'] : 0
        const block = event['content_block']
        if (typeof block !== 'object' || block === null) continue
        const record = block as Record<string, unknown>
        if (record['type'] === 'tool_use') {
          const id = typeof record['id'] === 'string' ? record['id'] : `call_${index}`
          const name = typeof record['name'] === 'string' ? record['name'] : ''
          const input = record['input']
          // Anthropic 的 start 通常给空对象占位，真正的参数在 input_json_delta；
          // 把 `{}` 也当参数发出会让 engine 的 rawArgs 变成 `{}{...}`（非法 JSON）。
          const initial = input === undefined || (typeof input === 'object' && input !== null && Object.keys(input).length === 0)
            ? ''
            : JSON.stringify(input)
          blocks.set(index, { kind: 'tool', id, name, args: initial })
          yield { type: 'tool-call-delta', callId: id, name, argsDelta: initial }
          continue
        }
        if (record['type'] === 'text') {
          const initial = typeof record['text'] === 'string' ? record['text'] : ''
          blocks.set(index, { kind: 'text', text: initial })
        }
        continue
      }
      if (type === 'content_block_delta') {
        const index = typeof event['index'] === 'number' ? event['index'] : 0
        const block = blocks.get(index)
        const delta = event['delta']
        if (block === undefined || typeof delta !== 'object' || delta === null) continue
        const record = delta as Record<string, unknown>
        if (block.kind === 'text' && record['type'] === 'text_delta' && typeof record['text'] === 'string') {
          block.text += record['text']
          yield { type: 'text-delta', text: record['text'] }
          continue
        }
        if (block.kind === 'tool' && record['type'] === 'input_json_delta' && typeof record['partial_json'] === 'string') {
          block.args += record['partial_json']
          yield { type: 'tool-call-delta', callId: block.id, name: block.name, argsDelta: record['partial_json'] }
          continue
        }
        if (record['type'] === 'thinking_delta' && typeof record['thinking'] === 'string') {
          yield { type: 'reasoning-delta', text: record['thinking'] }
        }
        continue
      }
      if (type === 'message_delta') {
        outputTokens = readUsage(event['usage']).output || outputTokens
        continue
      }
      if (type === 'message_stop') {
        break
      }
      if (type === 'error') {
        throw anthropicError(event, call.request.endpoint)
      }
    }

    const usage: TokenUsage | undefined = inputTokens > 0 || outputTokens > 0
      ? { input: inputTokens, output: outputTokens }
      : undefined
    if (usage !== undefined) yield { type: 'usage', usage }
    yield {
      type: 'done',
      message: finalMessage(call, blocks),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  providerRetryPolicy(): RetryPolicy {
    return {
      maxAttempts: 3,
      baseDelayMs: 500,
      shouldRetry: (errorCode) =>
        errorCode === ERROR_CODES.EN_TIMEOUT ||
        errorCode === ERROR_CODES.EL_RATE_LIMITED ||
        errorCode === ERROR_CODES.EL_ENDPOINT_UNREACHABLE,
    }
  }

  private async resolveEndpoint(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
    const overrides = this.options.overrides?.()
    const baseUrl = normalizeBaseUrl(overrides?.baseUrl ?? this.options.baseUrl)
    const refName = overrides?.apiKeyRef ?? this.options.apiKeyRef
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_VERSION,
      accept: 'application/json',
    }
    if (refName === '') return { baseUrl, headers }
    const credential = await this.options.credentials.resolve(refName)
    if (credential === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_CREDENTIAL_MISSING,
        message: `未能解析凭据引用「${refName}」（provider=${this.options.id}）`,
        userMessage: `没有找到可用的 API Key。请到「设置 → 模型」填写，或设置环境变量 ${refName}。`,
        retryable: false,
      })
    }
    // 官方 Anthropic 用 x-api-key；部分兼容网关用 Bearer，两个都带上
    headers['x-api-key'] = credential.value
    headers['authorization'] = `Bearer ${credential.value}`
    return { baseUrl, headers }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const doFetch = this.options.fetch ?? globalThis.fetch
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (init.signal !== undefined && init.signal !== null) signals.push(init.signal)
    const signal = AbortSignal.any(signals)
    try {
      return await doFetch(url, { ...init, signal })
    } catch (cause) {
      if (init.signal?.aborted === true) throw cause
      if (isAbort(cause)) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EN_TIMEOUT,
          message: `请求 ${url} 超时（${timeoutMs}ms）`,
          userMessage: '模型服务响应太慢，已经等超时了。',
          retryable: true,
          cause,
        })
      }
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_ENDPOINT_UNREACHABLE,
        message: `请求 ${url} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
        userMessage: '连不上这个模型服务。请检查接口地址与网络。',
        retryable: true,
        cause,
      })
    }
  }
}

interface TextBlock {
  readonly kind: 'text'
  text: string
}

interface ToolBlock {
  readonly kind: 'tool'
  readonly id: string
  readonly name: string
  args: string
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function messagesEndpoint(baseUrl: string): string {
  if (baseUrl.endsWith('/messages')) return baseUrl
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/messages`
  return `${baseUrl}/v1/messages`
}

function modelsEndpoint(baseUrl: string): string {
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/models`
  return `${baseUrl}/v1/models`
}

function asInternalBody(raw: unknown): InternalBody {
  if (typeof raw !== 'object' || raw === null) return EMPTY_INTERNAL_BODY
  const record = raw as Record<string, unknown>
  return {
    system: typeof record['system'] === 'string' ? record['system'] : '',
    messages: Array.isArray(record['messages'])
      ? (record['messages'] as InternalBody['messages'])
      : [],
    tools: Array.isArray(record['tools']) ? (record['tools'] as InternalBody['tools']) : [],
  }
}

function buildRequest(call: PreparedCall, internal: InternalBody): unknown {
  const params: SamplingParams = call.params ?? {}
  return {
    model: call.model,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(internal.system === '' ? {} : { system: internal.system }),
    messages: toAnthropicMessages(internal),
    ...(internal.tools.length === 0
      ? {}
      : {
          tools: internal.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
    stream: true,
  }
}

function toAnthropicMessages(internal: InternalBody): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: unknown[]): void => {
    if (blocks.length === 0) return
    const last = out.at(-1)
    // Anthropic 期望 user/assistant 交替；相邻同角色（工具结果）合并为一轮
    if (last !== undefined && last.role === role) {
      last.content.push(...blocks)
      return
    }
    out.push({ role, content: blocks })
  }

  for (const message of internal.messages) {
    if (typeof message.toolCallId === 'string') {
      push('user', [toolResultBlock(message.toolCallId, message.content, false)])
      continue
    }
    const rawBlocks = Array.isArray(message.content) ? message.content : []
    if (rawBlocks.length === 0) {
      const text = typeof message.content === 'string' ? message.content : ''
      if (text !== '') push(message.role === 'assistant' ? 'assistant' : 'user', [{ type: 'text', text }])
      continue
    }
    const blocks = rawBlocks.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
    const toolResults = blocks.filter((block) => block['type'] === 'tool_result')
    if (toolResults.length > 0) {
      push('user', toolResults.map((block) =>
        toolResultBlock(
          typeof block['toolCallId'] === 'string' ? block['toolCallId'] : '',
          block['content'],
          block['isError'] === true,
        ),
      ))
      continue
    }
    if (message.role === 'assistant') {
      const content: unknown[] = []
      for (const block of blocks) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          content.push({ type: 'text', text: block['text'] })
        } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
          content.push({ type: 'tool_use', id: block['id'], name: block['name'], input: block['input'] ?? {} })
        }
      }
      push('assistant', content)
      continue
    }
    const content: unknown[] = []
    const textParts: string[] = []
    const images: unknown[] = []
    for (const block of blocks) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') textParts.push(block['text'])
      else if (block['type'] === 'skill') {
        textParts.push(`[Skill: ${String(block['name'] ?? block['id'] ?? '')}]\n${String(block['instructions'] ?? '')}`)
      } else if (block['type'] === 'file-ref') {
        textParts.push(`[Attachment: ${String(block['path'] ?? '')}]\n${String(block['content'] ?? '')}`)
      } else if (block['type'] === 'image' && typeof block['mediaType'] === 'string' && typeof block['data'] === 'string') {
        images.push({
          type: 'image',
          source: { type: 'base64', media_type: block['mediaType'], data: block['data'] },
        })
      }
    }
    if (textParts.length > 0) content.push({ type: 'text', text: textParts.join('\n\n') })
    content.push(...images)
    push('user', content)
  }
  return out
}

function toolResultBlock(toolUseId: string, content: unknown, isError: boolean): unknown {
  const blocks: unknown[] = Array.isArray(content)
    ? content.flatMap((block): unknown[] => {
        if (typeof block !== 'object' || block === null) return []
        const record = block as Record<string, unknown>
        if (record['type'] === 'text' && typeof record['text'] === 'string') return [{ type: 'text', text: record['text'] }]
        if (record['type'] === 'image' && typeof record['mediaType'] === 'string' && typeof record['data'] === 'string') {
          return [{ type: 'image', source: { type: 'base64', media_type: record['mediaType'], data: record['data'] } }]
        }
        return []
      })
    : [{ type: 'text', text: typeof content === 'string' ? content : '' }]
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: blocks,
    ...(isError ? { is_error: true } : {}),
  }
}

function finalMessage(call: PreparedCall, blocks: ReadonlyMap<number, TextBlock | ToolBlock>): AssistantMessage {
  const content: ContentBlock[] = []
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index)
    if (block === undefined) continue
    if (block.kind === 'text') {
      if (block.text !== '') content.push({ type: 'text', text: block.text })
      continue
    }
    let input: unknown = {}
    try {
      input = block.args === '' ? {} : JSON.parse(block.args)
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: block.id, name: block.name, input: input as never })
  }
  return { role: 'assistant', content, provider: call.provider, model: call.model }
}

function readUsage(value: unknown): { input: number; output: number } {
  if (typeof value !== 'object' || value === null) return { input: 0, output: 0 }
  const record = value as Record<string, unknown>
  return {
    input: typeof record['input_tokens'] === 'number' ? record['input_tokens'] : 0,
    output: typeof record['output_tokens'] === 'number' ? record['output_tokens'] : 0,
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '' || payload === '[DONE]') continue
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>
            yield parsed
          } catch {
            // 单个畸形分片不毁整轮
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function anthropicError(event: Record<string, unknown>, url: string): LcodeErrorImpl {
  const error = event['error']
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const message = typeof record['message'] === 'string' ? record['message'] : 'unknown error'
  return new LcodeErrorImpl({
    code: isContextOverflowText(message) ? ERROR_CODES.EL_CONTEXT_OVERFLOW : ERROR_CODES.EL_MODEL_ERROR,
    message: `${url} 流式错误：${message}`,
    userMessage: isContextOverflowText(message) ? '这次请求超出了模型的上下文窗口。' : '模型服务返回了错误。',
    retryable: false,
  })
}

async function httpError(res: Response, url: string): Promise<LcodeErrorImpl> {
  const status = res.status
  const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 500)
  const base = { message: `${url} 返回 HTTP ${status}${detail === '' ? '' : `：${detail}`}`, retryable: false } as const
  if (status === 401 || status === 403) {
    return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_CREDENTIAL_REJECTED, userMessage: 'API Key 被拒绝了。请到「设置 → 模型」检查密钥是否有效。' })
  }
  if (status === 404) {
    return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_UNKNOWN_MODEL, userMessage: '接口地址或模型名不对，服务端说找不到。' })
  }
  if (status === 429) {
    return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_RATE_LIMITED, userMessage: '请求太频繁了，稍等一下再试。', retryable: true })
  }
  if (status === 400 || status === 422) {
    if (isContextOverflowText(detail)) {
      return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_CONTEXT_OVERFLOW, userMessage: '这次请求超出了模型的上下文窗口。' })
    }
    return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_MODEL_ERROR, userMessage: '模型服务说这次请求不合法（多半是参数或上下文太长）。' })
  }
  if (status >= 500) {
    return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_MODEL_ERROR, userMessage: '模型服务自己出错了，稍后重试。', retryable: true })
  }
  return new LcodeErrorImpl({ ...base, code: ERROR_CODES.EL_MODEL_ERROR, userMessage: '请求被模型服务拒绝了。' })
}

function isContextOverflowText(text: string): boolean {
  return /context(?:_|\s)length|context.*too|too.*(long|large)|maximum.*token|exceed.*context|prompt.*too.*long/i.test(text)
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (
    (error as { name?: unknown }).name === 'AbortError' ||
    (error as { name?: unknown }).name === 'TimeoutError'
  )
}