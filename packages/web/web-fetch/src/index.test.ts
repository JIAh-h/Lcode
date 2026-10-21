import { describe, expect, it } from 'vitest'
import { createWebFetcher } from './index.ts'

describe('web-fetch', () => {
  it('只接受文本 http 响应、裁剪字节并规范化 HTML', async () => {
    const fetcher = createWebFetcher(async () => new Response('<title> Page </title><script>bad()</script><p>Hello</p>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))
    await expect(fetcher.fetch({ url: 'https://example.com/a' })).resolves.toMatchObject({ title: 'Page', text: 'Page Hello', status: 200 })
  })

  it('拒绝非 http URL 和二进制响应', async () => {
    const fetcher = createWebFetcher(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/octet-stream' } }))
    await expect(fetcher.fetch({ url: 'file:///tmp/nope' })).rejects.toThrow('http/https')
    await expect(fetcher.fetch({ url: 'https://example.com/binary' })).rejects.toThrow('非文本')
  })
})
