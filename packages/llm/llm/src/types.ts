import type { StreamChunk } from '@lcode/session'
import type { ModelSelection, SamplingParams } from '@lcode/agent-default-model'

export type { SamplingParams }

/** 供应商信息（能力探测的输入） */
export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly capabilities: {
    readonly streaming: boolean
    readonly reasoning: boolean
    readonly toolCalls: boolean
  }
}

/** 模型信息（listModels 的输出） */
export interface ModelInfo {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  /** 供应商是否声明支持图片输入；缺省 = 未知，不擅自当成不支持 */
  readonly vision?: boolean
}

/** 一次调用前的完整准备结果（prepareCall 的输出） */
export interface PreparedCall {
  readonly provider: string
  readonly model: string
  /**
   * 采样参数（`maxTokens` / `temperature` / `reasoningEffort`）。
   *
   * **必须挂在 call 上，不能只留在 `ModelSelection` 里**：`agent-loop` 会用
   * `withBody()` 把 `request.body` 换成从日志派生的内部形状，而 `stream()` 拿到的
   * 只有这个 `PreparedCall`——参数若不在上面，适配器就再也读不到它们了。
   * （`ModelSelection` 在 `prepareCall` 返回后就不在调用链上了。）
   */
  readonly params?: SamplingParams | undefined
  /** 已物化请求（含凭据解析后的端点 / headers 引用；**值不进日志**，I7） */
  readonly request: {
    readonly endpoint: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: unknown
  }
  readonly retryPolicy: RetryPolicy
}

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  /** 是否对某错误码退避重试 */
  shouldRetry(errorCode: string): boolean
}

export interface PrepareOpts {
  readonly signal: AbortSignal
  /** 物化默认值时所需的采样参数覆盖 */
  readonly params?: ModelSelection['params']
}

/** 单个模型的资源上限（供应商支持时返回；拿不到就留空，不猜） */
export interface ModelLimits {
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  /** 供应商声明的图片输入能力；undefined 表示元数据没给，不代表不支持 */
  readonly vision?: boolean
}

/**
 * LlmAdapter —— 一个模型供应商的实现（文档 00 §6 术语表）。
 * 注册进 `ctx.llm`；消费方按 provider 名查找，绝不 import 具体包。
 */
export interface LlmAdapter {
  providerInfo(): ProviderInfo
  listModels(signal: AbortSignal): Promise<readonly ModelInfo[]>
  resolveModel(sel: ModelSelection): Promise<{ provider: string; model: string }>
  /**
   * ⚠️ 必选（20 §6.2）：把"解析配置 → 拉凭据 → 物化默认值 → 构造请求"锁在**同一注册代**上。
   * 这是热重载竞态（A 能力配 B 端点）的唯一边界。
   */
  prepareCall(sel: ModelSelection, opts: PrepareOpts): Promise<PreparedCall>
  stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk>
  providerRetryPolicy(): RetryPolicy
  /**
   * 可选：读取供应商对**单个模型**给出的上限（上下文窗口 / 输出上限）。
   * OpenAI 兼容的 `/models/{id}`、或列表里的 `context_window` 都属于这个来源。
   * 拿不到时返回空对象，调用方回落到保守值。
   */
  describeModel?(sel: ModelSelection, opts: PrepareOpts): Promise<ModelLimits>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    /** 适配器注册表（复数 = 注册表） */
    llm: LlmRegistry
  }
}

/** 适配器注册表 */
export interface LlmRegistry {
  /** 注册适配器（返回 disposer） */
  register(adapter: LlmAdapter): () => void
  /** 按 provider 名查找；未注册返回 undefined */
  get(provider: string): LlmAdapter | undefined
  /** 全部已注册 provider id */
  list(): readonly string[]
}
