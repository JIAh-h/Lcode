import type { Disposer } from '@lcode/util'

/**
 * 作用域键（文档 00 §6：不透明的注册作用域标识；Lcode 用活体 Agent 对象充当）。
 */
export type ScopeKey = symbol | string

/**
 * 按作用域取值的视图。
 */
export interface Scoped<T> {
  /** 从最内层向外解析，命中即止；找不到返回 undefined */
  get(scope: ScopeKey | undefined): T | undefined
}

/**
 * 分层注册原语：每层是一个 Partial<L>，叠加在父层之上。
 */
export interface ScopedLayers<L extends Record<string, unknown>> {
  /**
   * 注册一个作用域层。返回撤销器（卸载时精确回滚，文档 07 第三条）。
   * 内层与外层同名键：内层命中即止，不向外交替。
   */
  layer(scope: ScopeKey | undefined, value: Partial<L>): Disposer
}

type LayerEntry<L> = { scope: ScopeKey | undefined; value: Partial<L> }

/**
 * 分层查找表：支持任意嵌套作用域 + 全局默认层。
 * 查找顺序：给定 scope 的最内层 → 逐级向外 → 全局（undefined scope 层）。
 * 同一 scope 多次 layer 时，后注册的覆盖先注册的（同一层内 last-write-wins）。
 */
export class ScopedLayersImpl<L extends Record<string, unknown>> implements ScopedLayers<L>, Scoped<L> {
  /** 按层存：每个 entry 记录 scope 归属 */
  private entries: Array<LayerEntry<L>> = []

  layer(scope: ScopeKey | undefined, value: Partial<L>): Disposer {
    this.entries.push({ scope, value })
    const idx = this.entries.length - 1
    return () => {
      this.entries[idx] = undefined as unknown as LayerEntry<L>
    }
  }

  get(scope: ScopeKey | undefined): L | undefined {
    const scopes = collectScopeChain(scope)
    const out: L = {} as L
    // 先全局，再逐层向外（最内层最后写，覆盖外层）
    for (const s of scopes) {
      for (const entry of this.entries) {
        if (entry === undefined) continue
        if (entry.scope === s) {
          Object.assign(out, entry.value)
        }
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
}

/** 从最内层到全局的 scope 链（父作用域由调用方在 scope 对象上携带 parent 引用） */
export function collectScopeChain(scope: ScopeKey | undefined): Array<ScopeKey | undefined> {
  const chain: Array<ScopeKey | undefined> = []
  let current: ScopeKey | undefined = scope
  const seen = new Set<ScopeKey>()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    chain.unshift(current)
    current = (current as { parent?: ScopeKey }).parent
  }
  chain.unshift(undefined) // 全局层
  return chain
}

export function createScopedLayers<L extends Record<string, unknown>>(): ScopedLayersImpl<L> {
  return new ScopedLayersImpl<L>()
}
