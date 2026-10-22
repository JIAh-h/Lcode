import type { ModelSelection, SamplingParams } from '@lcode/agent-default-model'
import type { CredentialsService } from '@lcode/credentials'
import type {
  LlmAdapter,
  ModelInfo,
  ModelLimits,
  PrepareOpts,
  PreparedCall,
  ProviderInfo,
  RetryPolicy,
} from '@lcode/llm'
import type { AssistantMessage, ContentBlock, StreamChunk, TokenUsage } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/**
 * OpenAI 兼容协议适配器（批次④首个**真实**适配器）。
 *
 * ## 为什么是"一个适配器"而不是"每家一个"
 *
 * 设置页那句「仅支持 OpenAI 兼容协议」不是偷懒，是**刻意的收敛**：DeepSeek、Ollama 的
 * `/v1`、vLLM、LiteLLM、以及绝大多数自建网关都讲同一套 `POST /chat/completions`。
 * 所以一个实现就能覆盖这个弹窗的全部用途——差别只在 **base_url** 与模型名。
 * 将来某家出现真正的协议分叉（比如原生 tool-call 格式不同），再单独开包。
 *
 * ## 三条纪律的落点
 *
 * | 纪律 | 落点 |
 * |---|---|
 * | **D22 每次操作重新解析凭据** | `prepareCall` 内 `credentials.resolve()`，**不缓存**——轮换的 key 对下一个请求立即生效 |
 * | **I7 凭据值不泄漏** | 值只进 `request.headers`；`PreparedCall` 里不带 `apiKey` 字段；错误信息里不回显 key |
 * | **06 §5.3 热路径不 await 磁盘** | `prepareCall` 是唯一碰凭据的地方，`stream` 只发网络请求 |
 *
 * ## 关于 `request.body`
 *
 * `agent-loop` 会用 `withBody()` 把**内部形状**（`{ system, messages, tools }`）覆盖进
 * `PreparedCall.request.body`（见 `core/agent-loop/src/request.ts`）。这是对的：循环只负责
 * "从日志派生出模型该看到什么"，**翻译成各家协议是适配器的职责**。所以 `stream()` 把
 * 那份内部形状翻成 OpenAI 的 `{ model, messages, tools, stream }`。
 */

export interface OpenAiCompatibleOptions {
  /** 供应商 id（`ctx.llm` 里的 key，也是 `ModelSelection.provider`） */
  readonly id: string
  /** 显示名（设置页下拉里显示的那个） */
  readonly name: string
  /** 默认端点（用户没在设置里覆盖时用） */
  readonly baseUrl: string
  /** 默认凭据引用名（如 `OPENAI_API_KEY`）；`apiKeyRef: ''` 表示本端点不需要密钥（Ollama） */
  readonly apiKeyRef: string
  /** 凭据解析（每次调用现取，D22） */
  readonly credentials: CredentialsService
  /**
   * 用户级配置覆盖（18 §2.1 的 L4）。
   * 每项都可能缺——比如用户只填了 base_url 没填 key（本地模型）。
   */
  readonly overrides?: () => { readonly baseUrl?: string | undefined; readonly apiKeyRef?: string | undefined } | undefined
  /** 注入 fetch（测试用；默认全局 fetch） */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** 单次请求超时（默认 120s；流式响应是长连接，比 probe 的 30s 宽） */
  readonly timeoutMs?: number | undefined
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * DashScope（百炼）原生模型目录缓存。
 *
 * `GET /api/v1/models` 的 `output.models[].model_info.context_window` 才是**权威窗口**
 * （如 deepseek-v4.1-flash = 1000000）；而 `/compatible-mode/v1/models/{id}` 里的
 * `extra_info.default_envs.max_input_tokens` 只是部署默认 env（实测 129024，且 13 万 tokens
 * 的输入照常被接受）。目录有 300+ 条、分页返回，所以缓存 5 分钟。
 */
const CATALOG_TTL_MS = 5 * 60 * 1000
const CATALOG_PAGE_SIZE = 100
const CATALOG_MAX_PAGES = 6
const catalogCache = new Map<string, { readonly at: number; readonly models: Map<string, ModelLimits> }>()

/** `…/compatible-mode/v1` → `…/api/v1`；非 DashScope 形态返回 undefined */
function nativeApiBase(baseUrl: string): string | undefined {
  const marker = '/compatible-mode'
  const at = baseUrl.indexOf(marker)
  if (at < 0) return undefined
  return `${baseUrl.slice(0, at)}/api/v1`
}

export class OpenAiCompatibleAdapter implements LlmAdapter {
  private readonly options: OpenAiCompatibleOptions

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options
  }

