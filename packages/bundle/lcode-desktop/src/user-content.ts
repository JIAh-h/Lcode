import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ContentBlock } from '@lcode/session'

export interface SkillSource {
  catalog(): Promise<readonly { readonly id: string; readonly name: string }[]>
  load(id: string): Promise<{ readonly instructions: string } | undefined>
}

export interface ImageAttachmentWriter {
  put(input: { readonly mediaType: string; readonly data: string }): { readonly hash: string; readonly bytes: number }
}

export interface UserContentInput {
  readonly text: string
  readonly skills?: unknown
  readonly images?: unknown
  /** 文件/文件夹附件（`{ path, kind }`）；内容在这里读取，日志不再只存路径。 */
  readonly attachments?: unknown
  readonly skillsService: SkillSource
  /** 提供时图片写入内容寻址存储，消息只保留引用；缺省仍内联（兼容测试/旧宿主）。 */
  readonly attachmentStore?: ImageAttachmentWriter | undefined
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGES = 4
/** 单张图片的 base64 上限（约 6MB 原始数据）；渲染层会先压缩到 1600px。 */
const MAX_IMAGE_BASE64 = 8_000_000
const MAX_SKILLS = 8

const MAX_ATTACHMENTS = 8
/** 只读文件前缀，避免把 1GB 文件整段读进主进程内存。 */
const MAX_FILE_BYTES = 512 * 1024
/** 进消息正文的字符上限；超出后提示模型用路径继续读。 */
const MAX_FILE_CHARS = 40_000
const MAX_FOLDER_ENTRIES = 200
const MAX_FOLDER_CHARS = 12_000
const MAX_FOLDER_DEPTH = 3
const SKIP_FOLDERS = new Set([
  '.git',
  '.next',
  '.venv',
  '.idea',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv',
])

interface RawAttachment {
  readonly path: string
  readonly kind: 'file' | 'folder'
}

function parseAttachments(raw: unknown): RawAttachment[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: RawAttachment[] = []
  for (const entry of raw) {
    if (out.length >= MAX_ATTACHMENTS) break
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as { path?: unknown; kind?: unknown }
    if (typeof item.path !== 'string' || item.path === '' || seen.has(item.path)) continue
    // 渲染层只该传来绝对路径；相对路径在桌面端含义不明确，直接跳过。
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(item.path)) continue
    seen.add(item.path)
    out.push({ path: item.path, kind: item.kind === 'folder' ? 'folder' : 'file' })
  }
  return out
}

function displayName(path: string): string {
  return basename(path) || path
}

function readFilePrefix(path: string, size: number): { text: string; truncated: boolean; binary: boolean } {
  const limit = Math.min(size, MAX_FILE_BYTES + 1)
  const buffer = Buffer.alloc(limit)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, buffer, 0, limit, 0)
  } finally {
    closeSync(fd)
  }
  const bytes = buffer.subarray(0, read)
  const binary = bytes.subarray(0, 8_192).includes(0)
  if (binary) return { text: '', truncated: false, binary: true }
  let text = bytes.toString('utf8')
  let truncated = size > MAX_FILE_BYTES || read > MAX_FILE_BYTES
  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS)
    truncated = true
  }
  return { text, truncated, binary: false }
}

function folderListing(root: string): { content: string; entries: number; truncated: boolean } {
  const lines: string[] = []
  let entries = 0
  let chars = 0
  let truncated = false

  const walk = (dir: string, relative: string, depth: number): void => {
    if (truncated) return
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      lines.push(`${'  '.repeat(depth)}- [无法读取此目录]`)
      return
    }
    items.sort((a, b) => (
      Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    ))
    for (const item of items) {
      if (entries >= MAX_FOLDER_ENTRIES || chars >= MAX_FOLDER_CHARS) {
        truncated = true
        return
      }
      // 不跟随符号链接：既避免目录环，也避免把工作区外的内容顺手带进来
      if (item.isSymbolicLink()) continue
      if (item.isDirectory() && SKIP_FOLDERS.has(item.name)) continue
      const child = relative === '' ? item.name : `${relative}/${item.name}`
      const line = `${'  '.repeat(depth)}- ${child}${item.isDirectory() ? '/' : ''}`
      lines.push(line)
      entries += 1
      chars += line.length + 1
      if (item.isDirectory()) {
        if (depth + 1 < MAX_FOLDER_DEPTH) walk(join(dir, item.name), child, depth + 1)
        else lines.push(`${'  '.repeat(depth + 1)}- …`)
      }
    }
  }

  walk(root, '', 0)
  const header = `目录：${root}\n`
  const note = '\n（文件夹只发送目录结构；需要具体文件内容时，用 read 工具按路径读取。）'
  const cutoff = truncated ? '\n[目录项过多，已截断]' : ''
  return { content: `${header}${lines.join('\n')}${cutoff}${note}`, entries, truncated }
}

