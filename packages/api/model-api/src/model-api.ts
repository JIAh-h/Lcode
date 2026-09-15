import type { Context } from '@lcode/context'
import type { ModelSelection as CoreModelSelection } from '@lcode/agent-default-model'
import { ERROR_CODES, LcodeErrorImpl, withTimeout, TimeoutError } from '@lcode/util'
import { ValueStream } from './types.ts'
import type { ModelInfo, ModelSelection, ProbeFailure, ProbeResult, ProviderInfo } from './types.ts'

/**
 * LocalModelApi —— docs/21 §2.7 `model.*` 的边界层落地。
 *
 * 两个入口**不混用**（18 §3.1）：
 * - 选择入口 = `ctx.agentDefaultModel`（getDefault / setDefault / watchDefault）
 * - 执行入口 = `ctx.llm`（listProviders / listModels / probe）
 * 不做自动路由（D21）。
 *
 * `probe` **永不抛错**——六类归因（19 §6.4）各配独立文案；未映射错误归入
 * `endpoint-unreachable` 并保留原始 code（诊断不丢真）。
 */

/** listModels / probe 的网络超时默认值（docs/21 §2.7：30s）；测试可注入缩短 */
const PROBE_TIMEOUT_MS = 30_000

export interface LocalModelApiOptions {
  readonly ctx: Context
  /** 覆盖网络超时（测试用；默认 30s） */
  readonly probeTimeoutMs?: number | undefined
  /**
   * 自定义模型配置的读写（18 §2）。省略则 `listCustom`/`saveCustom`/`removeCustom` 报
   * `EC-NOT-READY`——**显式失败好过静默存不下**：装配漏了要立刻看得见。
   */
  readonly customModels?: CustomModelStoreLike | undefined
  /** 凭据写入（D22 / I7）。省略则保存时只落引用名、不写值 */
  readonly credentials?: CredentialWriteLike | undefined
}

/**
 * 自定义模型仓库的**结构化依赖**（不在契约包里定义它——那会迫使契约包了解 settings）。
 * `@lcode/settings-file` 的 `CustomModelStore` 与本类型结构兼容。
 */
export interface CustomModelStoreLike {
  list(): Promise<
    readonly {
      readonly name: string
      readonly label: string
      /** 真正发给服务端的模型 id（与 label 是两件事，见 settings-file 的 CustomModelConfig） */
      readonly model: string
      readonly base_url: string
      readonly api_key_ref: string
      readonly models?: readonly string[] | undefined
      readonly context_window_in?: number | undefined
      readonly context_window_out?: number | undefined
    }[]
  >
  get(name: string): Promise<
    | {
        readonly name: string
        readonly api_key_ref: string
      }
    | undefined
  >
  upsert(config: {
    readonly name: string
    readonly label: string
    /** 省略 = 显示名就是服务端模型名（回落 label） */
    readonly model?: string | undefined
    readonly base_url: string
    readonly api_key_ref: string
    readonly models?: readonly string[] | undefined
  }): Promise<{ readonly name: string; readonly api_key_ref: string }>
  remove(name: string): Promise<{ readonly removed: boolean }>
}

/** 凭据写入的结构化依赖（`@lcode/credentials-local` 的写方法） */
export interface CredentialWriteLike {
  write(key: string, value: string): { readonly keyId: string } | unknown
  delete(key: string): { readonly deleted: boolean } | unknown
}

/** 对外的自定义模型信息（**无凭据值**，只有引用名与"是否已配置"） */
export interface CustomModelInfo {
  readonly name: string
  readonly label: string
  /** 真正发给服务端的模型 id（如 `deepseek-chat`）；默认模型选择用它 */
  readonly model: string
  readonly base_url: string
  readonly api_key_ref: string
  readonly models?: readonly string[] | undefined
}

function toCustomInfo(config: {
  readonly name: string
  readonly label: string
  readonly model: string
  readonly base_url: string
  readonly api_key_ref: string
  readonly models?: readonly string[] | undefined
}): CustomModelInfo {
  return {
    name: config.name,
    label: config.label,
    model: config.model,
    base_url: config.base_url,
    api_key_ref: config.api_key_ref,
    ...(config.models === undefined ? {} : { models: config.models }),
  }
}

