/**
 * `@lcode/settings-file` —— settings 的**六层合并 + settings.json 落盘**实现
 * （doc 18 §2 分层、doc 21 §2.5 `settings.*`、doc 22 §3.9 `settings_kv`）。
 */
export type {
  FieldDescriptor,
  FieldType,
  LayerId,
  ResolveScope,
  SettingsApi,
  SettingsChange,
  SettingsGetInput,
  SettingsGetResult,
  SettingsScope,
  SettingsUpdateInput,
  SettingsUpdateResult,
} from './types.ts'
export { CONFIG_LAYER_BY_ID, LAYER_ORDER, SCOPE_BY_LAYER } from './types.ts'

export { LocalSettingsService } from './settings-service.ts'
export type { LocalSettingsOptions } from './settings-service.ts'

// ── 自定义模型配置（18 §2；T4.2 的写路径） ──
export {
  MODEL_FIELD_DESCRIPTORS,
  SETTINGS_NAMESPACE,
  providerSettingKeys,
  WEB_SEARCH_FIELD_DESCRIPTORS,
  WEB_SEARCH_NAMESPACE,
  webSearchSettingKeys,
} from './namespace.ts'
export { CustomModelStore } from './model-store.ts'
export type { CustomModelConfig, CustomModelInput, CustomModelStoreDeps } from './model-store.ts'
