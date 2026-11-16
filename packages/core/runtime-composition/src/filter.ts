import type { Context } from '@lcode/context'
import type { RuntimeProfile } from './index.ts'

/**
 * 配置驱动的 bundle 过滤（docs/30 §P2）。
 *
 * ## 为什么需要这一层
 *
 * `composeRuntimeProfile` 已经会按 `requires` 拓扑排序、检查缺依赖、逆序回滚，
 * 但它假设 bundle 列表是**固定的**——由 `createBuiltinRuntimeProfile` 在编译期写死。
 * 这意味着用户没法禁用某个内置能力，第三方插件也没法替换它。
 *
 * 这一层在装配**之前**运行，只做一件事：按配置决定哪些条目进入组合。
 * 不碰 `composeRuntimeProfile` 的排序/校验逻辑，所以现有不变量不变。
 *
 * ## 配置形状
 *
 * ```
 * plugins.disabled = ['code-runtime-local', 'lsp-provider']     // 按 id 禁用
 * ```
 *
 * 没配 = 全部启用（向后兼容：老用户不知道这个设置，行为完全不变）。
 *
 * ## 依赖级联
 *
 * 禁用 A 后，如果有 B `requires` A 提供的服务，`composeRuntimeProfile` 会在
 * 装配期抛 `EC_COMPOSITION_MISSING`——这是**刻意的**：与其静默带着半套能力启动
 * （更容易误判为 bug），不如在启动时明确报错，让用户知道 B 依赖 A。
 *
 * 没写 `requires` 的隐式依赖无法自动发现（这是现有条目的债），需要逐步补齐。
 */
export const DISABLED_PLUGINS_KEY = 'plugins.disabled'

export interface BundleFilterOptions {
  /** 读取配置；缺省时从 ctx.settings 读，纯测试可注入 */
  readonly readDisabled?: () => readonly string[]
}

/** 从 Context 读禁用列表；读不到/格式不对都当作没禁用 */
export function readDisabledBundles(ctx: Context): readonly string[] {
  try {
    if (!ctx.has('settings')) return []
    const settings = ctx.get('settings')
    const found = settings.get(DISABLED_PLUGINS_KEY)
    const value = found?.value
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item !== '')
  } catch {
    // 设置服务异常不该拖垮装配：按"没禁用"处理
    return []
  }
}

/**
 * 应用过滤，返回**新**的 profile（不改原对象）。
 *
 * 被禁用条目的 id 会记在结果里，供设置页/诊断展示"哪些能力被关掉了"。
 */
export function filterProfile(
  profile: RuntimeProfile,
  disabled: readonly string[],
): { readonly profile: RuntimeProfile; readonly removed: readonly string[] } {
  if (disabled.length === 0) return { profile, removed: [] }
  const blocked = new Set(disabled)
  const bundles = profile.bundles.filter((entry) => !blocked.has(entry.id))
  const removed = profile.bundles.filter((entry) => blocked.has(entry.id)).map((entry) => entry.id)
  return {
    profile: { ...profile, bundles },
    removed,
  }
}

/** 便捷入口：读配置 + 过滤一步完成 */
export function applyBundleFilter(
  ctx: Context,
  profile: RuntimeProfile,
  options: BundleFilterOptions = {},
): { readonly profile: RuntimeProfile; readonly removed: readonly string[] } {
  const disabled = options.readDisabled?.() ?? readDisabledBundles(ctx)
  const result = filterProfile(profile, disabled)
  if (result.removed.length > 0) {
    console.info(`[lcode] 已按配置禁用内置能力：${result.removed.join(', ')}`)
  }
  return result
}
