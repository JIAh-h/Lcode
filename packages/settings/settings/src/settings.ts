/** 配置来源层（D19，六层） */
export type ConfigLayer = 'override' | 'session' | 'workspace' | 'user' | 'adapter-base' | 'schema-default'

export interface SettingValue {
  readonly value: unknown
  readonly layer: ConfigLayer
  readonly source: string
}

/** SettingsService —— 设置键值（逐字段合并；配置里只放引用，值永不进日志） */
export interface SettingsService {
  /** 读取生效值（含来源层与来源，doctor --model 的输入） */
  get(key: string, scope?: { readonly sessionId?: string; readonly workspace?: string }): SettingValue | undefined
  /** 写用户层 */
  set(key: string, value: unknown, scope?: { readonly workspace?: string }): Promise<void>
  watch(keys: readonly string[], fn: (changed: readonly string[]) => void): () => void
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    settings: SettingsService
  }
}
