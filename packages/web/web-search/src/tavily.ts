import { MAX_WEB_SEARCH_RESULTS } from '@lcode/web'
import type { WebSearchProviderInfo } from '@lcode/web'
import { ProxyAgent } from 'undici'
import type { WebSearchBackend } from './index.ts'

/** 凭据引用名：值只能存在于本机凭据服务，不进入 settings。 */
export const TAVILY_API_KEY_REF = 'TAVILY_API_KEY'
export const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
export const TAVILY_PROVIDER: WebSearchProviderInfo = {
  id: 'tavily',
  label: 'Tavily',
  endpointHost: 'api.tavily.com',
}

export type TavilyRequestInit = Omit<RequestInit, 'dispatcher'> & { readonly dispatcher?: unknown }
export type TavilyFetch = (input: string | URL, init?: TavilyRequestInit) => Promise<Response>

export interface TavilySearchOptions {
  /** 每次调用都重新读取：设置页刚保存的 Key 无需重启即可生效。 */
  readonly resolveApiKey: () => Promise<string | undefined> | string | undefined
  readonly fetch?: TavilyFetch | undefined
  /** 测试可注入；默认固定官方端点。 */
  readonly endpoint?: string | undefined
  readonly timeoutMs?: number | undefined
  /** 返回系统/应用代理 URL；undefined 表示直连。 */
  readonly resolveProxy?: ((target: string) => Promise<string | undefined> | string | undefined) | undefined
}

const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Tavily 搜索 backend。
 *
 * 只接受模型给的 query / maxResults / include_domains；端点、鉴权方式和请求形状都由
 * 本地配置固定，模型无法把请求改到别的站点。搜索结果仍是不可信数据，由工具层包裹。
 */
export function createTavilySearchBackend(options: TavilySearchOptions): WebSearchBackend {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as TavilyFetch)
  const endpoint = options.endpoint ?? TAVILY_ENDPOINT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    provider: TAVILY_PROVIDER,
    async search(input) {
      const apiKey = (await options.resolveApiKey())?.trim() ?? ''
      if (apiKey === '') throw new Error('还没有配置 Tavily API Key。请到「设置 → 网页搜索」配置后再试。')
      const query = input.query.trim()
      if (query === '') throw new Error('搜索词不能为空')
      const maxResults = Math.min(MAX_WEB_SEARCH_RESULTS, Math.max(1, Math.floor(input.maxResults)))
      const domains = normalizeDomains(input.domains ?? [])

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('Tavily 搜索超时')), timeoutMs)
      const onAbort = (): void => controller.abort()
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.signal?.aborted === true) controller.abort()
      const proxy = await options.resolveProxy?.(endpoint)
      const dispatcher = proxy === undefined || proxy === '' ? undefined : new ProxyAgent(proxy)

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query,
            max_results: maxResults,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
            ...(domains.length === 0 ? {} : { include_domains: domains }),
          }),
          redirect: 'error',
          signal: controller.signal,
          ...(dispatcher === undefined ? {} : { dispatcher }),
        })

        if (!response.ok) {
          const detail = await readCappedText(response, 4096).catch(() => '')
          throw new Error(tavilyError(response.status, detail))
        }

        const raw = await readCappedText(response, MAX_RESPONSE_BYTES)
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new Error('Tavily 返回了无法解析的响应')
        }
        const results = (parsed as { results?: unknown }).results
        if (!Array.isArray(results)) throw new Error('Tavily 返回的数据缺少 results 数组')
        return results.flatMap((item) => {
          if (typeof item !== 'object' || item === null) return []
          const record = item as Record<string, unknown>
          const url = typeof record.url === 'string' ? record.url.trim() : ''
          if (url === '') return []
          const title = typeof record.title === 'string' ? record.title.trim().slice(0, 300) : ''
          const content = typeof record.content === 'string' ? record.content.trim() : ''
          return [{ title, url: url.slice(0, 4000), snippet: content.slice(0, 2000) }]
        }).slice(0, maxResults)
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
        try {
          void dispatcher?.destroy()
        } catch {
          // 连接已结束时销毁失败不影响结果
        }
      }
    },
  }
}

function normalizeDomains(values: readonly string[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === '') continue
    try {
      const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
      if (url.hostname === '' || url.hostname.includes('*')) continue
      out.add(url.hostname)
    } catch {
      // 非域名形态直接丢弃；不把任意字符串原样发给 provider
    }
    if (out.size >= 20) break
  }
  return [...out]
}

function tavilyError(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'Tavily API Key 无效或没有权限。请在「设置 → 网页搜索」重新填写。'
  if (status === 429) return 'Tavily 搜索额度或频率受限，请稍后再试。'
  if (status >= 500) return 'Tavily 服务暂时不可用，请稍后再试。'
  const snippet = detail.replace(/\s+/g, ' ').trim().slice(0, 200)
  return `Tavily 搜索失败（HTTP ${status}）${snippet === '' ? '' : `：${snippet}`}`
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes * 8) throw new Error('Tavily 响应过大，已拒绝读取')
  const body = response.body
  if (body === null) {
    const all = await response.text()
    return all.slice(0, maxBytes)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = maxBytes - total
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining))
      total += remaining
      break
    }
    chunks.push(value)
    total += value.length
  }
  try {
    await reader.cancel()
  } catch {
    // 已读够；取消失败不影响结果
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}
