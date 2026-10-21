import type { WebFetchResult } from '@lcode/web'

export interface WebFetcher {
  fetch(input: { readonly url: string; readonly maxBytes?: number; readonly signal?: AbortSignal }): Promise<WebFetchResult>
}

/** 受限 HTTP(S) 获取器；仅把文本传给上层，HTML 标签和控制字符不进入模型上下文。 */
export function createWebFetcher(fetchImpl: typeof globalThis.fetch = globalThis.fetch): WebFetcher {
  return {
    async fetch({ url, maxBytes = 2 * 1024 * 1024, signal }) {
      const target = validateHttpUrl(url)
      const response = await fetchImpl(target, { redirect: 'follow', ...(signal === undefined ? {} : { signal }) })
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^text\/|application\/(json|xml|javascript)/i.test(contentType)) throw new Error(`web_fetch 拒绝非文本响应：${contentType || 'unknown'}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const capped = bytes.subarray(0, Math.max(1, maxBytes))
      const raw = new TextDecoder().decode(capped)
      const text = normalizeText(raw, contentType)
      return {
        url: target,
        finalUrl: response.url || target,
        status: response.status,
        title: titleOf(raw),
        contentType,
        text,
        truncated: bytes.length > capped.length,
        fetchedAt: Date.now(),
      }
    },
  }
}

function validateHttpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('web_fetch 仅支持 http/https URL')
  return url.toString()
}
function titleOf(html: string): string {
  const title = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html)?.[1] ?? ''
  return title.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
function normalizeText(raw: string, contentType: string): string {
  const text = /html/i.test(contentType) ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ') : raw
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s{3,}/g, ' ').trim()
}
