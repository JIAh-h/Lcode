import type { ScopeKey } from '@lcode/scope'
import { collectScopeChain } from '@lcode/scope'
import type { Disposer } from '@lcode/util'

/**
 * 事件处理器。
 * - `emit` / `parallel` / `serial`：`(payload) => void | Promise<void>`
 * - `waterfall`：`(args, next) => Result`，`next()` 委托，直接返回则短路
 */

export type EmitHandler<P> = (payload: P) => void | Promise<void>

export type WaterfallHandler<A, R> = (args: A, next: () => Promise<R>) => Promise<R> | R

export type SerialHandler<I, O> = (input: I, index: number) => O | Promise<O>

export interface EventRegistration {
  /** 撤销订阅 */
  dispose(): void
}

interface ListenerEntry {
  scope: ScopeKey | undefined
  handler: EmitHandler<unknown>
  order: number
}

/** 事件派发实现：emit / waterfall / parallel / serial 四种模式（D7） */
export class EventBus {
  private listeners = new Map<string, ListenerEntry[]>()
  private orderCounter = 0

  /** 订阅（emit 模式）；返回撤销器。scope 化订阅：只在事件发生在该作用域时命中 */
  on(name: string, handler: EmitHandler<unknown>, scope?: ScopeKey): Disposer {
    const entry: ListenerEntry = { scope, handler, order: this.orderCounter++ }
    const list = this.listeners.get(name) ?? []
    list.push(entry)
    this.listeners.set(name, list)
    return () => {
      const cur = this.listeners.get(name)
      /* c8 ignore next 2 -- disposer 只能由 on 创建，正常路径必然存在对应列表 */
      if (!cur) return
      const idx = cur.indexOf(entry)
      if (idx >= 0) cur.splice(idx, 1)
    }
  }

  private handlersFor(name: string, scope: ScopeKey | undefined): ListenerEntry[] {
    const list = this.listeners.get(name) ?? []
    if (scope === undefined) return [...list].sort((a, b) => a.order - b.order)
    const scopes = new Set(collectScopeChain(scope))
    return list
      .filter((e) => e.scope === undefined || scopes.has(e.scope))
      .sort((a, b) => a.order - b.order)
  }

  /** emit：顺序 await 全部 handler，互不短路；某 handler 抛错则中断并上抛 */
  async emit(name: string, payload: unknown, scope?: ScopeKey): Promise<void> {
    for (const entry of this.handlersFor(name, scope)) {
      await entry.handler(payload)
    }
  }

  /** parallel：并发执行全部 handler；Promise.allSettled 语义，不因单个失败中断其余 */
  async emitParallel(name: string, payload: unknown, scope?: ScopeKey): Promise<void> {
    await Promise.allSettled(this.handlersFor(name, scope).map((e) => e.handler(payload)))
  }

  /** serial：顺序执行，前一个 handler 的返回值作为后一个的输入 */
  async emitSerial<I, O>(name: string, initial: I, scope?: ScopeKey): Promise<O> {
    let current: unknown = initial
    let index = 0
    for (const entry of this.handlersFor(name, scope)) {
      current = await (entry.handler as SerialHandler<unknown, unknown>)(current, index++)
    }
    return current as O
  }

  /**
   * waterfall：洋葱中间件 `(args, next) => Result`。
   * 调用 `next()` 委托给下一个；直接返回则短路（D10：可重排策略用 waterfall）。
   * 无 handler 时返回 args 原样（短路默认值由调用方声明）。
   */
  async waterfall<A, R>(name: string, args: A, scope?: ScopeKey, noop: () => Promise<R> = async () => args as unknown as R): Promise<R> {
    const entries = this.handlersFor(name, scope)
    let i = 0
    const dispatch = async (): Promise<R> => {
      const entry = entries[i++]
      if (!entry) return noop()
      // 处理器按名字注册时只约束成 EmitHandler<unknown>；waterfall 的参数/返回类型
      // 由调用方声明，这里必须经 unknown 中转（直接断言会被 TS 判为"类型不重叠"）
      const handler = entry.handler as unknown as WaterfallHandler<A, R>
      return handler(args, dispatch)
    }
    return dispatch()
  }
}