  providerInfo(): ProviderInfo {
    return {
      id: this.options.id,
      name: this.options.name,
      capabilities: { streaming: true, reasoning: false, toolCalls: true },
    }
  }

  /**
   * 拉模型清单（`GET /models`）——也是 `probe`（测试连接）的实现。
   *
   * **超时由调用方给**（`model-api` 的 `withTimeout` 会 abort 这个 signal）；这里只负责
   * 把 abort 与网络错误翻成可路由的错误码。
   */
  async listModels(signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const { baseUrl, headers } = await this.resolveEndpoint()
    const jsonHeaders = { ...headers, accept: 'application/json' }
    const res = await this.request(`${baseUrl}/models`, { method: 'GET', headers: jsonHeaders, signal })
    const body = parseModelListResponse(await res.text())
    const list = Array.isArray(body.data) ? body.data : []
    const models: ModelInfo[] = list
      .filter((item): item is Record<string, unknown> & { id: string } => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string')
      .map((item) => {
        const limits = extractModelLimits(item)
        return {
          id: item.id,
          name: typeof item.name === 'string' ? item.name : item.id,
          ...(limits.contextWindow === undefined ? {} : { contextWindow: limits.contextWindow }),
        }
      })
    // 有原生目录时用它补上窗口：`/models` 常常只给 id
    const native = nativeApiBase(baseUrl)
    if (native !== undefined) {
      const catalog = await this.loadNativeCatalog(native, jsonHeaders, signal)
      if (catalog !== undefined) {
        for (const model of models) {
          if (model.contextWindow !== undefined) continue
          const hit = catalog.get(model.id)
          if (hit?.contextWindow !== undefined) (model as { contextWindow?: number }).contextWindow = hit.contextWindow
        }
      }
    }
    return models
  }

  /**
   * 读取供应商对单个模型的资源上限。
   *
   * OpenAI 的 `/models` 标准里没有窗口字段，但不少网关额外提供
   * `GET /models/{id}`（百炼的 `extra_info.default_envs.max_input_tokens`、
   * OpenRouter 的 `top_provider.context_length` 等）。拿不到就让调用方回落。
   */
  async describeModel(sel: ModelSelection, opts: PrepareOpts): Promise<ModelLimits> {
    opts.signal.throwIfAborted()
    const { baseUrl, headers } = await this.resolveEndpoint()
    const jsonHeaders = { ...headers, accept: 'application/json' }
    // DashScope 系优先读原生目录：`model_info.context_window` 才是权威窗口
    const native = nativeApiBase(baseUrl)
    if (native !== undefined) {
      const catalog = await this.loadNativeCatalog(native, jsonHeaders, opts.signal)
      const hit = catalog?.get(sel.model)
      if (hit !== undefined && (hit.contextWindow !== undefined || hit.maxOutputTokens !== undefined)) return hit
    }
    const res = await this.request(`${baseUrl}/models/${encodeURIComponent(sel.model)}`, {
      method: 'GET',
      // 元数据接口要 JSON；默认的 SSE accept 会让部分网关把响应包成 `data:` 帧
      headers: jsonHeaders,
      signal: opts.signal,
    })
    const value = parseMetadataJson(await res.text())
    if (value === undefined) return {}
    const root = isRecord(value) && isRecord(value['data']) ? value['data'] : value
    return extractModelLimits(root)
  }

  /**
   * 拉取（并缓存）DashScope 原生模型目录：`output.models[].model_info`。
   * 失败返回 undefined——这只是"更准的来源"，不该让主路径失败。
   */
  private async loadNativeCatalog(
    native: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Map<string, ModelLimits> | undefined> {
    const cached = catalogCache.get(native)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models
    try {
      const models = new Map<string, ModelLimits>()
      for (let page = 1; page <= CATALOG_MAX_PAGES; page += 1) {
        const res = await this.request(`${native}/models?page_no=${page}&page_size=${CATALOG_PAGE_SIZE}`, {
          method: 'GET',
          headers,
          signal,
        })
        const body = parseMetadataJson(await res.text())
        const output = isRecord(body) && isRecord(body['output']) ? body['output'] : undefined
        const list = output !== undefined && Array.isArray(output['models']) ? output['models'] : []
        for (const item of list) {
          if (!isRecord(item)) continue
          const id = item['model']
          if (typeof id !== 'string' || id === '') continue
          const info = isRecord(item['model_info']) ? item['model_info'] : undefined
          if (info === undefined) continue
          const limits = extractModelLimits(info)
          if (limits.contextWindow === undefined && limits.maxOutputTokens === undefined) continue
          models.set(id, limits)
        }
        const total = output !== undefined && typeof output['total'] === 'number' ? output['total'] : list.length
        if (list.length === 0 || page * CATALOG_PAGE_SIZE >= total) break
      }
      catalogCache.set(native, { at: Date.now(), models })
      return models
    } catch {
      return undefined
    }
  }

  /** OpenAI 兼容协议里 provider 与 model 是同一个坐标系，这里只做形状归一 */
  async resolveModel(sel: ModelSelection): Promise<{ provider: string; model: string }> {
    return { provider: this.options.id, model: sel.model }
  }

  /**
   * 「解析配置 → 拉凭据 → 物化默认值 → 构造请求」四件事锁在同一处（20 §6.2）。
   *
   * **凭据在这里现取**（D22）：不 localStorage、不闭包缓存、不用上次的值。
   * 用户轮换 key 后，**下一个请求**就该生效——这一条只能靠"每次重新解析"保证。
   */
  async prepareCall(sel: ModelSelection, opts: PrepareOpts): Promise<PreparedCall> {
    opts.signal.throwIfAborted()
    const { baseUrl, headers } = await this.resolveEndpoint()
    return {
      provider: this.options.id,
      model: sel.model,
      // 采样参数挂在 call 上：`agent-loop` 会用 withBody() 换掉 request.body，
      // 而 `stream()` 只拿得到这个 call——参数放这里才活得够久（见 PreparedCall 的注释）。
      ...(sel.params === undefined ? {} : { params: sel.params }),
      request: {
        endpoint: `${baseUrl}/chat/completions`,
        headers,
        // 起点 body。真正发出去的是 `stream()` 里用 withBody() 换进来的内部形状，
        // 由 `buildRequest()` 翻成 OpenAI 协议形状（见文件头注释）。
        body: EMPTY_INTERNAL_BODY,
      },
      retryPolicy: this.providerRetryPolicy(),
    }
  }

  /**
   * 发起流式请求并把 SSE 翻成 `StreamChunk`。
   *
   * 翻转规则（协议 → 内核）：
   * - `choices[].delta.content` → `text-delta`
   * - `choices[].delta.reasoning_content` → `reasoning-delta`（DeepSeek 等）
   * - `choices[].delta.tool_calls[]` → `tool-call-delta`（**按 index 累积**，见下）
   * - `usage` → `usage`（流尾）
   * - `finish_reason` → `done`（必须显式收尾，循环靠它判"本步结束"）
   *
   * **工具调用必须按 `index` 而不是 `id` 累积**：OpenAI 流式协议里第一个分片带 `id` 与
   * `function.name`，后续分片**只有 `index`**（id/name 缺省）。按 id 累积会把后半截参数丢掉。
   */
  async *stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const res = await this.request(call.request.endpoint, {
      method: 'POST',
      headers: { ...call.request.headers, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildRequest(call.model, call.params ?? {}, asInternalBody(call.request.body))),
      signal,
    })

    const acc = new Map<number, { id: string; name: string; args: string }>()
    let usage: TokenUsage | undefined
    /**
     * 正文累加器。
     *
     * ⚠️ **必须累加，不能只转发 `text-delta`**：`agent-loop` 把 `done.message` 当作
     * **权威**（`consumeStream` 里 `text` 只是用来判"取消时有没有可见内容"，落盘用的是
     * `done.message`）。所以适配器在 `done` 时必须给出**完整消息**——只发空 `content: []`
     * 会让日志里出现"chunk 有文本、assistant/message 却是空的"，
     * 而 `deriveMessages` 会跳过空 assistant 消息，**用户界面上什么都看不到**。
     *
     * 这个错误实测踩过：单测只断言了 chunk 翻译，没断言 `done` 的内容完整性，
     * 于是单元测试全绿而真实对话是空回复。
     */
    let parts = ''

    // 必须边读边翻译：若先把 Response.body 读完，界面会在请求结束后才一次性看到
    // 全部文本，`stream: true` 就失去了意义。
    for await (const event of parseSseStream(res, signal)) {
      if (event === '[DONE]') break
      let parsed: OpenAiStreamChunk
      try {
        parsed = JSON.parse(event) as OpenAiStreamChunk
      } catch {
        // 单个畸形分片不该毁掉整轮：跳过它（22 §4.4 的不猜只适用于**日志**，
        // 网络流是尽力而为，丢一个分片比中断整轮好）
        continue
      }

      /*
       * `usage` 必须**判 null**，不能只判 undefined。
       *
       * OpenAI 兼容的流式协议里，除最后一个分片外每个分片都会带 `"usage": null`
       * （DeepSeek、以及多数网关都这样）。只写 `!== undefined` 的话，`null` 会通过判断，
       * 紧接着 `null.prompt_tokens` 抛 TypeError，**整轮流被中断**。
       *
       * 实测踩过：设置页「测试连接」成功（那只打 `/models`，不流式），一对话就是
       * 一句笼统的失败——因为真实错误被吞在引擎里，界面上只剩"没能跑起来"。
       */
      if (isUsageObject(parsed.usage)) {
        usage = {
          input: parsed.usage.prompt_tokens ?? 0,
          output: parsed.usage.completion_tokens ?? 0,
          ...(parsed.usage.prompt_tokens_details?.cached_tokens !== undefined
            ? { cacheRead: parsed.usage.prompt_tokens_details.cached_tokens }
            : {}),
        }
        yield { type: 'usage', usage }
      }

      const choice = parsed.choices?.[0]
      if (choice === undefined) continue
      const delta = choice.delta
      if (delta !== undefined) {
        if (typeof delta.content === 'string' && delta.content !== '') {
          parts += delta.content
          yield { type: 'text-delta', text: delta.content }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          yield { type: 'reasoning-delta', text: delta.reasoning_content }
        }
        for (const piece of delta.tool_calls ?? []) {
          const index = piece.index ?? 0
          const slot = acc.get(index) ?? { id: '', name: '', args: '' }
          if (typeof piece.id === 'string' && piece.id !== '') slot.id = piece.id
          if (typeof piece.function?.name === 'string' && piece.function.name !== '') slot.name = piece.function.name
          const argsDelta = piece.function?.arguments
          if (typeof argsDelta === 'string' && argsDelta !== '') slot.args += argsDelta
          acc.set(index, slot)
          yield {
            type: 'tool-call-delta',
            callId: slot.id === '' ? `call_${index}` : slot.id,
            name: slot.name,
            argsDelta: typeof argsDelta === 'string' ? argsDelta : '',
          }
        }
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        yield {
          type: 'done',
          message: finalMessage(call, parts, acc),
          ...(usage === undefined ? {} : { usage }),
        }
        return
      }
    }

    // 流断在半路（服务端没送 finish_reason）：也要给 done，否则循环会一直等
    yield {
      type: 'done',
      message: finalMessage(call, parts, acc),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /**
   * 重试策略：只重试**连接类**与**限流**错误，不重试 4xx 里的确定性拒绝
   * （认证错、模型不存在、参数错——重试只是浪费时间且可能触发风控）。
   */
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

  // ─────────── 内部 ───────────

  /** 解析出生效的端点与请求头（含凭据值——它只在这里出现） */
  private async resolveEndpoint(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
    const overrides = this.options.overrides?.()
    const rawBase = overrides?.baseUrl ?? this.options.baseUrl
    const baseUrl = normalizeBaseUrl(rawBase)
    const refName = overrides?.apiKeyRef ?? this.options.apiKeyRef

    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (refName === '') return { baseUrl, headers } // 不需要密钥的端点（本地模型）

    const credential = await this.options.credentials.resolve(refName)
    if (credential === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_CREDENTIAL_MISSING,
        message: `未能解析凭据引用「${refName}」（provider=${this.options.id}）`,
        userMessage: `没有找到可用的 API Key。请到「设置 → 模型」填写，或设置环境变量 ${refName}。`,
        retryable: false,
      })
    }
    // ⚠️ 只写进 headers；**绝不**写进 body / 日志 / 错误信息（I7）
    headers['authorization'] = `Bearer ${credential.value}`
    return { baseUrl, headers }
  }

  /** 内部形状 → OpenAI 协议形状（适配器是唯一懂这家协议的地方） */
  private buildRequest(model: string, params: SamplingParams, internal: InternalBody): unknown {
    return {
      model,
      messages: toOpenAiMessages(internal),
      ...(params.maxTokens === undefined ? {} : { max_tokens: params.maxTokens }),
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      ...(internal.tools.length === 0 ? {} : { tools: internal.tools.map(toOpenAiTool) }),
      stream: true,
      // 让服务端在流尾带上 usage（不是所有实现都支持，带上不亏）
      stream_options: { include_usage: true },
    }
  }

  /**
   * 统一的 fetch 错误翻译（网络层 → 可路由错误码）。
   *
   * **这里加超时**：`model-api` 的 probe 有自己的 30s abort，但**流式对话**没有——
   * 一个不响应的端点会让整轮永远挂住。超时用 `AbortSignal.any` 与调用方的 signal 合并，
   * 于是"用户取消"与"超时"都能打断它，且**用户取消优先**（超时不该覆盖取消语义）。
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const doFetch = this.options.fetch ?? globalThis.fetch
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (init.signal !== undefined && init.signal !== null) signals.push(init.signal)
    const signal = AbortSignal.any(signals)

    let res: Response
    try {
      res = await doFetch(url, { ...init, signal })
    } catch (cause) {
      if (isAbort(cause)) {
        // 调用方取消 → 原样抛（循环靠 AbortError 判定"用户取消"）
        if (init.signal?.aborted === true) throw cause
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EN_TIMEOUT,
          message: `请求 ${redact(url)} 超时（${timeoutMs}ms）`,
          userMessage: '模型服务响应太慢，已经等超时了。',
          retryable: true,
          cause,
        })
      }
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_ENDPOINT_UNREACHABLE,
        message: `请求 ${redact(url)} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
        userMessage: '连不上这个模型服务。请检查接口地址与网络。',
        retryable: true,
        cause,
      })
    }
    if (!res.ok) throw await httpError(res, url)
    return res
  }
}

/**
 * OpenAI-compatible providers normally return `{ data: [...] }` for `GET /models`.
 * Some gateways, including BaiLian workspace endpoints, wrap that same object in
 * SSE `data:` frames. Treat both transport envelopes as one model-list contract.
 */
function parseModelListResponse(text: string): { data?: unknown[] } {
  try {
    return JSON.parse(text) as { data?: unknown[] }
  } catch {
    for (const event of parseSse(text)) {
      if (event === '[DONE]') continue
      try {
        const parsed = JSON.parse(event) as { data?: unknown }
        if (Array.isArray(parsed.data)) return parsed as { data?: unknown[] }
      } catch {
        // Ignore malformed heartbeat frames; a later frame may carry the list.
      }
    }
  }

  throw new LcodeErrorImpl({
    code: ERROR_CODES.EL_MODEL_ERROR,
    message: '模型服务返回的模型清单不是可识别的 JSON 或 SSE 数据帧',
    userMessage: '模型服务返回了无法识别的模型清单。请检查该服务是否支持 OpenAI 兼容的 /models 接口。',
    retryable: false,
  })
}

interface InternalBody {
  readonly system: string
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[]
}

/** 起点 body：`prepareCall` 返回后立刻会被 `agent-loop` 用真实内容覆盖 */
const EMPTY_INTERNAL_BODY: InternalBody = { system: '', messages: [], tools: [] }

/**
 * 把 `PreparedCall.request.body`（**内部形状**，由 `agent-loop` 的
 * `buildRequestBody()` 装配）收窄成 `InternalBody`。
 *
 * 为什么要收窄而不是直接断言：这个 body 是**跨包**传过来的 `unknown`，
 * 而且理论上可能被协作点（`agent/request` waterfall）整个换掉。逐字段兜底能让
 * "形状不对"退化成一个可用的空请求，而不是 `undefined.map` 那种炸在深处的 TypeError。
 */
function asInternalBody(raw: unknown): InternalBody {
  if (typeof raw !== 'object' || raw === null) return EMPTY_INTERNAL_BODY
  const record = raw as Record<string, unknown>
  return {
    system: typeof record['system'] === 'string' ? record['system'] : '',
    messages: Array.isArray(record['messages']) ? (record['messages'] as InternalBody['messages']) : [],
    tools: Array.isArray(record['tools']) ? (record['tools'] as InternalBody['tools']) : [],
  }
}

interface OpenAiStreamChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: unknown
      readonly reasoning_content?: unknown
      readonly tool_calls?: readonly {
        readonly index?: number
        readonly id?: unknown
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown }
      }[]
    }
    readonly finish_reason?: unknown
  }[]
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
    readonly prompt_tokens_details?: { readonly cached_tokens?: number }
  } | null
}

