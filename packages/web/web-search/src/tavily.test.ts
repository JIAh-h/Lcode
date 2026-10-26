import { describe, expect, it } from 'vitest'
import { createTavilySearchBackend, TAVILY_API_KEY_REF, TAVILY_ENDPOINT, TAVILY_PROVIDER } from './tavily.ts'
import type { TavilyFetch, TavilyRequestInit } from './tavily.ts'

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('tavily backend', () => {
  it('固定端点、Bearer 鉴权、basic 搜索与 include_domains', async () => {
    const calls: Array<{ url: string; init: TavilyRequestInit | undefined }> = []
    const fetchImpl: TavilyFetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return json({ results: [
        { title: 'Docs', url: 'https://docs.example.com/a', content: 'snippet' },
        { title: '', url: 'https://docs.example.com/b', content: '' },
        { title: 'Bad', url: 'file:///etc/passwd', content: 'bad' },
      ] })
    }
    const backend = createTavilySearchBackend({
      resolveApiKey: () => 'tvly-secret',
      fetch: fetchImpl,
      endpoint: TAVILY_ENDPOINT,
    })
    expect(TAVILY_API_KEY_REF).toBe('TAVILY_API_KEY')
    expect(backend.provider).toEqual(TAVILY_PROVIDER)

    const results = await backend.search({
      query: '  lcode  ',
      maxResults: 99,
      domains: ['https://Example.COM/path', 'plain.org', '*.bad.example'],
    })
    expect(results).toEqual([
      { title: 'Docs', url: 'https://docs.example.com/a', snippet: 'snippet' },
      { title: '', url: 'https://docs.example.com/b', snippet: '' },
      { title: 'Bad', url: 'file:///etc/passwd', snippet: 'bad' },
    ])

    const call = calls[0]
    if (call === undefined) throw new Error('没有发出 Tavily 请求')
    expect(call.url).toBe(TAVILY_ENDPOINT)
    expect(call.init?.method).toBe('POST')
    expect(call.init?.redirect).toBe('error')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tvly-secret')
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      query: 'lcode',
      max_results: 10,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_domains: ['example.com', 'plain.org'],
    })
  })

  it('系统代理可用时通过 ProxyAgent 发出', async () => {
    let init: { dispatcher?: unknown } | undefined
    const backend = createTavilySearchBackend({
      resolveApiKey: () => 'tvly-secret',
      fetch: async (_url, options) => {
        init = options
        return json({ results: [] })
      },
      resolveProxy: () => 'http://127.0.0.1:7897',
    })
    await backend.search({ query: 'x', maxResults: 1 })
    expect((init?.dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name).toBe('ProxyAgent')
  })

  it('没有 Key 时不发请求', async () => {
    let calls = 0
    const backend = createTavilySearchBackend({
      resolveApiKey: () => undefined,
      fetch: async () => { calls += 1; return json({ results: [] }) },
    })
    await expect(backend.search({ query: 'x', maxResults: 1 })).rejects.toThrow('还没有配置 Tavily API Key')
    expect(calls).toBe(0)
  })

  it('401/429/500 给出可操作错误且不泄露 Key', async () => {
    for (const [status, text] of [[401, 'invalid key'], [429, 'quota'], [500, 'boom']] as const) {
      const backend = createTavilySearchBackend({
        resolveApiKey: () => 'tvly-secret',
        fetch: async () => new Response(text, { status }),
      })
      const error = await backend.search({ query: 'x', maxResults: 1 }).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain('tvly-secret')
      expect((error as Error).message.length).toBeGreaterThan(0)
    }
  })

  it('返回结构非法时拒绝', async () => {
    const backend = createTavilySearchBackend({
      resolveApiKey: () => 'tvly-secret',
      fetch: async () => json({ nope: [] }),
    })
    await expect(backend.search({ query: 'x', maxResults: 1 })).rejects.toThrow('缺少 results')
  })
})
