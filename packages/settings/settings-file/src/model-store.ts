import type { JsonValue } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { SETTINGS_NAMESPACE, providerSettingKeys } from './namespace.ts'

/**
 * 自定义模型配置的持久化（18 §2「每家的配置在 `settings.model.providers.<name>` 下独立」）。
 *
 * ## 为什么是"读-改-写整个数组"而不是"写一个键"
 *
 * `settings` 的 `update()` **按 key 整体替换值**，而自定义模型是**一个列表**
 * （每项含 name / base_url / api_key_ref / 上下文窗口…）。要"新增一家"就得
 * 读出当前列表 → 追加 → 整体写回。这个模块把那段逻辑收在一处，避免每个调用方各写一遍。
 *
 * ## 凭据的处理（D22 + I7）
 *
 * **值永不进 settings**：`api_key_ref` 存的是**引用名**（如 `CUSTOM_API_KEY`），
 * 值本身由 `credentials.write()` 落到 0600 文件 / keychain，settings 里只有名字。
 * 这不是实现细节，是产品宪法第二条的硬要求——settings 是可以被 grep、被导出的。
 *
 * ## 关于 `readSetting`
 *
 * 本模块**不依赖 `settings` 的具体实现**（`settings-file` 是实现包，契约包不能依赖实现），
 * 所以读写都通过两个窄函数注入。这样它既能用在桌面装配里，也能在测试里用内存桩。
 */

/**
 * **用户提交**的形状。
 *
 * `model` 可缺省：省略 = "显示名就是服务端模型名"，这是最常见的形态，不该逼所有人多填一遍。
 */
export interface CustomModelInput {
  /** 供应商 id（`ctx.llm` 里的 key，也是 `ModelSelection.provider`） */
  readonly name: string
  /** 用户可读的显示名 */
  readonly label: string
  /** 真正发给服务端的模型 id（如 `deepseek-chat`）；省略则回落 `label` */
  readonly model?: string | undefined
  /** 接口地址（OpenAI 兼容协议的 base url） */
  readonly base_url: string
  /**
   * 凭据**引用名**（不是值）。空串表示这个端点不需要密钥（本地模型）。
   * 值本身在 `credentials` 里，settings 只有引用。
   */
  readonly api_key_ref: string
  /** 可选的模型白名单覆盖（网关上常用来收窄可选模型） */
  readonly models?: readonly string[] | undefined
  /** 输入窗口（用户可覆盖；缺省则用适配器兜底） */
  readonly context_window_in?: number | undefined
  /** 输出上限（同上） */
  readonly context_window_out?: number | undefined
}

/**
 * **存下来**的形状：`model` 一定有值。
 *
 * 与输入分开是刻意的——"用户给了什么"和"我们落了什么"不是同一个东西，
 * 用同一个类型表达会让调用方以为 `upsert(x)` 之后 `x.model` 也被填好了（并不会）。
 */
export interface CustomModelConfig extends Omit<CustomModelInput, 'model'> {
  /**
   * **真正发给服务端的模型 id**（如 `deepseek-chat`）。
   *
   * 与 `label` 是两件事，**不能合并**：label 是"我给它起的名字"（可以叫「主力模型」），
   * 而 model 必须是服务端认得的那个字符串。混用的后果实测踩过——
   * 引擎把显示名当 model 发出去，服务端一律 404（EL-UNKNOWN_MODEL）。
   */
  readonly model: string
}

export interface CustomModelStoreDeps {
  /**
   * 读一个设置项；未配置返回 undefined。
   *
   * 返回 `unknown` 而不是 `JsonValue`：`settings` 对 `array`/`object` 类型**不做深层校验**，
   * 而 `settings.json` 是用户可以手改的文件——所以拿到的值必须当作**不可信输入**来收窄，
   * 这正是 `toConfig()` 在做的事。
   */
  readonly read: (key: string) => unknown
  /** 写一个设置项（L4 用户层） */
  readonly write: (key: string, value: JsonValue) => Promise<void>
}

function invalid(message: string, userMessage: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EC_INVALID_PARAMS, message, userMessage, retryable: false })
}

