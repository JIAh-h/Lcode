import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Agent, ProxyAgent } from 'undici'
import { MAX_WEB_FETCH_BYTES } from '@lcode/web'
import type { WebFetchInput, WebFetchResult, WebRedirectPolicy } from '@lcode/web'

export interface WebFetcher {
  fetch(input: WebFetchInput): Promise<WebFetchResult>
}

export interface WebFetcherOptions {
  /** 测试可注入；默认用系统 DNS。 */
  readonly resolveHost?: ((hostname: string) => Promise<readonly string[]>) | undefined
  /** 返回系统/应用代理 URL（如 `http://127.0.0.1:7897`）；undefined 表示直连。 */
  readonly resolveProxy?: ((target: string) => Promise<string | undefined> | string | undefined) | undefined
}

/** 兼容全局 fetch 与测试替身；`dispatcher` 是 undici 的固定解析入口。 */
export type WebRequestInit = Omit<RequestInit, 'dispatcher'> & { readonly dispatcher?: unknown }
export type WebFetchImpl = (input: URL, init: WebRequestInit) => Promise<Response>

const MAX_REDIRECTS = 5

/**
 * 受限 HTTP(S) 获取器；只把文本传给上层，HTML 标签和控制字符不进入模型上下文。
 *
 * ## 网络边界
 *
 * - **SSRF**：拒绝 localhost、私网、链路本地、云元数据与非常规 IPv6 过渡地址。
 * - **DNS 固定**：校验用的解析结果直接交给连接层（`Agent` 的 pinned lookup），
 *   不再让 fetch 在连接时二次解析，堵住 TTL/重绑定窗口。
 * - **重定向**：每一跳都重新做站点边界与 SSRF 校验；跨站跳转不能借一次审批扩大范围。
 * - **体积**：`maxBytes` 强制夹到 `MAX_WEB_FETCH_BYTES`。
 */
/**
 * Node 的 `RequestInit` 用的是内置 undici-types，而独立依赖的 `Agent` 来自另一个
 * undici 类型副本；两者结构一致但类型身份不同，所以在边界处显式转换一次。
 */
const defaultFetch = globalThis.fetch as unknown as WebFetchImpl

export function createWebFetcher(
  fetchImpl: WebFetchImpl = defaultFetch,
  options: WebFetcherOptions = {},
): WebFetcher {
  const resolveHost = options.resolveHost ?? (async (hostname) => (await lookup(hostname, { all: true })).map((item) => item.address))

  return {
    async fetch({ url, maxBytes, signal, redirectPolicy }) {
      const budget = Math.min(Math.max(1, Math.floor(maxBytes ?? MAX_WEB_FETCH_BYTES)), MAX_WEB_FETCH_BYTES)
      const first = parseTarget(url)
      const allowed = allowedHostsFor(first.host, redirectPolicy)
      assertAllowed(first.host, allowed, '初始地址')
      let current: ResolvedTarget = await resolveTarget(first, resolveHost)

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const { response, release } = await requestHop(fetchImpl, current, signal, options.resolveProxy)
        try {
          if (isRedirect(response.status)) {
            const location = response.headers.get('location')
            await discardBody(response)
            if (location === null || location === '') throw new Error('web_fetch 收到没有 Location 的重定向')
            if (hop === MAX_REDIRECTS) throw new Error('web_fetch 重定向次数过多')
            const next = parseTarget(new URL(location, current.url).toString())
            assertAllowed(next.host, allowed, '重定向目标')
            current = await resolveTarget(next, resolveHost)
            continue
          }

          const contentType = response.headers.get('content-type') ?? ''
          if (!/^text\/|application\/(json|xml|javascript)/i.test(contentType)) {
            throw new Error(`web_fetch 拒绝非文本响应：${contentType || 'unknown'}`)
          }
          const { bytes, truncated } = await readCapped(response, budget)
          const raw = new TextDecoder().decode(bytes)
          const text = normalizeText(raw, contentType)
          return {
            url: current.url.toString(),
            finalUrl: response.url || current.url.toString(),
            status: response.status,
            title: titleOf(raw),
            contentType,
            text,
            truncated,
            fetchedAt: Date.now(),
          }
        } finally {
          release()
        }
      }

      throw new Error('web_fetch 重定向次数过多')
    },
  }
}

interface ParsedTarget {
  readonly url: URL
  readonly host: string
}

interface ResolvedTarget extends ParsedTarget {
  /** 仅域名目标有值；IP 字面量直接连接，不再解析。 */
  readonly addresses?: readonly string[] | undefined
}

interface HopResponse {
  readonly response: Response
  release(): void
}

async function requestHop(
  fetchImpl: WebFetchImpl,
  target: ResolvedTarget,
  signal: AbortSignal | undefined,
  resolveProxy: WebFetcherOptions['resolveProxy'],
): Promise<HopResponse> {
  const proxy = await resolveProxy?.(target.url.toString())
  const agent = proxy !== undefined && proxy !== ''
    ? new ProxyAgent(proxy)
    : target.addresses === undefined
      ? undefined
      : new Agent({ connect: { lookup: createPinnedLookup(target.addresses) } })
  const release = (): void => {
    try {
      void agent?.destroy()
    } catch {
      // 连接已结束时销毁失败不影响已经拿到的结果
    }
  }
  try {
    const response = await fetchImpl(target.url, {
      redirect: 'manual',
      ...(signal === undefined ? {} : { signal }),
      ...(agent === undefined ? {} : { dispatcher: agent }),
    })
    return { response, release }
  } catch (error) {
    release()
    throw error
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // 重定向响应体没有价值；取消失败不改变判定
  }
}