/**
 * 由供应商 id 推导默认凭据引用名（`custom-my-gw` → `CUSTOM_MY_GW_API_KEY`）。
 *
 * 给用户一个"不用自己想名字"的默认值，同时保持**可读**——用户要设环境变量时会用到它。
 */
function refNameFor(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

export class LocalModelApi {
  private readonly timeoutMs: number

  constructor(
    private readonly deps: LocalModelApiOptions,
  ) {
    this.timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  }
  async listProviders(): Promise<readonly ProviderInfo[]> {
    const registry = this.deps.ctx.get('llm')
    return registry.list().map((id) => {
      const adapter = registry.get(id)
      // list() 与 get() 同源，这里不会缺；防御性占位仍需类型收窄
      if (adapter === undefined) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EC_NOT_FOUND,
          message: `adapter vanished during listProviders: ${id}`,
          userMessage: '这个模型供应商刚刚被卸载了。',
          retryable: false,
        })
      }
      return adapter.providerInfo()
    })
  }

  /** `model.listModels`：某供应商的可用模型；EL-NO_ADAPTER / 超时映射 EN-TIMEOUT */
  async listModels(input: { readonly provider: string }): Promise<readonly ModelInfo[]> {
    const adapter = this.requireAdapter(input.provider)
    try {
      return await withTimeout((signal) => adapter.listModels(signal), this.timeoutMs)
    } catch (err) {
      throw this.mapTimeout(err, `${input.provider} 的模型列表拉取超时`)
    }
  }

  /**
   * `model.probe`：连通性自检。**返回归因而非抛错**（docs/21 §2.7 六类归因）。
   * `base_url` 供批次④的真实适配器使用（replay 适配器忽略）。
   */
  async probe(input: {
    readonly provider: string
    readonly model?: string
    readonly base_url?: string
  }): Promise<ProbeResult> {
    void input.base_url
    try {
      const adapter = this.requireAdapter(input.provider)
      let models: readonly ModelInfo[]
      try {
        models = await withTimeout((signal) => adapter.listModels(signal), this.timeoutMs)
      } catch (err) {
        throw this.mapTimeout(err, `${input.provider} 探测超时`)
      }
      if (input.model !== undefined && !models.some((m) => m.id === input.model)) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EL_UNKNOWN_MODEL,
          message: `模型不在 ${input.provider} 的可用清单里：${input.model}`,
          userMessage: '这个模型名不存在，请检查拼写。',
          retryable: false,
        })
      }
      return { ok: true, models }
    } catch (err) {
      return { ok: false, failure: toProbeFailure(err) }
    }
  }

  /** `model.getDefault`：未配置回 undefined（契约：无错误路径） */
  async getDefault(): Promise<ModelSelection | undefined> {
    if (!this.deps.ctx.has('agentDefaultModel')) return undefined
    const sel = this.deps.ctx.get('agentDefaultModel').get()
    return sel === undefined ? undefined : fromCoreSelection(sel)
  }

  /** `model.setDefault`：写默认（幂等：写同值） */
  async setDefault(input: { readonly selection: ModelSelection }): Promise<{ readonly saved: true }> {
    assertSelection(input.selection)
    await this.deps.ctx.get('agentDefaultModel').set(toCoreSelection(input.selection))
    return { saved: true }
  }

  /** `model.watchDefault`：幂等重订阅——每次调用返回新的独立流 */
  watchDefault(): ValueStream<ModelSelection | undefined> {
    const stream = new ValueStream<ModelSelection | undefined>()
    const models = this.deps.ctx.get('agentDefaultModel')
    const dispose = models.watch((sel) => {
      stream.push(sel === undefined ? undefined : fromCoreSelection(sel))
    })
    stream.attachUpstream(dispose)
    return stream
  }

  // ─────────── 自定义模型的写路径（18 §2 / §8.2；批次④） ───────────

  /** 全部自定义模型（**不含凭据值**，只有引用名） */
  async listCustom(): Promise<readonly CustomModelInfo[]> {
    const store = this.requireStore()
    return (await store.list()).map(toCustomInfo)
  }

  /**
   * 保存一份自定义模型配置（18 §8.2：**保存后必须自检**）。
   *
   * 两件事，顺序不能反：
   * 1. **先落盘配置**（`settings.model.providers`）——哪怕自检失败，用户的输入也不该丢
   * 2. **再把凭据值写进 `credentials`**，settings 里只留引用名（D22 / I7）
   *
   * 自检（`probe`）的结果通过 `probe` 单独返回，**不阻塞保存**：
   * 18 §8.2 要求的是"保存后立即给可读结果"，不是"自检通过才准保存"。
   * 用户填错地址时应该能看到配置留着、并且看到失败原因，而不是被回滚。
   */
  async saveCustom(input: {
    readonly name: string
    readonly label?: string
    readonly model?: string
    readonly base_url: string
    readonly api_key?: string
    readonly api_key_ref?: string
    readonly models?: readonly string[]
  }): Promise<{ readonly saved: true; readonly provider: string; readonly api_key_ref: string }> {
    const store = this.requireStore()
    const name = input.name.trim()

    // 凭据引用名：用户没给就按 id 推导一个（`CUSTOM_API_KEY` 这类），保持可读
    const refName = (input.api_key_ref ?? '').trim() === '' ? refNameFor(name) : input.api_key_ref!.trim()
    const label = input.label ?? name

    const saved = await store.upsert({
      name,
      label,
      // 模型 id 缺省回落到 label——"显示名恰好就是服务端模型名"是最常见的形态，
      // 不该逼所有人多填一遍。校验（非空）在 store 里，是权威那一处。
      model: input.model ?? label,
      base_url: input.base_url,
      api_key_ref: refName,
      ...(input.models === undefined ? {} : { models: input.models }),
    })

    // 只在用户真的填了值时才写凭据——空值表示"这个端点不需要密钥"（本地模型），
    // 不该凭空造一条空记录（那会让"未配置"看起来像"已配置"）。
    if (input.api_key !== undefined && input.api_key !== '') {
      this.requireCredentials().write(saved.api_key_ref, input.api_key)
    }
    return { saved: true, provider: saved.name, api_key_ref: saved.api_key_ref }
  }

  /**
   * 删除一份自定义模型配置。
   *
   * **默认连凭据一起删**（`delete_credential !== false`）：用户删掉这一家，多半是
   * 不想再留着它的密钥。但要给它一个退出——网关凭据可能被多家共用，
   * 那时传 `delete_credential: false` 只删配置。
   */
  async removeCustom(input: {
    readonly name: string
    readonly delete_credential?: boolean
  }): Promise<{ readonly removed: boolean }> {
    const store = this.requireStore()
    const existing = await store.get(input.name)
    const result = await store.remove(input.name)
    if (result.removed && existing !== undefined && existing.api_key_ref !== '' && input.delete_credential !== false) {
      this.requireCredentials().delete(existing.api_key_ref)
    }
    return result
  }

  // ─────────── 内部 ───────────

  private requireStore(): CustomModelStoreLike {
    const store = this.deps.customModels
    if (store === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: 'model.* 的自定义模型写路径未装配（缺 customModels 依赖）',
        userMessage: '当前环境还不能保存模型配置。',
        retryable: false,
      })
    }
    return store
  }

  private requireCredentials(): CredentialWriteLike {
    const credentials = this.deps.credentials
    if (credentials === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: 'model.* 需要凭据写入能力，但未装配（缺 credentials 依赖）',
        userMessage: '当前环境还不能保存 API Key。',
        retryable: false,
      })
    }
    return credentials
  }

  private requireAdapter(provider: string) {
    if (typeof provider !== 'string' || provider.trim() === '') {
      throw invalidParams('provider 必填')
    }
    const adapter = this.deps.ctx.get('llm').get(provider)
    if (adapter === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_NO_ADAPTER,
        message: `没有注册名为「${provider}」的模型适配器`,
        userMessage: '这个模型供应商不可用。请到「设置 → 模型」换一个。',
        retryable: false,
      })
    }
    return adapter
  }

  /** withTimeout 的 TimeoutError → EN-TIMEOUT（其余原样上抛） */
  private mapTimeout(err: unknown, message: string): unknown {
    if (err instanceof TimeoutError) {
      return new LcodeErrorImpl({
        code: ERROR_CODES.EN_TIMEOUT,
        message: `${message}（${this.timeoutMs}ms）`,
        userMessage: '连接模型超时了。请检查网络或服务是否在运行。',
        retryable: true,
      })
    }
    return err
  }
}