/** 供应商 id 必须能当 URL/键名用：字母数字、下划线、连字符 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export class CustomModelStore {
  constructor(private readonly deps: CustomModelStoreDeps) {}

  /** 全部自定义模型（按配置顺序；读不出有效项时**跳过**而不是报错） */
  async list(): Promise<readonly CustomModelConfig[]> {
    const raw = this.deps.read(`${SETTINGS_NAMESPACE}.${providerSettingKeys.list}`)
    if (!Array.isArray(raw)) return []
    return raw.map(toConfig).filter((c): c is CustomModelConfig => c !== null)
  }

  /** 按 id 找一家 */
  async get(name: string): Promise<CustomModelConfig | undefined> {
    return (await this.list()).find((c) => c.name === name)
  }

  /**
   * 新增或更新一家（按 `name` 幂等）。
   *
   * **返回的是存下来的那份**，调用方据此拿 `api_key_ref` 去调 `credentials.write()`；
   * 本模块**不碰凭据值**（它只认引用名），所以这里也不会、无法把值写进 settings。
   */
  async upsert(config: CustomModelInput): Promise<CustomModelConfig> {
    const normalized = validate(config)
    const current = await this.list()
    const next = current.filter((c) => c.name !== normalized.name)
    next.push(normalized)
    await this.persist(next)
    return normalized
  }

  /** 删除一家（幂等：不存在也返回成功） */
  async remove(name: string): Promise<{ readonly removed: boolean }> {
    const current = await this.list()
    const next = current.filter((c) => c.name !== name)
    if (next.length === current.length) return { removed: false }
    await this.persist(next)
    return { removed: true }
  }

  /**
   * 整体写回。
   *
   * `settings.update` 要求 key 已注册，且对 `array` 类型**不做深层校验**，
   * 所以这里序列化成普通 JSON（`JsonValue`）——保证存进去的一定是 JSON 可表达的形状。
   */
  private async persist(items: readonly CustomModelConfig[]): Promise<void> {
    await this.deps.write(`${SETTINGS_NAMESPACE}.${providerSettingKeys.list}`, items as unknown as JsonValue)
  }
}

function validate(config: CustomModelInput): CustomModelConfig {
  const name = config.name.trim()
  if (!ID_PATTERN.test(name)) {
    throw invalid(
      `自定义模型 id 非法：${config.name}（只允许字母数字、下划线、连字符，且不以数字开头）`,
      '这个名字不能用作模型标识，请换一个（只能用字母、数字、下划线和连字符）。',
    )
  }
  const baseUrl = config.base_url.trim()
  if (baseUrl === '') {
    throw invalid(
      `自定义模型「${name}」缺少接口地址`,
      '自定义供应商需要填写接口地址。',
    )
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw invalid(
      `接口地址必须以 http:// 或 https:// 开头：${baseUrl}`,
      '接口地址要以 http:// 或 https:// 开头。',
    )
  }
  const label = config.label.trim() === '' ? name : config.label.trim()
  // 省略 = "显示名就是服务端模型名"（最常见形态）→ 回落 label。
  // 真正为空的是**显式传了空串**那种，同样回落而不是报错——空串与省略在这里是同一件事。
  const model = (config.model ?? '').trim() === '' ? label : config.model!.trim()
  return {
    name,
    label,
    model,
    base_url: baseUrl.replace(/\/+$/, ''),
    api_key_ref: config.api_key_ref.trim(),
    ...(config.models === undefined ? {} : { models: [...config.models] }),
    ...(config.context_window_in === undefined ? {} : { context_window_in: config.context_window_in }),
    ...(config.context_window_out === undefined ? {} : { context_window_out: config.context_window_out }),
  }
}

/** 未知形状的项 → 配置对象；缺关键字段则返回 null（跳过） */
function toConfig(value: unknown): CustomModelConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const name = record['name']
  const baseUrl = record['base_url']
  if (typeof name !== 'string' || typeof baseUrl !== 'string') return null
  const models = record['models']
  const label = typeof record['label'] === 'string' ? record['label'] : name
  return {
    name,
    label,
    // 老配置没有这个字段：回落到 label（"显示名就是模型 id"是最常见的形态）。
    // 缺失时把这条**当无效项跳过**会让用户升级后模型凭空消失，那比回落到 label 糟得多。
    model: typeof record['model'] === 'string' && record['model'].trim() !== '' ? record['model'].trim() : label,
    base_url: baseUrl,
    api_key_ref: typeof record['api_key_ref'] === 'string' ? record['api_key_ref'] : '',
    ...(Array.isArray(models) ? { models: models.filter((m): m is string => typeof m === 'string') } : {}),
    ...(typeof record['context_window_in'] === 'number' ? { context_window_in: record['context_window_in'] } : {}),
    ...(typeof record['context_window_out'] === 'number' ? { context_window_out: record['context_window_out'] } : {}),
  }
}
