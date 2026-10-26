import { describe, expect, it } from 'vitest'
import { MAX_WEB_FETCH_BYTES } from '@lcode/web'
import { createPinnedLookup, createWebFetcher } from './index.ts'

const publicResolve = async (): Promise<readonly string[]> => ['93.184.216.34']

const text = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } })

describe('web-fetch', () => {
  it('只接受文本 http 响应、裁剪字节并规范化 HTML', async () => {
    const fetcher = createWebFetcher(async () => new Response('<title> Page </title><script>bad()</script><p>Hello</p>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }), { resolveHost: publicResolve })
    await expect(fetcher.fetch({ url: 'https://example.com/a' })).resolves.toMatchObject({ title: 'Page', text: 'Page Hello', status: 200 })
  })

  it('拒绝非 http URL、私网地址与二进制响应', async () => {
    const fetcher = createWebFetcher(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/octet-stream' } }), { resolveHost: publicResolve })
    await expect(fetcher.fetch({ url: 'file:///tmp/nope' })).rejects.toThrow('http/https')
    await expect(fetcher.fetch({ url: 'http://127.0.0.1/admin' })).rejects.toThrow('本机或内网')
    await expect(fetcher.fetch({ url: 'https://example.com/binary' })).rejects.toThrow('非文本')
  })

  it('域名解析到私网时拒绝（DNS 层面的 SSRF）', async () => {
    const fetcher = createWebFetcher(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }), {
      resolveHost: async () => ['10.0.0.8'],
    })
    await expect(fetcher.fetch({ url: 'https://intranet.example.com/' })).rejects.toThrow('本机或内网')
  })

  it('拒绝 IPv6 映射/过渡地址，不能借十六进制形式回到 loopback', async () => {
    let calls = 0
    const fetcher = createWebFetcher(async () => { calls += 1; return text('should not happen') }, { resolveHost: publicResolve })
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::1]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
      'http://[2002:7f00:1::]/',
    ]) {
      await expect(fetcher.fetch({ url }), url).rejects.toThrow('本机或内网')
    }
    expect(calls).toBe(0)
  })

  it('DNS 返回十六进制映射地址时也拒绝', async () => {
    const fetcher = createWebFetcher(async () => text('should not happen'), {
      resolveHost: async () => ['::ffff:7f00:1'],
    })
    await expect(fetcher.fetch({ url: 'https://loopback.example.com/' })).rejects.toThrow('本机或内网')
  })

  it('允许全球单播 IPv6 字面量', async () => {
    const fetcher = createWebFetcher(async () => text('ok'), { resolveHost: publicResolve })
    await expect(fetcher.fetch({ url: 'https://[2606:4700:4700::1111]/' })).resolves.toMatchObject({ text: 'ok' })
  })

  it('重定向到私网会被逐跳拦截', async () => {
    let calls = 0
    const fetcher = createWebFetcher(async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    }, { resolveHost: publicResolve })
    await expect(fetcher.fetch({ url: 'https://example.com/redirect' })).rejects.toThrow('本机或内网')
    expect(calls).toBe(1)
  })

  it('允许同站点重定向（父子域）', async () => {
    const fetcher = createWebFetcher(async (input) => {
      const url = String(input)
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 301, headers: { location: 'https://www.example.com/final' } })
      }
      return text('done')
    }, { resolveHost: publicResolve })
    await expect(fetcher.fetch({ url: 'https://example.com/start' })).resolves.toMatchObject({ status: 200, text: 'done' })
  })

  it('跨站重定向默认拒绝，不把一次授权放大到任意站点', async () => {
    let calls = 0
    const fetcher = createWebFetcher(async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/collect' } })
    }, { resolveHost: publicResolve })
    await expect(fetcher.fetch({ url: 'https://example.com/start' })).rejects.toThrow('重定向目标不在允许范围内')
    expect(calls).toBe(1)
  })

  it('工作区白名单里的站点可作为重定向目标', async () => {
    const fetcher = createWebFetcher(async (input) => {
      const url = String(input)
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/file' } })
      }
      return text('cdn')
    }, { resolveHost: publicResolve })
    await expect(fetcher.fetch({
      url: 'https://example.com/start',
      redirectPolicy: { allowedHosts: ['example.com', 'cdn.example.net'] },
    })).resolves.toMatchObject({ text: 'cdn' })
  })

  it('执行层策略不含初始主机时 fail-closed', async () => {
    let calls = 0
    const fetcher = createWebFetcher(async () => { calls += 1; return text('should not happen') }, { resolveHost: publicResolve })
    await expect(fetcher.fetch({
      url: 'https://example.com/start',
      redirectPolicy: { allowedHosts: ['cdn.example.net'] },
    })).rejects.toThrow('初始地址不在允许范围内')
    expect(calls).toBe(0)
  })

  it('maxBytes 被硬上限夹紧', async () => {
    const body = 'x'.repeat(MAX_WEB_FETCH_BYTES + 32)
    const fetcher = createWebFetcher(async () => text(body), { resolveHost: publicResolve })
    const result = await fetcher.fetch({ url: 'https://example.com/big', maxBytes: Number.MAX_SAFE_INTEGER })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(MAX_WEB_FETCH_BYTES)
  })

  it('域名请求带上固定解析 dispatcher，IP 字面量不带', async () => {
    const seen: Array<{ dispatcher?: unknown }> = []
    const fetcher = createWebFetcher(async (_input, options) => {
      seen.push(options)
      return text('ok')
    }, { resolveHost: publicResolve })
    await fetcher.fetch({ url: 'https://example.com/a' })
    expect(seen[0]?.dispatcher).toBeDefined()
    expect((seen[0]?.dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name).toBe('Agent')

    await fetcher.fetch({ url: 'https://93.184.216.34/a' })
    expect(seen[1]?.dispatcher).toBeUndefined()
  })

  it('系统代理可用时使用 ProxyAgent', async () => {
    const seen: Array<{ dispatcher?: unknown }> = []
    const fetcher = createWebFetcher(async (_input, options) => {
      seen.push(options)
      return text('ok')
    }, {
      resolveHost: publicResolve,
      resolveProxy: (target) => target.startsWith('https://example.com') ? 'http://127.0.0.1:7897' : undefined,
    })
    await expect(fetcher.fetch({ url: 'https://example.com/a' })).resolves.toMatchObject({ text: 'ok' })
    expect((seen[0]?.dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name).toBe('ProxyAgent')
  })

  it('固定解析结果交给连接层，连接时不再走系统 DNS', async () => {
    const lookup = createPinnedLookup(['93.184.216.34', '2606:4700:4700::1111'])
    const all = await new Promise<unknown>((resolve, reject) => {
      lookup('example.com', { all: true } as never, (error, address) => {
        if (error !== null) reject(error)
        else resolve(address)
      })
    })
    expect(all).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
    const single = await new Promise<unknown>((resolve, reject) => {
      lookup('example.com', {} as never, (error, address) => {
        if (error !== null) reject(error)
        else resolve(address)
      })
    })
    expect(single).toBe('93.184.216.34')
  })
})
