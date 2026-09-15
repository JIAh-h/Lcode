import type { ScopeKey } from '@lcode/scope'
import type { Disposer } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { EventBus, type EmitHandler, type SerialHandler, type WaterfallHandler } from './events.ts'
import type { EventName, Events, ServiceKey, Services } from './services.ts'

/**
 * Context —— 内核层的核心对象（文档 05 §L1）。
 * 服务查找 + 事件派发 + 可逆副作用注册，三者都支持作用域。
 */
export class Context {
  private services = new Map<string, { scope: ScopeKey | undefined; value: unknown }[]>()
  readonly events: EventBus = new EventBus()

  // ─────────── 服务（Service） ───────────

  /**
   * 注册服务（可带作用域）；返回撤销器（卸载即回滚，文档 07 第三条）。
   * 同一 key 同 scope 重复注册：后注册覆盖先注册。
   */
  set<K extends ServiceKey>(key: K, value: Services[K], opts?: { scope?: ScopeKey }): Disposer {
    const scope = opts?.scope
    const list = this.services.get(key) ?? []
    // 同 scope 覆盖
    const idx = list.findIndex((e) => e.scope === scope)
    if (idx >= 0) {
      list[idx] = { scope, value }
    } else {
      list.push({ scope, value })
    }
    this.services.set(key, list)
    const myIndex = idx >= 0 ? idx : list.length - 1
    return () => {
      const cur = this.services.get(key)
      if (!cur) return
      cur[myIndex] = undefined as unknown as { scope: ScopeKey | undefined; value: unknown }
    }
  }

  /**
   * 解析服务（消费方唯一的入口，文档 20 §4.1：C->K: resolve(ctx)）。
   * 查找顺序：给定 scope 最内层 → 全局（undefined scope）。
   * 找不到：抛 EC-NOT_FOUND（fail-closed：内核不猜测）。
   */
  get<K extends ServiceKey>(key: K, scope?: ScopeKey): Services[K] {
    const list = this.services.get(key)
    if (!list) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_FOUND,
        message: `service not registered: ${key}`,
        userMessage: '缺少一个必要组件，功能暂不可用。',
      })
    }
    if (scope === undefined) {
      const global = list.find((e) => e.scope === undefined)
      if (global) return global.value as Services[K]
    } else {
      // 最内层优先：先查精确 scope，再查全局
      const exact = list.find((e) => e.scope === scope)
      if (exact) return exact.value as Services[K]
      const global = list.find((e) => e.scope === undefined)
      if (global) return global.value as Services[K]
    }
    throw new LcodeErrorImpl({
      code: ERROR_CODES.EC_NOT_FOUND,
      message: `service not found for scope: ${key}`,
      userMessage: '缺少一个必要组件，功能暂不可用。',
    })
  }

  /** 只读探测：不抛错 */
  has(key: string, scope?: ScopeKey): boolean {
    const list = this.services.get(key)
    if (!list) return false
    return list.some((e) => e !== undefined && (e.scope === scope || e.scope === undefined))
  }

  // ─────────── 事件（Event） ───────────

  /** 订阅（emit 模式） */
  on<E extends EventName>(name: E, handler: EmitHandler<ServicesPayload<E>>, scope?: ScopeKey): Disposer {
    return this.events.on(name, handler as EmitHandler<unknown>, scope)
  }

  /** 广播（顺序 await） */
  emit<E extends EventName>(name: E, payload: ServicesPayload<E>, scope?: ScopeKey): Promise<void> {
    return this.events.emit(name, payload, scope)
  }

  /** 并发广播 */
  emitParallel<E extends EventName>(name: E, payload: ServicesPayload<E>, scope?: ScopeKey): Promise<void> {
    return this.events.emitParallel(name, payload, scope)
  }

  /** 串行管线 */
  emitSerial<E extends EventName, I, O>(name: E, initial: I, scope?: ScopeKey): Promise<O> {
    return this.events.emitSerial<I, O>(name, initial, scope)
  }

  /** 洋葱中间件（waterfall） */
  waterfall<E extends EventName, A, R>(name: E, args: A, scope?: ScopeKey, noop?: () => Promise<R>): Promise<R> {
    return this.events.waterfall<A, R>(name, args, scope, noop)
  }

  /** 副作用：注册即返回撤销器（disposer 模式的内核入口） */
  effect(fn: (ctx: Context) => Disposer, scope?: ScopeKey): Disposer {
    // 骨架阶段副作用不做作用域归属（批次⑥ 的守卫链会用到）；显式 void 表明"故意未使用"
    void scope
    return fn(this)
  }
}

/** 从 Events 开放接口中提取 payload 类型（声明合并后自动可见） */
type ServicesPayload<E extends EventName> = E extends keyof Events ? Events[E] : unknown

export function createContext(): Context {
  return new Context()
}

export type { WaterfallHandler, SerialHandler }
