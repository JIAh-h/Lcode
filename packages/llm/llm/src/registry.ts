import type { LlmAdapter, LlmRegistry } from './types.ts'

/** 内存实现：适配器注册表（实现包通过 register 挂载，消费方通过 ctx.llm 查找） */
export class InMemoryLlmRegistry implements LlmRegistry {
  private adapters = new Map<string, LlmAdapter>()

  register(adapter: LlmAdapter): () => void {
    const id = adapter.providerInfo().id
    this.adapters.set(id, adapter)
    return () => {
      this.adapters.delete(id)
    }
  }

  get(provider: string): LlmAdapter | undefined {
    return this.adapters.get(provider)
  }

  list(): readonly string[] {
    return [...this.adapters.keys()]
  }
}
