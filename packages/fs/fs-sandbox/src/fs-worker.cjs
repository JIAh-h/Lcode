'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- 该文件作为独立 CJS worker 注入，不能使用 ESM import */

/*
 * 受控文件 worker。由 fs-sandbox 在 AppContainer/Seatbelt 子进程中启动；
 * 只接受工作区内的路径（父进程负责判定），所有读写都受 OS 沙箱 ACL 约束。
 *
 * 不引入任何 workspace 包：这个文件会被单独复制进桌面产物，用 `--eval` 注入，
 * 避免 AppContainer 子进程还要读取应用目录。
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline')

const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
const root = normalizePath(path.resolve(process.env.LCODE_FS_WORKSPACE || process.cwd()))
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target'])
const DEFAULT_READ_LIMIT = 2000
const DEFAULT_MAX_RESULTS = 500

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const abs = (p) => normalizePath(path.resolve(root, p))

class FsError extends Error {
  constructor(code, message, userMessage) {
    super(message)
    this.code = code
    this.userMessage = userMessage
  }
}

function invalid(message, userMessage) {
  return new FsError('ET-INVALID_ARGS', message, userMessage)
}

function ioFailed(message, cause) {
  const error = new FsError('ET-ERROR', message, '读写这个文件失败了，请检查路径与权限。')
  error.cause = cause
  return error
}

async function exists(file) {
  try {
    await fsp.stat(file)
    return true
  } catch {
    return false
  }
}

function linesOf(text) {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function countOccurrences(text, needle) {
  if (needle === '') return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

function replaceFirst(text, needle, replacement) {
  const at = text.indexOf(needle)
  return at < 0 ? text : text.slice(0, at) + replacement + text.slice(at + needle.length)
}

function hunksOf(text, oldText, newText, all) {
  const hunks = []
  const positions = []
  let at = text.indexOf(oldText)
  while (at >= 0) {
    positions.push(at)
    if (!all) break
    at = text.indexOf(oldText, at + oldText.length)
  }
  for (const pos of positions) {
    const startLine = text.slice(0, pos).split('\n').length
    const oldLines = oldText.split('\n')
    hunks.push({ start: startLine, end: startLine + oldLines.length - 1, oldLines, newLines: newText.split('\n') })
  }
  return hunks
}

function basename(p) {
  const at = p.lastIndexOf('/')
  return at < 0 ? p : p.slice(at + 1)
}

function globToRegExp(pattern) {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index]
    if (ch === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 1
        if (pattern[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

async function walk(dir, onFile) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, onFile)
    } else if (entry.isFile()) {
      onFile(normalizePath(full))
    }
  }
}

async function read(msg) {
  const file = abs(msg.path)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    throw ioFailed(`读取失败：${file}`, error)
  }
  const all = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const offset = Math.max(1, msg.offset ?? 1)
  const limit = Math.max(1, msg.limit ?? DEFAULT_READ_LIMIT)
  const window = all.slice(offset - 1, offset - 1 + limit)
  return {
    path: file,
    offset,
    lines: window.map((line, index) => ({ number: offset + index, text: line })),
    totalLines: all.length,
    truncated: offset - 1 + window.length < all.length,
  }
}

async function write(msg) {
  const file = abs(msg.path)
  const created = !(await exists(file))
  let before = ''
  if (!created) {
    try {
      before = await fsp.readFile(file, 'utf8')
    } catch (error) {
      throw ioFailed(`写入前读取失败：${file}`, error)
    }
  }
  try {
    if (msg.createDirs !== false) await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, msg.data, 'utf8')
  } catch (error) {
    throw ioFailed(`写入失败：${file}`, error)
  }
  const oldLines = linesOf(before)
  return {
    path: file,
    bytesWritten: Buffer.byteLength(msg.data, 'utf8'),
    created,
    hunks: [{ start: 1, end: oldLines.length, oldLines, newLines: linesOf(msg.data) }],
  }
}

async function edit(msg) {
  const file = abs(msg.path)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    throw ioFailed(`编辑前读取失败：${file}`, error)
  }
  if (msg.oldText === '') throw invalid('oldText 不能为空', '要替换的内容不能为空。')
  const occurrences = countOccurrences(text, msg.oldText)
  if (occurrences === 0) {
    throw new FsError('ET-INVALID_ARGS', `要替换的内容在 ${file} 里找不到`, '要替换的那段文字在文件里没找到，文件没有被改动。')
  }
  if (occurrences > 1 && msg.replaceAll !== true) {
    throw new FsError(
      'ET-INVALID_ARGS',
      `要替换的内容在 ${file} 里出现了 ${occurrences} 次，无法确定改哪一处`,
      `这段文字在文件里出现了 ${occurrences} 次。请给出更长的上下文，或明确要求全部替换。`,
    )
  }
  const hunks = hunksOf(text, msg.oldText, msg.newText, msg.replaceAll === true)
  const next = msg.replaceAll === true ? text.split(msg.oldText).join(msg.newText) : replaceFirst(text, msg.oldText, msg.newText)
  try {
    await fsp.writeFile(file, next, 'utf8')
  } catch (error) {
    throw ioFailed(`写入失败：${file}`, error)
  }
  return { path: file, applied: hunks.length, hunks }
}

async function glob(msg) {
  const base = msg.path === undefined || msg.path === '' ? root : abs(msg.path)
  const max = Math.max(1, msg.maxResults ?? DEFAULT_MAX_RESULTS)
  const matcher = globToRegExp(msg.pattern)
  const include = msg.include === undefined ? undefined : globToRegExp(msg.include)
  const all = []
  await walk(base, (file) => {
    const rel = normalizePath(path.relative(root, file))
    if (!matcher.test(rel) && !matcher.test(basename(rel))) return
    if (include !== undefined && !include.test(basename(rel)) && !include.test(rel)) return
    all.push(rel)
  })
  all.sort()
  return { paths: all.slice(0, max), truncated: all.length > max, total: all.length }
}

async function grep(msg) {
  const base = msg.path === undefined || msg.path === '' ? root : abs(msg.path)
  const max = Math.max(1, msg.maxResults ?? DEFAULT_MAX_RESULTS)
  const flags = msg.caseSensitive === false ? 'i' : ''
  let regex
  try {
    regex = new RegExp(msg.pattern, flags)
  } catch (error) {
    throw invalid(`正则非法：${msg.pattern}（${error instanceof Error ? error.message : String(error)}）`, '这个搜索模式不是合法的正则。')
  }
  const include = msg.include === undefined ? undefined : globToRegExp(msg.include)
  const matches = []
  let total = 0
  await walk(base, (file) => {
    const rel = normalizePath(path.relative(root, file))
    if (include !== undefined && !include.test(basename(rel)) && !include.test(rel)) return
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const at = regex.exec(line)
      if (at === null) continue
      total += 1
      if (matches.length < max) matches.push({ path: rel, line: index + 1, column: at.index + 1, text: line })
    }
  })
  return { matches, truncated: total > matches.length, total }
}

async function stat(msg) {
  const file = abs(msg.path)
  try {
    const value = await fsp.stat(file)
    return {
      path: file,
      kind: value.isDirectory() ? 'dir' : value.isSymbolicLink() ? 'symlink' : 'file',
      size: value.size,
      mtimeMs: value.mtimeMs,
    }
  } catch (error) {
    throw ioFailed(`stat 失败：${file}`, error)
  }
}

async function readdir(msg) {
  const dir = abs(msg.path)
  try {
    return (await fsp.readdir(dir)).slice().sort()
  } catch (error) {
    throw ioFailed(`列目录失败：${dir}`, error)
  }
}

async function handle(msg) {
  switch (msg.op) {
    case 'read': return await read(msg)
    case 'write': return await write(msg)
    case 'edit': return await edit(msg)
    case 'glob': return await glob(msg)
    case 'grep': return await grep(msg)
    case 'stat': return await stat(msg)
    case 'readdir': return await readdir(msg)
    default: throw invalid(`未知文件操作：${String(msg.op)}`, '这个文件操作不受支持。')
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let chain = Promise.resolve()
rl.on('line', (line) => {
  chain = chain.then(async () => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null || typeof message.id !== 'number') return
    try {
      send({ id: message.id, ok: true, value: await handle(message) })
    } catch (error) {
      send({
        id: message.id,
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'ET-ERROR',
          message: error instanceof Error ? error.message : String(error),
          ...(typeof error?.userMessage === 'string' ? { userMessage: error.userMessage } : {}),
        },
      })
    }
  })
})
send({ type: 'ready' })