/** 去掉末尾斜杠，避免拼出 `//chat/completions`（有些网关会把它当成不同路由） */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * `usage` 字段是不是一个**真的对象**。
 *
 * 流式协议里绝大多数分片带的是 `"usage": null`（只有最后一个才给真值），
 * 所以这里必须把 `null` 与"缺字段"一视同仁地排除掉。
 */
function isUsageObject(value: unknown): value is NonNullable<OpenAiStreamChunk['usage']> {
  return typeof value === 'object' && value !== null
}

/**
 * 把本轮流式累积的内容组装成**最终的 assistant 消息**。
 *
 * 这是 `done` 的载荷，也是 `agent-loop` 落进 `assistant/message` 的那份——**权威**。
 * 顺序按内容块出现次序：正文文本在工具调用之前（协议里也是这么流的）。
 */
function finalMessage(
  call: PreparedCall,
  text: string,
  toolCalls: ReadonlyMap<number, { id: string; name: string; args: string }>,
): AssistantMessage {
  const content: ContentBlock[] = []
  if (text !== '') content.push({ type: 'text', text })
  // 按 index 排序：协议给的就是有序的，Map 的插入序在乱序分片下不可靠
  for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
    const call_ = toolCalls.get(index)
    if (call_ === undefined || call_.name === '') continue
    let input: unknown = {}
    try {
      input = call_.args === '' ? {} : JSON.parse(call_.args)
    } catch {
      // 参数不是合法 JSON：**不猜**，如实落空对象（引擎的 rawArgs 仍保留原始串，D9）
      input = {}
    }
    content.push({ type: 'tool_use', id: call_.id === '' ? `call_${index}` : call_.id, name: call_.name, input: input as never })
  }
  return { role: 'assistant', content, provider: call.provider, model: call.model }
}

