import type { JsonValue } from '@lcode/util'

/**
 * `settings.*` 的对外类型（doc 21 §2.5 + doc 18 §2.1）。
 *
 * **层级编号 `L1`–`L6` 是线上字段，不是 UI 文案**：UI 必须把它翻译成人类语言
 * （"来自：你在设置里选的"），层级编号**不得上界面**（18 §10.2 / 19 §3.5）。
 */

/** 六层配置（doc 18 §2.1，优先级从高到低） */
export type LayerId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6'

/** 持久层能承载的 scope（doc 22 §3.9 的 CHECK 只允许这三个） */
export type SettingsScope = 'user' | 'workspace' | 'session'

/** 层 → 默认 scope / 该层的写入口（doc 18 §2.1） */
export const SCOPE_BY_LAYER: Readonly<Record<'L2' | 'L3' | 'L4', SettingsScope>> = {
  L2: 'session',
  L3: 'workspace',
  L4: 'user',
}

/** 层 → `@lcode/settings` 的 `ConfigLayer` 名（两套命名的映射点只有这一处） */
export const CONFIG_LAYER_BY_ID: Readonly<Record<LayerId, string>> = {
  L1: 'override',
  L2: 'session',
  L3: 'workspace',
  L4: 'user',
  L5: 'adapter-base',
  L6: 'schema-default',
}

/** 优先级从高到低（合并顺序即此数组顺序） */
export const LAYER_ORDER: readonly LayerId[] = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']

export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array'

/**
 * 字段描述符（doc 21 §2.5 `settings.describe`）。
 *
 * **脱敏**：这里只有元信息 + `credentialRef` 引用名，**永远没有凭据值**
 * （12 §7.3：配置只放引用，UI 只拿元信息）。
 */
export interface FieldDescriptor {
  readonly namespace: string
  /** 命名空间内的键路径，如 `default.maxTokens` */
  readonly key: string
  readonly type: FieldType
  /** L6 schema 默认值（doc 18 §2.1） */
  readonly default?: JsonValue | undefined
  readonly enumValues?: readonly string[] | undefined
  readonly description?: string | undefined
  /** 凭据**引用名**（如 `DEEPSEEK_API_KEY`），不是值 */
  readonly credentialRef?: string | undefined
  /** 标记为敏感：UI 不得展示其值，只展示"已配置/未配置" */
  readonly sensitive?: boolean | undefined
}

/** 解析生效值时用到的作用域上下文（L2 需要 sessionId，L3 需要 workspace） */
export interface ResolveScope {
  readonly sessionId?: string | undefined
  readonly workspace?: string | undefined
}

export interface SettingsGetInput extends ResolveScope {
  readonly namespace: string
  /** 省略则返回该命名空间的合并结果 */
  readonly key?: string | undefined
}

export interface SettingsGetResult {
  readonly value: JsonValue
  readonly source: LayerId
}

export interface SettingsUpdateInput extends ResolveScope {
  readonly namespace: string
  readonly key: string
  readonly value: JsonValue
  /** 省略即写 L4 用户层（doc 21 §2.5） */
  readonly scope?: SettingsScope | undefined
}

export interface SettingsUpdateResult {
  readonly saved: true
  readonly source: LayerId
}

export interface SettingsChange {
  readonly namespace: string
  readonly key: string
  readonly value: JsonValue
  readonly source: LayerId
}

/** `settings.*` 的进程内形态（doc 21 §2.5） */
export interface SettingsApi {
  describe(namespace: string): readonly FieldDescriptor[]
  get(input: SettingsGetInput): SettingsGetResult
  update(input: SettingsUpdateInput): Promise<SettingsUpdateResult>
  /**
   * 订阅变化。契约里写的是 `Stream<…>`——那是 RPC 层的形态；
   * 进程内直调用回调 + disposer（Stream 包装属批次⑤）。
   */
  watch(namespace: string, handler: (change: SettingsChange) => void): () => void
}
