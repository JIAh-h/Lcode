import type { Disposer } from '@lcode/util'

/**
 * model.* 的 API 层类型（docs/21 §2.0 / §2.7）。
 * `ModelSelection` 采用契约的**扁平形**（maxTokens 等在顶层）；与 core
 * 嵌套 params 的换算在 model-api.ts 内完成，最终 DTO 拍平由 IPC/RPC 层（T5.3）负责。
 */

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly reasoningEffort?: 'low' | 'medium' | 'high'
  readonly temperature?: number
}

export interface ModelInfo {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
}

export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly capabilities: {
    readonly streaming: boolean
    readonly reasoning: boolean
    readonly toolCalls: boolean
  }
}

/** probe 的六类归因（19 §6.4 文案一一对应；docs/21 §2.7） */
export type ProbeFailureKind =
  | 'credential-rejected'
  | 'endpoint-unreachable'
  | 'model-not-found'
  | 'timeout'
  | 'provider-not-running'
  | 'not-configured'

export interface ProbeFailure {
  readonly kind: ProbeFailureKind
  /** 原始错误码（归因是 UI 面，诊断不丢真） */
  readonly code: string
  readonly message: string
}

export type ProbeResult = { readonly ok: true; readonly models: readonly ModelInfo[] } | { readonly ok: false; readonly failure: ProbeFailure }

/**
 * 进程内值流（`Stream<T>` 的进程内形态）。
 * `watchDefault()` 每次调用返回**新的独立流**（幂等重订阅）。
 */
export class ValueStream<T> {
  private readonly listeners = new Set<(value: T) => void>()
  private upstream: (() => void) | null = null

  /** API 内部：挂上游订阅的撤销器 */
  attachUpstream(dispose: () => void): void {
    this.upstream = dispose
  }

  /** API 内部：推送一个值 */
  push(value: T): void {
    for (const listener of this.listeners) listener(value)
  }

  /** 订阅；返回撤销器 */
  subscribe(listener: (value: T) => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 关闭流（断开上游） */
  close(): void {
    this.listeners.clear()
    this.upstream?.()
    this.upstream = null
  }
}