function parseTarget(value: string): ParsedTarget {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('web_fetch 收到无效 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('web_fetch 仅支持 http/https URL')
  const host = normalizeHost(url.hostname)
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('web_fetch 拒绝访问本机地址')
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new Error('web_fetch 拒绝访问本机或内网地址')
  }
  return { url, host }
}

async function resolveTarget(target: ParsedTarget, resolveHost: (hostname: string) => Promise<readonly string[]>): Promise<ResolvedTarget> {
  if (isIP(target.host) !== 0) return target
  let addresses: readonly string[]
  try {
    addresses = await resolveHost(target.host)
  } catch {
    throw new Error(`web_fetch 无法解析域名：${target.host}`)
  }
  if (addresses.length === 0) throw new Error(`web_fetch 无法解析域名：${target.host}`)
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw new Error('web_fetch 拒绝访问本机或内网地址')
  }
  return { ...target, addresses }
}

function allowedHostsFor(initialHost: string, policy: WebRedirectPolicy | undefined): readonly string[] {
  // 没有策略（直接调用/测试）时以初始主机作为唯一允许项；有策略则严格按策略，
  // 初始主机不在其中说明调用方绕过了 pre-execute，执行层同样 fail-closed。
  if (policy === undefined) return [initialHost]
  const listed = policy.allowedHosts
    .map(normalizeHost)
    .filter((host) => host !== '' && host !== '*')
  return [...new Set(listed)]
}

function assertAllowed(host: string, allowed: readonly string[], kind: string): void {
  if (allowed.some((candidate) => hostMatches(host, candidate))) return
  throw new Error(`web_fetch 的${kind}不在允许范围内：${host}。如确需访问，请直接请求该地址，让用户单独批准。`)
}

/**
 * 同站点 = 自身、子域或父域。
 *
 * 覆盖 `example.com → www.example.com` 这类常见跳转，但不允许跳到无关站点；
 * IP 字面量只做精确匹配，避免把前缀当成域关系。
 */
function hostMatches(host: string, allowed: string): boolean {
  if (isIP(host) !== 0 || isIP(allowed) !== 0) return host === allowed
  return host === allowed || host.endsWith(`.${allowed}`) || allowed.endsWith(`.${host}`)
}

function normalizeHost(value: string): string {
  return value.replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\.$/, '')
}

/** 把已经校验过的地址交给连接层；DNS 不会在真正建立连接时再解析一次。 */
export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }))
  return (_hostname, options, callback) => {
    const first = pinned[0]
    if (first === undefined) {
      callback(new Error('没有可用的解析地址'), '', 4)
      return
    }
    if (options.all === true) callback(null, pinned)
    else callback(null, first.address, first.family)
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readCapped(response: Response, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes * 8) {
    throw new Error('web_fetch 响应过大，已拒绝读取')
  }
  const body = response.body
  if (body === null) {
    const all = new Uint8Array(await response.arrayBuffer())
    return { bytes: all.subarray(0, maxBytes), truncated: all.length > maxBytes }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = maxBytes - total
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining))
      total += remaining
      truncated = value.length > remaining
      break
    }
    chunks.push(value)
    total += value.length
  }
  try {
    await reader.cancel()
  } catch {
    // 已读够；取消失败不影响结果。
  }
  return { bytes: concat(chunks, total), truncated }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * 本机 / 私网 / 链路本地 / 云元数据 / CGNAT / 保留地址 / 非常规 IPv6。
 *
 * IPv6 只放行 `2000::/3` 全球单播，并额外拒绝 6to4（2002::/16）与 Teredo
 * （2001:0::/32）——它们可以封装任意 IPv4，是常见的 SSRF 绕过路径。
 * 这样 `::ffff:127.0.0.1`、`::ffff:7f00:1`、NAT64 `64:ff9b::/96` 都在连接前被拒。
 */
function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map(Number)
    const a = parts[0] ?? 0
    const b = parts[1] ?? 0
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(address)
    if (bytes === undefined) return true
    // 2000::/3 = 全球单播；其余（::、::1、fc00::/7、fe80::/10、ff00::/8、
    // IPv4 映射/兼容、NAT64 前缀）一律拒绝。
    if (((bytes[0] ?? 0) & 0xe0) !== 0x20) return true
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return true
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true
    return false
  }
  return true
}

function ipv6ToBytes(address: string): Uint8Array | undefined {
  const zone = address.indexOf('%')
  const text = (zone < 0 ? address : address.slice(0, zone)).toLowerCase()
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const left = parseIpv6Groups(halves[0] ?? '')
  const right = halves.length === 2 ? parseIpv6Groups(halves[1] ?? '') : []
  if (left === undefined || right === undefined) return undefined
  const total = left.length + right.length
  if (halves.length === 2 ? total > 7 : total !== 8) return undefined
  const groups = [...left, ...Array<number>(8 - total).fill(0), ...right]
  const bytes = new Uint8Array(16)
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]
    if (group === undefined) return undefined
    bytes[index * 2] = group >> 8
    bytes[index * 2 + 1] = group & 0xff
  }
  return bytes
}

function parseIpv6Groups(value: string): number[] | undefined {
  if (value === '') return []
  const tokens = value.split(':')
  const groups: number[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) return undefined
    if (index === tokens.length - 1 && token.includes('.')) {
      const parts = token.split('.').map(Number)
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
      groups.push(((parts[0] ?? 0) << 8) | (parts[1] ?? 0), ((parts[2] ?? 0) << 8) | (parts[3] ?? 0))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(token)) return undefined
    groups.push(parseInt(token, 16))
  }
  return groups
}

function titleOf(html: string): string {
  const title = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html)?.[1] ?? ''
  return title.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
function normalizeText(raw: string, contentType: string): string {
  const text = /html/i.test(contentType) ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ') : raw
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s{3,}/g, ' ').trim()
}
