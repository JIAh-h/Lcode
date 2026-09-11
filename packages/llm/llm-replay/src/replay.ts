import type { LlmAdapter, ModelInfo, PrepareOpts, PreparedCall, ProviderInfo, RetryPolicy } from '@lcode/llm'
import type { ModelSelection } from '@lcode/agent-default-model'
import type { StreamChunk } from '@lcode/session'

/** 回放脚本：一段可重复的流式输出 */
export interface ReplayScript {
  readonly provider: string
  readonly model?: string
  readonly chunks: readonly StreamChunk[]
}

/**
 * ReplayLlmAdapter —— 无密钥回放适配器（文档 23 §14 批次③）。
 * stream() 按脚本逐段产出 chunk；done 之后迭代结束。
 */
export class ReplayLlmAdapter implements LlmAdapter {
  private script: ReplayScript

  constructor(script: ReplayScript) {
    this.script = script
  }

  providerInfo(): ProviderInfo {
    return {
      id: this.script.provider,
      name: 'replay',
      capabilities: { streaming: true, reasoning: true, toolCalls: true },
    }
  }

  async listModels(_signal: AbortSignal): Promise<readonly ModelInfo[]> {
    return [{ id: this.script.model ?? 'replay-model' }]
  }

  async resolveModel(sel: ModelSelection): Promise<{ provider: string; model: string }> {
    return { provider: sel.provider, model: sel.model }
  }

  async prepareCall(sel: ModelSelection, _opts: PrepareOpts): Promise<PreparedCall> {
    return {
      provider: sel.provider,
      model: sel.model,
      request: { endpoint: 'replay://', headers: {}, body: {} },
      retryPolicy: this.providerRetryPolicy(),
    }
  }

  async *stream(call: PreparedCall, _signal: AbortSignal): AsyncIterable<StreamChunk> {
    void call
    for (const chunk of this.script.chunks) {
      yield chunk
    }
  }

  providerRetryPolicy(): RetryPolicy {
    return {
      maxAttempts: 1,
      baseDelayMs: 0,
      shouldRetry: () => false,
    }
  }
}
