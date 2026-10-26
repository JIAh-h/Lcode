import type { FieldDescriptor } from './types.ts'

/**
 * `model` 命名空间的字段描述符（18 §2 / §2.1）。
 *
 * **为什么要集中在这里**：`settings.update()` 要求 key **已注册**
 * （见 `LocalSettingsService.update` 的"未知设置项"分支），所以装配层必须在启动时
 * 调一次 `registerNamespace(MODEL_FIELD_DESCRIPTORS)`。散在各个调用点会漏。
 *
 * **这里没有、也不会有凭据值字段**：`api_key_ref` 是**引用名**，值由 `credentials` 管
 * （12 §7.3 / D22）。描述符里连"敏感字段"都只标 `sensitive`，不承载值。
 */

/** 设置命名空间（`settings.model.*`） */
export const SETTINGS_NAMESPACE = 'model'

/**
 * 「自定义模型清单」的 key。
 *
 * 用 **`providers`** 而不是 `custom_models`：文档 18 §2 的原话是
 * 「每家的配置在 `settings.model.providers.<name>` 下**独立**」，而弹窗里"自定义"
 * 只是其中一种 provider（另外还有内置的官方供应商）。清单存成数组、每项自带 `name`，
 * 与那句"各家的配置独立"是同一件事的两种写法。
 */
export const providerSettingKeys = {
  list: 'providers',
  /** 默认选择（`model.default.*`，18 §2.1） */
  defaultProvider: 'default.provider',
  defaultModel: 'default.model',
  defaultMaxTokens: 'default.maxTokens',
} as const

export const MODEL_FIELD_DESCRIPTORS: readonly FieldDescriptor[] = [
  { namespace: SETTINGS_NAMESPACE, key: providerSettingKeys.defaultProvider, type: 'string' },
  { namespace: SETTINGS_NAMESPACE, key: providerSettingKeys.defaultModel, type: 'string' },
  { namespace: SETTINGS_NAMESPACE, key: providerSettingKeys.defaultMaxTokens, type: 'number' },
  {
    namespace: SETTINGS_NAMESPACE,
    key: providerSettingKeys.list,
    type: 'array',
    default: [],
    description: '自定义模型清单（每项含 name / base_url / api_key_ref；**不含凭据值**）',
  },
]

/** 网页搜索的非敏感配置；API Key 由 credentials 管理，不在这里。 */
export const WEB_SEARCH_NAMESPACE = 'webSearch'

export const webSearchSettingKeys = {
  provider: 'provider',
  maxResults: 'maxResults',
} as const

export const WEB_SEARCH_FIELD_DESCRIPTORS: readonly FieldDescriptor[] = [
  {
    namespace: WEB_SEARCH_NAMESPACE,
    key: webSearchSettingKeys.provider,
    type: 'string',
    enumValues: ['tavily'],
    default: 'tavily',
    description: '搜索服务提供方（当前仅内置 Tavily）',
  },
  {
    namespace: WEB_SEARCH_NAMESPACE,
    key: webSearchSettingKeys.maxResults,
    type: 'number',
    default: 5,
    description: '每次搜索默认返回条数（1-10）',
  },
]
