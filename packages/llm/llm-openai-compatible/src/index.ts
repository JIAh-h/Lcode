import type { Context } from '@lcode/context'
import type { CredentialsService } from '@lcode/credentials'
import { OpenAiCompatibleAdapter } from './adapter.ts'
import type { OpenAiCompatibleOptions } from './adapter.ts'

/**
 * `@lcode/llm-openai-compatible` —— OpenAI 兼容协议适配器（批次④首个真实适配器）。
 *
 * 用 `register()` 把适配器装进 `ctx.llm`（返回 disposer，插件卸载即回滚）。
 *
 * 装配示例（桌面主进程 / CLI / 测试共用同一条路径）：
 *
 * ```ts
 * registerOpenAiCompatible(ctx, {
 *   id: 'custom',
 *   name: '自定义（OpenAI 兼容）',
 *   baseUrl: 'https://api.example.com/v1',
 *   apiKeyRef: 'CUSTOM_API_KEY',
 *   credentials: localCredentials.asCredentialsService(),
 *   // L4 覆盖：设置页里改的 base_url / 凭据引用名从这里生效
 *   overrides: () => ({ baseUrl: settings.get('model.custom.base_url')?.value as string }),
 * })
 * ```
 *
 * **`overrides` 每读一次都现取**：设置页改完立刻生效，不需要重启——这与 D22
 * "凭据每次操作重新解析，避免用户改了没生效无法自查"是同一个取向。
 */
export function registerOpenAiCompatible(ctx: Context, options: OpenAiCompatibleOptions): () => void {
  return ctx.get('llm').register(new OpenAiCompatibleAdapter(options))
}

/** 便捷装配：从 settings + credentials 组装（省掉调用方拼 overrides 的样板） */
export interface WiringOptions {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKeyRef: string
  readonly credentials: CredentialsService
  /** 读用户级覆盖（设置页写入的值）；返回 undefined 表示该项没被覆盖 */
  readonly readSetting?: (key: string) => string | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

export function registerFromSettings(ctx: Context, opts: WiringOptions): () => void {
  const read = opts.readSetting
  const base: OpenAiCompatibleOptions = {
    id: opts.id,
    name: opts.name,
    baseUrl: opts.baseUrl,
    apiKeyRef: opts.apiKeyRef,
    credentials: opts.credentials,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  }
  // `overrides` 只有真的能读设置时才挂：挂一个恒返回 undefined 的函数会让
  // "没接设置"和"接了但值为空"两种情况看起来一样，排查时反而更难。
  const options: OpenAiCompatibleOptions =
    read === undefined
      ? base
      : {
          ...base,
          overrides: (): { readonly baseUrl?: string | undefined; readonly apiKeyRef?: string | undefined } => ({
            baseUrl: read(`${opts.id}.base_url`),
            apiKeyRef: read(`${opts.id}.api_key_ref`),
          }),
        }
  return registerOpenAiCompatible(ctx, options)
}

export { OpenAiCompatibleAdapter } from './adapter.ts'
export type { OpenAiCompatibleOptions } from './adapter.ts'
export { parseSse } from './adapter.ts'
