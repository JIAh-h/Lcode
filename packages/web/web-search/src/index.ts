import { MAX_WEB_SEARCH_RESULTS } from '@lcode/web'
import type { WebSearchInput, WebSearchProviderInfo, WebSearchResult } from '@lcode/web'

export { createTavilySearchBackend, TAVILY_API_KEY_REF, TAVILY_ENDPOINT, TAVILY_PROVIDER } from './tavily.ts'
export type { TavilyFetch, TavilySearchOptions } from './tavily.ts'

export interface WebSearchBackend {
  readonly provider: WebSearchProviderInfo
  search(input: {
    readonly query: string
    readonly maxResults: number
    readonly domains?: readonly string[] | undefined
    readonly signal?: AbortSignal | undefined
  }): Promise<readonly { readonly title: string; readonly url: string; readonly snippet?: string }[]>
}

export interface WebSearcher {
  readonly provider: WebSearchProviderInfo
  search(input: WebSearchInput): Promise<WebSearchResult>
}

/**
 * 搜索端点不是内置服务：由 profile 注入经过审查的 backend，避免硬编码第三方出口。
 * 这里只做参数夹紧、URL 规范化和 provider 身份透出。
 */
export function createWebSearcher(backend: WebSearchBackend): WebSearcher {
  return {
    provider: backend.provider,
    async search(input) {
      const query = input.query.trim()
      if (query === '') throw new Error('搜索词不能为空')
      const maxResults = Math.min(MAX_WEB_SEARCH_RESULTS, Math.max(1, Math.floor(input.maxResults ?? 5)))
      const results = await backend.search({
        query,
        maxResults,
        ...(input.domains === undefined ? {} : { domains: input.domains }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const seen = new Set<string>()
      const normalized = results.flatMap((result) => {
        try {
          const url = new URL(result.url)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
          const href = url.toString()
          if (seen.has(href)) return []
          seen.add(href)
          return [{
            title: result.title.trim() || url.hostname,
            url: href,
            snippet: (result.snippet ?? '').trim(),
            domain: url.hostname,
          }]
        } catch {
          return []
        }
      })
      return {
        query,
        results: normalized.slice(0, maxResults),
        truncated: normalized.length > maxResults,
      }
    },
  }
}
