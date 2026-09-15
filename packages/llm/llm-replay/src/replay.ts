import type { LlmAdapter, ModelInfo, PrepareOpts, PreparedCall, ProviderInfo, RetryPolicy } from '@lcode/llm'
import type { ModelSelection } from '@lcode/agent-default-model'
import type { StreamChunk } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/**
 * 回放脚本：一段可重复的流式输出（文档 23 §14 批次③ / 15 §3 快照重放）。
 * `chunks` 按序产出；工具调用场景用 `tool-call-delta` 逐段给原始参数
 * （各 callId 的 argsDelta 拼接必须等于 done 消息里对应 tool_use 的原始 JSON）。
 */
export interface ReplayScript {
  readonly provider: string
  readonly model?: string
  readonly chunks: readonly StreamChunk[]
}

/**
 * ReplayLlmAdapter —— 无密钥回放适配器。
 *
 * - 构造时给**一组**脚本；每次 `stream()` 按顺序消费下一段（确定性：同构造同序列）。
 *   一次"跑工具再要模型"的循环因此可以用两段脚本驱动（第一段产出 tool_use、第二段产出正文）。
 * - `signal` 在每个 chunk 间被尊重：中止时抛 AbortError，循环侧据此走取消收尾。
 * - `served` 记录每次调用收到的 PreparedCall（I1 捕获的现成数据源；测试也可自建装饰器）。
 * - 脚本耗尽时抛 `EC-NOT_READY`——**不猜**（11 §6.1）：宁可测试红，也不静默重放旧段。
 */
export class ReplayLlmAdapter implements LlmAdapter {
  private readonly scripts: readonly ReplayScript[]
  private cursor = 0
  readonly served: PreparedCall[] = []

  constructor(scripts: ReplayScript | readonly ReplayScript[]) {
    this.scripts = Array.isArray(scripts) ? [...scripts] : [scripts]
  }

  /** 还没消费的脚本数（测试断言用） */
  get remaining(): number {
    return this.scripts.length - this.cursor
  }

  providerInfo(): ProviderInfo {
    const first = this.scripts[0]
    return {
      id: first?.provider ?? 'replay',
      name: 'replay',
      capabilities: { streaming: true, reasoning: true, toolCalls: true },
    }
  }

  async listModels(_signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const first = this.scripts[0]
    return [{ id: first?.model ?? 'replay-model' }]
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

  async *stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const script = this.scripts[this.cursor]
    if (script === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: `回放脚本已耗尽（共 ${this.scripts.length} 段，已消费 ${this.cursor} 段）`,
        userMessage: '回放数据不够了，测试脚本需要补一段录制。',
        retryable: false,
      })
    }
    this.cursor += 1
    this.served.push(call)
    for (const chunk of script.chunks) {
      signal.throwIfAborted()
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
