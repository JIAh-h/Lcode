import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent } from '@lcode/session'

/**
 * 附件内容寻址存储。
 *
 * 文件名就是内容的 SHA-256（附带按媒体类型选择的扩展名），同一张图在多少个会话里
 * 出现都只落一份。日志里只保存 `image-ref`；请求构建前再由宿主解析成 base64。
 * 这样导出、回放和压缩都不会被图片体积拖垮，也让"删会话后清理附件"有明确判据。
 */

const MEDIA_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const HASH_RE = /^[a-f0-9]{64}$/

export function attachmentsRoot(home: string): string {
  return join(home, 'attachments')
}

export interface StoredAttachment {
  readonly hash: string
  readonly mediaType: string
  readonly bytes: number
}

export function putAttachment(input: {
  readonly home: string
  readonly mediaType: string
  readonly data: string
}): StoredAttachment {
  const extension = MEDIA_EXT[input.mediaType]
  if (extension === undefined) throw new Error(`不支持的图片类型：${input.mediaType}`)
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.length === 0) throw new Error('图片内容为空')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const root = attachmentsRoot(input.home)
  mkdirSync(root, { recursive: true })
  const target = join(root, `${hash}.${extension}`)
  if (!existsSync(target)) writeFileSync(target, bytes, { mode: 0o600 })
  return { hash, mediaType: input.mediaType, bytes: bytes.length }
}

export function readAttachment(input: {
  readonly home: string
  readonly hash: string
  readonly mediaType: string
}): string | undefined {
  const path = attachmentPath(input)
  if (path === undefined) return undefined
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return undefined
  }
}

export function attachmentPath(input: {
  readonly home: string
  readonly hash: string
  readonly mediaType: string
}): string | undefined {
  const extension = MEDIA_EXT[input.mediaType]
  if (extension === undefined || !HASH_RE.test(input.hash)) return undefined
  return join(attachmentsRoot(input.home), `${input.hash}.${extension}`)
}

/** 从事件里收集附件引用（压缩摘要不影响：原始事件仍在日志里）。 */
export function attachmentRefsOf(events: readonly SessionEvent[]): readonly StoredAttachment[] {
  const seen = new Map<string, StoredAttachment>()
  for (const event of events) {
    const blocks =
      event.type === 'user/message'
        ? event.data.content
        : event.type === 'assistant/message'
          ? event.data.message.content
          : event.type === 'tool/result'
            ? event.data.message.content
            : undefined
    if (blocks === undefined || typeof blocks === 'string') continue
    for (const block of blocks) collectBlock(block, seen)
  }
  return [...seen.values()]
}

function collectBlock(block: unknown, seen: Map<string, StoredAttachment>): void {
  if (typeof block !== 'object' || block === null) return
  const value = block as { readonly type?: unknown; readonly hash?: unknown; readonly mediaType?: unknown; readonly bytes?: unknown; readonly content?: unknown }
  if (value.type === 'image-ref' && typeof value.hash === 'string' && typeof value.mediaType === 'string') {
    seen.set(value.hash, {
      hash: value.hash,
      mediaType: value.mediaType,
      bytes: typeof value.bytes === 'number' ? value.bytes : 0,
    })
    return
  }
  if (value.type === 'tool_result' && Array.isArray(value.content)) {
    for (const nested of value.content) collectBlock(nested, seen)
  }
}

/**
 * 删除没有会话再引用的附件。
 *
 * 调用方应传入**当前全部会话（含归档与回收站）引用到的 hash**；函数只删附件目录里
 * 不在集合中的文件。任何一次失败都向外抛，让清理失败可见，而不是静默留下垃圾。
 */
export function gcAttachments(input: {
  readonly home: string
  readonly referenced: ReadonlySet<string>
}): { readonly removed: number; readonly bytes: number } {
  const root = attachmentsRoot(input.home)
  if (!existsSync(root)) return { removed: 0, bytes: 0 }
  let removed = 0
  let bytes = 0
  for (const name of readdirSync(root)) {
    const hash = name.split('.')[0]
    if (hash === undefined || input.referenced.has(hash)) continue
    try {
      const path = join(root, name)
      const size = statSync(path).size
      rmSync(path, { force: true })
      removed += 1
      bytes += size
    } catch {
      // 单个文件删不掉不影响其余清理；下次还会再试
    }
  }
  return { removed, bytes }
}
