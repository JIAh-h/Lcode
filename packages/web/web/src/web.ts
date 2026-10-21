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

/** WebService —— 网页抓取/搜索（抓回内容必须包裹并转义，12 §8 提示注入防线） */
export interface WebService {
  fetch(input: { readonly url: string; readonly maxBytes?: number; readonly signal?: AbortSignal }): Promise<WebFetchResult>
  search(input: { readonly query: string; readonly maxResults?: number; readonly domains?: readonly string[] }): Promise<WebSearchResult>
}

/** 仅组合两个已注入的 capability，不选择网络后端也不读取配置。 */
export function composeWebService(input: Pick<WebService, 'fetch' | 'search'>): WebService {
  return { fetch: input.fetch, search: input.search }
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    web: WebService
  }
}