function toOpenAiTool(tool: InternalBody['tools'][number]): unknown {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }
}

/**
 * 内部消息 → OpenAI 消息。
 *
 * 内部形状里的 `content` 是**内容块数组**（`text` / `tool_use` / `tool_result` 三种），
 * 而 OpenAI 协议把它拆成不同字段（`content` / `tool_calls` / `role: 'tool'`）。这个翻译
 * 必须在这里做——循环不该知道任何一家协议的形状。
 */
function toOpenAiMessages(internal: InternalBody): unknown[] {
  const out: unknown[] = []
  if (internal.system !== '') out.push({ role: 'system', content: internal.system })

  for (const message of internal.messages) {
    /*
     * ⚠️ **消息级的工具结果**（`role:'user'` + 顶层 `toolCallId`）必须**先**判。
     *
     * 这是 `ToolResultMessage` 的形状（`deriveMessages` 从 `tool/result` 派生出来的）：
     * `toolCallId` 在**消息上**，`content` 是一段普通字符串。
     *
     * 原来只判了"内容块里有没有 `tool_result` 块"，而那个形状**引擎从来不会产出**。
     * 于是工具结果落进了下面的普通分支，以 `role:'user'` 发出去——模型看到的是一串
     * 用户消息，**完全看不出工具跑过**，于是反复调同一个工具。
     *
     * 实测踩过：9 秒内 1095 次 `tool/call`，没有 `turn/end`（死循环）。
     * 这个 bug 只在**真实工具调用**时才出现——纯文本对话永远碰不到。
     */
    if (isToolResultMessage(message)) {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: toolResultToText(message.content),
      })
      continue
    }

    const blocks = Array.isArray(message.content) ? message.content : []
    if (blocks.length === 0) {
      out.push({ role: message.role, content: typeof message.content === 'string' ? message.content : '' })
      continue
    }
    // 内容块形式的工具结果（另一条协议路径）→ 一条或多条 role:'tool'
    const results = blocks.filter((b): b is { type: 'tool_result'; toolCallId: string; content: unknown; isError?: boolean } =>
      isBlock(b, 'tool_result'),
    )
    if (results.length > 0) {
      for (const result of results) {
        out.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: toolResultToText(result.content),
        })
      }
      continue
    }
    const toolUses = blocks.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
      isBlock(b, 'tool_use'),
    )
    const texts = blocks.filter((b): b is { type: 'text'; text: string } => isBlock(b, 'text'))
    out.push({
      role: message.role,
      content: texts.map((t) => t.text).join(''),
      ...(toolUses.length === 0
        ? {}
        : {
            tool_calls: toolUses.map((use) => ({
              id: use.id,
              type: 'function',
              function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
            })),
          }),
    })
  }
  return out
}

