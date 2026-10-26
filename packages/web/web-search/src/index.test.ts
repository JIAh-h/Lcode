import { describe, expect, it } from 'vitest'
import { TAVILY_PROVIDER } from './tavily.ts'
import { createWebSearcher } from './index.ts'
import type { WebSearchBackend } from './index.ts'

describe('web-search', () => {
  it('透出 provider，夹紧结果数并过滤非法/重复 URL', async () => {
    let seenMax = 0
    let seenSignal: AbortSignal | undefined
    const backend: WebSearchBackend = {
      provider: TAVILY_PROVIDER,
      async search(input) {
        seenMax = input.maxResults
        seenSignal = input.signal
        return [
          { title: 'A', url: 'https://example.com/a', snippet: ' a ' },
          { title: 'A duplicate', url: 'https://example.com/a', snippet: 'dup' },
          { title: 'B', url: 'https://example.com/b' },
          { title: 'Bad', url: 'file:///etc/passwd' },
          { title: '', url: 'https://example.org/c', snippet: '' },
        ]
      },
    }
    const searcher = createWebSearcher(backend)
    const signal = new AbortController().signal
    const result = await searcher.search({ query: '  lcode  ', maxResults: 99, signal })
    expect(searcher.provider).toEqual(TAVILY_PROVIDER)
    expect(seenMax).toBe(10)
    expect(seenSignal).toBe(signal)
    expect(result.query).toBe('lcode')
    expect(result.results.map((item) => item.url)).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.org/c'])
    expect(result.results[0]).toMatchObject({ title: 'A', snippet: 'a', domain: 'example.com' })
    expect(result.results[2]).toMatchObject({ title: 'example.org' })
    expect(result.truncated).toBe(false)
  })

  it('空搜索词直接拒绝，不调用 backend', async () => {
    const backend: WebSearchBackend = {
      provider: TAVILY_PROVIDER,
      async search() { return [] },
    }
    await expect(createWebSearcher(backend).search({ query: '   ' })).rejects.toThrow('搜索词不能为空')
  })
})
