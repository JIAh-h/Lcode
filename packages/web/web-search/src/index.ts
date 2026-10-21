import type { WebSearchResult } from '@lcode/web'

export interface WebSearchBackend {
  search(input: { readonly query: string; readonly maxResults: number; readonly domains?: readonly string[] }): Promise<readonly { readonly title: string; readonly url: string; readonly snippet?: string }[]>
}

/** 搜索端点不是内置服务：由 profile 注入经过审查的 backend，避免硬编码第三方出口。 */
export function createWebSearcher(backend: WebSearchBackend) {
  return {
    async search(input: { readonly query: string; readonly maxResults?: number; readonly domains?: readonly string[] }): Promise<WebSearchResult> {
      const maxResults = Math.min(20, Math.max(1, input.maxResults ?? 10))
      const results = await backend.search({ query: input.query, maxResults, ...(input.domains === undefined ? {} : { domains: input.domains }) })
      return {
        query: input.query,
        results: results.slice(0, maxResults).flatMap((result) => {
          try { return [{ title: result.title, url: new URL(result.url).toString(), snippet: result.snippet ?? '', domain: new URL(result.url).hostname }] } catch { return [] }
        }),
        truncated: results.length > maxResults,
      }
    },
  }
}
