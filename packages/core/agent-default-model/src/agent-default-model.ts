import type { ScopeKey } from '@lcode/scope'
import { createScopedLayers, ScopedLayersImpl } from '@lcode/scope'
import type { Disposer } from '@lcode/util'

/** 模型选择（文档 00 §6 术语表：provider / model / maxTokens / reasoningEffort / temperature） */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly params?: SamplingParams
}

export interface SamplingParams {
  readonly maxTokens?: number
  readonly reasoningEffort?: 'low' | 'medium' | 'high'
  readonly temperature?: number
}

/**
 * AgentDefaultModelService —— "当前用哪个模型"的唯一权威（文档 20 §5.5）。
 * ctx key: `ctx.agentDefaultModel`（单数 = 一个引擎/策略）。
 */
export interface AgentDefaultModelService {
  get(scope?: ScopeKey): ModelSelection | undefined
  set(sel: ModelSelection, scope?: ScopeKey): Promise<void>
  watch(fn: (sel: ModelSelection | undefined) => void): Disposer
}

/** 内存实现：分层查找（ScopedLayers）+ watch 通知 */
export class InMemoryAgentDefaultModelService implements AgentDefaultModelService {
  private layers: ScopedLayersImpl<{ selection: ModelSelection }>
  private watchers = new Set<(sel: ModelSelection | undefined) => void>()

  constructor() {
    this.layers = createScopedLayers<{ selection: ModelSelection }>()
  }

  get(scope?: ScopeKey): ModelSelection | undefined {
    return this.layers.get(scope)?.selection
  }

  async set(sel: ModelSelection, scope?: ScopeKey): Promise<void> {
    this.layers.layer(scope, { selection: sel }) // layer 返回的 disposer 暂不暴露（会话级临时切换走会话事件，M2）
    for (const fn of this.watchers) {
      fn(sel)
    }
  }

  watch(fn: (sel: ModelSelection | undefined) => void): Disposer {
    this.watchers.add(fn)
    return () => {
      this.watchers.delete(fn)
    }
  }
}

/** ctx key（文档 20 §5.5）：单数 = 一个引擎 */
declare module '@lcode/context' {
  interface Services {
    agentDefaultModel: AgentDefaultModelService
  }
}
