import type {} from '@lcode/context'

export interface WebFetchResult {
  readonly url: string
  readonly finalUrl: string
  readonly status: number
  readonly title: string
  readonly contentType: string
  readonly text: string
  readonly truncated: boolean
  readonly fetchedAt: number
}

export interface WebSearchResult {
  readonly query: string
  readonly results: readonly { readonly title: string; readonly url: string; readonly snippet: string; readonly domain: string }[]
  readonly truncated: boolean
}

/** 搜索服务身份：工具要用端点域名申报网络意图，UI 也据此显示“搜索由谁提供”。 */
export interface WebSearchProviderInfo {
  readonly id: string
  readonly label: string
  /** 固定出口主机名（小写）；模型不能改 */
  readonly endpointHost: string
}

export interface WebSearchInput {
  readonly query: string
  readonly maxResults?: number | undefined
  readonly domains?: readonly string[] | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * 重定向边界：本次调用允许落到的站点集合。
 *
 * 策略层在审批通过后给出；抓取器在**每一跳**都校验。跨站重定向不会自动扩大
 * 授权范围——那会让一次“允许访问 a.com”变成“允许访问 a.com 想跳去的任何地方”。
 * 未配置时只允许从初始站点做同站点（自身/父子域）跳转。
 */
export interface WebRedirectPolicy {
  /** 精确主机名，小写、不带端口；`*` 不是合法值 */
  readonly allowedHosts: readonly string[]
}

/** 单次抓取的硬上限；调用方传更大的值也会被夹到这里。 */
export const MAX_WEB_FETCH_BYTES = 2 * 1024 * 1024

/** 单次搜索返回条数上限（控制费用与上下文体积）。 */
export const MAX_WEB_SEARCH_RESULTS = 10

export interface WebFetchInput {
  readonly url: string
  readonly maxBytes?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly redirectPolicy?: WebRedirectPolicy | undefined
}

/** WebService —— 网页抓取/搜索（抓回内容必须包裹并转义，12 §8 提示注入防线） */
export interface WebService {
  fetch(input: WebFetchInput): Promise<WebFetchResult>
  search(input: WebSearchInput): Promise<WebSearchResult>
  /** 搜索由谁提供；缺失表示当前没有可用的搜索 backend。 */
  readonly searchProvider?: WebSearchProviderInfo | undefined
}

/** 仅组合两个已注入的 capability，不选择网络后端也不读取配置。 */
export function composeWebService(input: Pick<WebService, 'fetch' | 'search'> & Pick<Partial<WebService>, 'searchProvider'>): WebService {
  return {
    fetch: input.fetch,
    search: input.search,
    ...(input.searchProvider === undefined ? {} : { searchProvider: input.searchProvider }),
  }
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    web: WebService
  }
}
