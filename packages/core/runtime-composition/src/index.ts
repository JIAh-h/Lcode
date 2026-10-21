import type { Context } from '@lcode/context'

export type RuntimeDisposer = () => void | Promise<void>

export interface InternalBundleEntry {
  readonly id: string
  readonly provides: readonly string[]
  /**
   * 已由宿主在 profile 组合前创建、但属于该可信内置 provider 边界的服务。
   *
   * adopts 不是第二种注册方式：它不允许 entry 覆盖或替换 Context 中的值，
   * 只把共享宿主服务纳入组合快照并在 mount 时再次确认仍然存在。它用于桌面
   * 设置页先初始化、Agent Runtime 后复用的模型服务，避免为同一个 Context 建两套模型。
   */
  readonly adopts?: readonly string[] | undefined
  readonly requires?: readonly string[] | undefined
  readonly mount: (ctx: Context) => RuntimeDisposer | Promise<RuntimeDisposer>
}

export interface RuntimeProfile {
  readonly id: string
  readonly bundles: readonly InternalBundleEntry[]
}

export interface RuntimeCompositionEntrySnapshot {
  readonly id: string
  readonly provides: readonly string[]
  readonly adopts: readonly string[]
  readonly requires: readonly string[]
}

export interface RuntimeCompositionSnapshot {
  readonly profile: string
  readonly entries: readonly RuntimeCompositionEntrySnapshot[]
}

export interface RuntimeComposition {
  readonly snapshot: RuntimeCompositionSnapshot
  dispose(): Promise<void>
}

export class RuntimeCompositionError extends Error {
  constructor(
    readonly code: 'EC_COMPOSITION_DUPLICATE' | 'EC_COMPOSITION_MISSING' | 'EC_COMPOSITION_PROVIDER',
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeCompositionError'
  }
}

/**
 * 装配受发行包信任的内部 bundle。它不加载外部插件，也不解释动态配置。
 *
 * 条目只通过 `provides/requires` 参与排序；真正服务仍由 entry 用 Context 的
 * Service Definition 注册。mount 完成后再次检查提供项，避免元数据和实际状态漂移。
 */
export async function composeRuntimeProfile(ctx: Context, profile: RuntimeProfile): Promise<RuntimeComposition> {
  const entries = [...profile.bundles]
  const ids = new Set<string>()
  const providers = new Map<string, InternalBundleEntry>()

  for (const entry of entries) {
    if (entry.id === '' || ids.has(entry.id)) {
      throw new RuntimeCompositionError('EC_COMPOSITION_DUPLICATE', `重复的 bundle id：${entry.id}`)
    }
    ids.add(entry.id)
    for (const key of entry.provides) {
      const previous = providers.get(key)
      if (previous !== undefined || ctx.has(key)) {
        throw new RuntimeCompositionError(
          'EC_COMPOSITION_DUPLICATE',
          `服务 ${key} 已由 ${previous?.id ?? '现有运行时'} 提供，不能由 ${entry.id} 重复注册`,
        )
      }
      providers.set(key, entry)
    }
    for (const key of entry.adopts ?? []) {
      if (entry.provides.includes(key)) {
        throw new RuntimeCompositionError(
          'EC_COMPOSITION_DUPLICATE',
          `服务 ${key} 不能同时由 ${entry.id} 声明 adopts 和 provides`,
        )
      }
    }
  }

  for (const entry of entries) {
    for (const key of entry.requires ?? []) {
      if (!ctx.has(key) && !providers.has(key)) {
        throw new RuntimeCompositionError('EC_COMPOSITION_MISSING', `bundle ${entry.id} 缺少依赖服务：${key}`)
      }
    }
    for (const key of entry.adopts ?? []) {
      if (!ctx.has(key)) {
        throw new RuntimeCompositionError('EC_COMPOSITION_MISSING', `bundle ${entry.id} 缺少待接管服务：${key}`)
      }
    }
  }

  const pending = new Set(entries)
  const mounted: Array<{ readonly entry: InternalBundleEntry; readonly dispose: RuntimeDisposer }> = []
  const available = new Set<string>()
  try {
    while (pending.size > 0) {
      const next = [...pending].find((entry) =>
        (entry.requires ?? []).every((key) => ctx.has(key) || available.has(key)),
      )
      if (next === undefined) {
        const blocked = [...pending].map((entry) => entry.id).join(', ')
        throw new RuntimeCompositionError('EC_COMPOSITION_MISSING', `bundle 依赖循环或未满足：${blocked}`)
      }
      pending.delete(next)
      const dispose = await next.mount(ctx)
      for (const key of next.adopts ?? []) {
        if (!ctx.has(key)) {
          await dispose()
          throw new RuntimeCompositionError('EC_COMPOSITION_PROVIDER', `bundle ${next.id} 未能接管声明的服务：${key}`)
        }
      }
      for (const key of next.provides) {
        if (!ctx.has(key)) {
          throw new RuntimeCompositionError('EC_COMPOSITION_PROVIDER', `bundle ${next.id} 未注册声明的服务：${key}`)
        }
        available.add(key)
      }
      mounted.push({ entry: next, dispose })
    }
  } catch (error) {
    await disposeReverse(mounted)
    throw error
  }

  let disposed = false
  return {
    snapshot: Object.freeze({
      profile: profile.id,
      entries: Object.freeze(mounted.map(({ entry }) => Object.freeze({
        id: entry.id,
        provides: Object.freeze([...entry.provides]),
        adopts: Object.freeze([...(entry.adopts ?? [])]),
        requires: Object.freeze([...(entry.requires ?? [])]),
      }))),
    }),
    async dispose() {
      if (disposed) return
      disposed = true
      await disposeReverse(mounted)
    },
  }
}

async function disposeReverse(mounted: readonly { readonly dispose: RuntimeDisposer }[]): Promise<void> {
  for (const { dispose } of [...mounted].reverse()) {
    try {
      await dispose()
    } catch {
      // 释放必须尽力完成剩余条目；调用方的主错误优先保留。
    }
  }
}