/** 六类归因（docs/21 §2.7；未映射错误归 endpoint-unreachable 并保留原始 code） */
export function toProbeFailure(err: unknown): ProbeFailure {
  const code = err instanceof LcodeErrorImpl ? err.code : undefined
  const message = err instanceof Error ? err.message : String(err)
  let kind: ProbeFailure['kind']
  switch (code) {
    case ERROR_CODES.EL_CREDENTIAL_REJECTED:
      kind = 'credential-rejected'
      break
    case ERROR_CODES.EL_ENDPOINT_UNREACHABLE:
      kind = 'endpoint-unreachable'
      break
    case ERROR_CODES.EL_UNKNOWN_MODEL:
      kind = 'model-not-found'
      break
    case ERROR_CODES.EN_TIMEOUT:
      kind = 'timeout'
      break
    case ERROR_CODES.EL_PROVIDER_NOT_RUNNING:
      kind = 'provider-not-running'
      break
    case ERROR_CODES.EL_CREDENTIAL_MISSING:
      kind = 'not-configured'
      break
    default:
      // EL-NO_ADAPTER 等未映射码：供应商本地不可用/不可达是最接近的归因；
      // 原始 code 随 failure 保留，诊断不丢真
      kind = 'endpoint-unreachable'
  }
  return { kind, ...(code !== undefined ? { code } : { code: 'ET-ERROR' }), message }
}