/** 消息级的工具结果（`ToolResultMessage`：`toolCallId` 在消息上，不在内容块里） */
function isToolResultMessage(
  message: InternalBody['messages'][number],
): message is InternalBody['messages'][number] & { toolCallId: string; content: unknown } {
  return typeof (message as { toolCallId?: unknown }).toolCallId === 'string'
}

function isBlock<T extends string>(value: unknown, type: T): value is { type: T } & Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type
}

function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (isBlock(block, 'text') ? String((block as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

/** SSE 解析：按行取 `data:` 载荷（OpenAI 用纯 `data:` 行 + 空行分隔） */
export function* parseSse(text: string): Generator<string> {
  for (const rawLine of text.split('\n')) {
    const payload = sseData(rawLine)
    if (payload !== undefined) yield payload
  }
}

/**
 * 增量解析 SSE 响应体。
 *
 * 网络分块不保证与 SSE 行边界对齐，因此保留未完成的一行，直到下一个分块补齐它。
 * 这也让暂停操作能取消正在等待的 `reader.read()`。
 */
export async function* parseSseStream(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (res.body === null) {
    const text = await res.text()
    signal.throwIfAborted()
    yield* parseSse(text)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break

      buffered += decoder.decode(value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const payload = sseData(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        if (payload !== undefined) yield payload
        newline = buffered.indexOf('\n')
      }
    }

    buffered += decoder.decode()
    if (buffered !== '') {
      const payload = sseData(buffered)
      if (payload !== undefined) yield payload
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // Reader may already have been released by a runtime after cancellation.
    }
  }
}

function sseData(rawLine: string): string | undefined {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice(5).trim()
  return payload === '' ? undefined : payload
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** HTTP 非 2xx → 可路由错误（**不回显响应体里的敏感内容**，只取短前缀） */
async function httpError(res: Response, url: string): Promise<LcodeErrorImpl> {
  const status = res.status
  const base = { message: `${redact(url)} 返回 HTTP ${status}`, retryable: false } as const
  // 状态码 → 错误码的映射是固定的：**归因由这里定死**，`model-api` 的 probe 只是转述
  if (status === 401 || status === 403) {
    return new LcodeErrorImpl({
      ...base,
      code: ERROR_CODES.EL_CREDENTIAL_REJECTED,
      userMessage: 'API Key 被拒绝了。请到「设置 → 模型」检查密钥是否有效。',
    })
  }
  if (status === 404) {
    return new LcodeErrorImpl({
      ...base,
      code: ERROR_CODES.EL_UNKNOWN_MODEL,
      userMessage: '接口地址或模型名不对，服务端说找不到。',
    })
  }
  if (status === 429) {
    return new LcodeErrorImpl({
      ...base,
      code: ERROR_CODES.EL_RATE_LIMITED,
      userMessage: '请求太频繁了，稍等一下再试。',
      retryable: true,
    })
  }
  if (status === 400 || status === 422) {
    /*
     * 上下文溢出在 OpenAI 兼容生态里几乎都以 400/422 出现，**协议本身没有结构化错误码**
     * （只有 `context_length_exceeded` 这类文案）。把这段翻译收在适配器里：
     * 上层只认 `EL-CONTEXT_OVERFLOW`，绝不按供应商文案分支（09 §5.3）。
     */
    const detail = await readErrorBody(res)
    if (isContextOverflowText(detail)) {
      return new LcodeErrorImpl({
        ...base,
        message: `${base.message}：${detail}`,
        code: ERROR_CODES.EL_CONTEXT_OVERFLOW,
        userMessage: '这次请求超出了模型的上下文窗口。',
      })
    }
    return new LcodeErrorImpl({
      ...base,
      message: detail === '' ? base.message : `${base.message}：${detail}`,
      code: ERROR_CODES.EL_MODEL_ERROR,
      userMessage: '模型服务说这次请求不合法（多半是参数或上下文太长）。',
    })
  }
  if (status >= 500) {
    return new LcodeErrorImpl({
      ...base,
      code: ERROR_CODES.EL_MODEL_ERROR,
      userMessage: '模型服务自己出错了，稍后重试。',
      retryable: true,
    })
  }
  return new LcodeErrorImpl({
    ...base,
    code: ERROR_CODES.EL_MODEL_ERROR,
    userMessage: '请求被模型服务拒绝了。',
  })
}

/** 读取并裁剪错误响应体；读不出来不影响归因（空串即可） */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * 供应商错误文案 → 上下文溢出。这是**唯一**允许按文案判断的地方：
 * 适配器本来就负责协议/供应商差异，再往上一层就必须只看错误码。
 */
function isContextOverflowText(detail: string): boolean {
  if (detail === '') return false
  return [
    /context[ _-]?(length|window)/i,
    /maximum context/i,
    /too many tokens/i,
    /prompt is too long/i,
    /input is too long/i,
    /reduce (the )?(length|size)/i,
    /exceed(?:s|ed)?[^.]{0,40}(token|context)/i,
    /上下文[^。]{0,20}(超|过长|长度)/,
    /超出[^。]{0,20}上下文/,
  ].some((pattern) => pattern.test(detail))
}

/** 去掉 URL 里的查询串（可能含 `?key=` 之类的凭据），只留路径 */
/**
 * 从 `/models` 或 `/models/{id}` 的单项里提取资源上限。
 *
 * 已知形态：
 * - 官方 DeepSeek：`context_window` / `max_output_tokens`
 * - 百炼：`extra_info.default_envs.max_input_tokens` / `max_output_tokens`
 * - OpenRouter：`top_provider.context_length`
 * - vLLM/TGI 风格：`max_model_len` / `max_context_length`
 * 字段缺失就留空——**不猜**，由调用方回落到保守值。
 */
/** 元数据接口的 JSON：兼容少数网关把 JSON 包在 `data:` SSE 帧里的形态 */
function parseMetadataJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    for (const event of parseSse(text)) {
      if (event === '[DONE]') continue
      try {
        return JSON.parse(event) as unknown
      } catch {
        // 继续看下一帧
      }
    }
    return undefined
  }
}

function extractModelLimits(value: unknown): ModelLimits {
  if (!isRecord(value)) return {}
  const extraInfo = isRecord(value['extra_info']) ? value['extra_info'] : undefined
  const envs = extraInfo !== undefined && isRecord(extraInfo['default_envs']) ? extraInfo['default_envs'] : undefined
  const topProvider = isRecord(value['top_provider']) ? value['top_provider'] : undefined
  const contextWindow = firstPositive(
    value['context_window'],
    value['context_length'],
    value['max_context_length'],
    value['max_input_tokens'],
    value['input_token_limit'],
    value['max_model_len'],
    envs?.['max_input_tokens'],
    topProvider?.['context_length'],
  )
  const maxOutputTokens = firstPositive(
    value['max_output_tokens'],
    value['max_completion_tokens'],
    envs?.['max_output_tokens'],
  )
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redact(url: string): string {
  const at = url.indexOf('?')
  return at < 0 ? url : `${url.slice(0, at)}?…`
}