function attachmentBlocks(raw: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const attachment of parseAttachments(raw)) {
    const name = displayName(attachment.path)
    let info
    try {
      info = statSync(attachment.path)
    } catch {
      blocks.push({
        type: 'file-ref',
        kind: attachment.kind,
        path: attachment.path,
        name,
        content: `[附件无法读取：${attachment.path}]`,
        bytes: 0,
      })
      continue
    }
    if (info.isDirectory()) {
      const listing = folderListing(attachment.path)
      blocks.push({
        type: 'file-ref',
        kind: 'folder',
        path: attachment.path,
        name,
        content: listing.content,
        entries: listing.entries,
        truncated: listing.truncated,
      })
      continue
    }
    if (!info.isFile()) {
      blocks.push({
        type: 'file-ref',
        kind: attachment.kind,
        path: attachment.path,
        name,
        content: `[不是普通文件，未内联内容：${attachment.path}]`,
      })
      continue
    }
    try {
      const file = readFilePrefix(attachment.path, info.size)
      blocks.push({
        type: 'file-ref',
        kind: 'file',
        path: attachment.path,
        name,
        content: file.binary
          ? `[二进制文件，未内联内容。需要时用 read 工具读取：${attachment.path}]`
          : (file.text === '' ? '[空文件]' : file.text),
        bytes: info.size,
        ...(file.truncated ? { truncated: true } : {}),
        ...(file.binary ? { binary: true } : {}),
      })
    } catch {
      blocks.push({
        type: 'file-ref',
        kind: 'file',
        path: attachment.path,
        name,
        content: `[附件无法读取：${attachment.path}]`,
      })
    }
  }
  return blocks
}

/**
 * 把 IPC 送来的文本、技能 id、附件与图片组装成同一条 user/message 的内容块。
 *
 * 技能正文在此处从本地只读目录加载——渲染层只传 id，避免把任意文件内容当技能注入。
 * 文件/文件夹附件也在这里读取，渲染层只传路径；内容有字节与字符上限，超出部分
 * 留给模型用 read 工具继续读。图片只接受声明过的 MIME 与有界 base64。
 */
export async function buildUserContent(input: UserContentInput): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  const skillIds = Array.isArray(input.skills)
    ? [...new Set(input.skills.filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, MAX_SKILLS)
    : []
  if (skillIds.length > 0) {
    const catalog = await input.skillsService.catalog()
    for (const id of skillIds) {
      const found = await input.skillsService.load(id)
      if (found === undefined) continue
      blocks.push({
        type: 'skill',
        id,
        name: catalog.find((entry) => entry.id === id)?.name ?? id,
        instructions: found.instructions,
      })
    }
  }
  if (input.text !== '') blocks.push({ type: 'text', text: input.text })
  blocks.push(...attachmentBlocks(input.attachments))

  const rawImages = Array.isArray(input.images) ? input.images : []
  let accepted = 0
  for (const raw of rawImages) {
    if (accepted >= MAX_IMAGES) break
    if (typeof raw !== 'object' || raw === null) continue
    const image = raw as { mediaType?: unknown; data?: unknown }
    const mediaType = image.mediaType
    const data = image.data
    if (
      typeof mediaType !== 'string' ||
      !IMAGE_MEDIA_TYPES.has(mediaType) ||
      typeof data !== 'string' ||
      data === '' ||
      data.length > MAX_IMAGE_BASE64
    ) {
      throw new Error('图片格式不受支持或超过大小上限')
    }
    if (input.attachmentStore === undefined) {
      blocks.push({ type: 'image', mediaType, data })
    } else {
      const stored = input.attachmentStore.put({ mediaType, data })
      blocks.push({ type: 'image-ref', mediaType, hash: stored.hash, bytes: stored.bytes })
    }
    accepted += 1
  }
  if (rawImages.length > 0 && accepted === 0) throw new Error('没有可发送的图片')
  if (blocks.length === 0) throw new Error('text、附件或图片必填')
  return blocks
}