function assertSelection(selection: ModelSelection): void {
  if (typeof selection !== 'object' || selection === null) throw invalidParams('selection 必填')
  if (typeof selection.provider !== 'string' || selection.provider.trim() === '') {
    throw invalidParams('selection.provider 必填')
  }
  if (typeof selection.model !== 'string' || selection.model.trim() === '') {
    throw invalidParams('selection.model 必填')
  }
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_INVALID_PARAMS,
    message,
    userMessage: '这个请求的参数不对。',
    retryable: false,
  })
}

// ─────────── 选择形态换算 ───────────
// docs/21 §2.0 的 ModelSelection 是扁平形（maxTokens 等在顶层）；core 实现为
// 嵌套 params。DTO 的最终拍平/还原由 IPC/RPC 层（T5.3）负责，这里做双向换算。

function fromCoreSelection(sel: CoreModelSelection): ModelSelection {
  return {
    provider: sel.provider,
    model: sel.model,
    ...(sel.params?.maxTokens !== undefined ? { maxTokens: sel.params.maxTokens } : {}),
    ...(sel.params?.reasoningEffort !== undefined ? { reasoningEffort: sel.params.reasoningEffort } : {}),
    ...(sel.params?.temperature !== undefined ? { temperature: sel.params.temperature } : {}),
  }
}

function toCoreSelection(sel: ModelSelection): CoreModelSelection {
  const hasParams =
    sel.maxTokens !== undefined || sel.reasoningEffort !== undefined || sel.temperature !== undefined
  return {
    provider: sel.provider,
    model: sel.model,
    ...(hasParams
      ? {
          params: {
            ...(sel.maxTokens !== undefined ? { maxTokens: sel.maxTokens } : {}),
            ...(sel.reasoningEffort !== undefined ? { reasoningEffort: sel.reasoningEffort } : {}),
            ...(sel.temperature !== undefined ? { temperature: sel.temperature } : {}),
          },
        }
      : {}),
  }
}
