import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** 代码索引只收文本类文件：二进制、依赖与构建产物一律跳过。 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.astro',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.fs', '.fsx',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.m', '.mm', '.rb', '.php',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.toml',
  '.ini', '.cfg', '.sql', '.xml', '.txt', '.lua', '.swift', '.dart', '.ex', '.exs',
  '.clj', '.cljs', '.scala', '.proto', '.gradle', '.dockerfile',
])

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', 'coverage', 'vendor', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', '.gradle', '.tox',
])

const MAX_FILES = 5_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_WALK_DEPTH = 16

export interface RepositoryFile {
  /** 相对工作区根，统一使用 `/` */
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

export interface ListFilesResult {
  readonly files: readonly RepositoryFile[]
  readonly truncated: boolean
  readonly skippedOverLimit: number
}

const SKIP_FILENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
])

function isIndexablePath(path: string): boolean {
  const lower = path.toLowerCase()
  const basename = lower.slice(lower.lastIndexOf('/') + 1)
  if (SKIP_FILENAMES.has(basename)) return false
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return false
  if (lower.includes('/node_modules/')) return false
  const at = lower.lastIndexOf('.')
  if (at < 0) return false
  return TEXT_EXTENSIONS.has(lower.slice(at))
}

function toRepositoryFile(root: string, relativePath: string): RepositoryFile | undefined {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('..') || !isIndexablePath(normalized)) return undefined
  try {
    const stat = statSync(join(root, normalized))
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
    return { path: normalized, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size }
  } catch {
    return undefined
  }
}

/**
 * 列工作区文本文件：Git 仓库用 `git ls-files -co --exclude-standard`（让 git 解释
 * .gitignore），非仓库或 git 失败时退化为目录遍历。两种方式都受文件数与大小上限约束。
 */
export function listRepositoryFiles(workspaceRoot: string): ListFilesResult {
  const root = resolve(workspaceRoot)
  const seen = new Set<string>()
  const files: RepositoryFile[] = []
  let truncated = false
  let skippedOverLimit = 0

  const add = (relativePath: string): void => {
    if (seen.has(relativePath)) return
    const file = toRepositoryFile(root, relativePath)
    if (file === undefined) return
    if (files.length >= MAX_FILES) {
      truncated = true
      skippedOverLimit += 1
      return
    }
    seen.add(relativePath)
    files.push(file)
  }

  let listed = false
  try {
    const output = execFileSync(
      'git',
      ['-c', 'core.fsmonitor=false', 'ls-files', '-c', '-o', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8', timeout: 8_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    listed = true
    for (const item of output.split('\0')) {
      if (item !== '') add(item)
    }
  } catch {
    listed = false
  }

  if (!listed) {
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_WALK_DEPTH || files.length >= MAX_FILES) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          walk(full, depth + 1)
          continue
        }
        if (entry.isFile()) add(relative(root, full))
      }
    }
    walk(root, 0)
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, truncated, skippedOverLimit }
}

export interface Chunk {
  readonly index: number
  /** 1-based，闭区间 */
  readonly startLine: number
  readonly endLine: number
  readonly content: string
}

const CHUNK_LINES = 80
const CHUNK_OVERLAP_LINES = 10
const CHUNK_MAX_CHARS = 6_000
const CHUNK_MIN_CHARS = 20

/** 行窗口分块：保留少量重叠，避免函数被切在两块中间。 */
export function chunkFile(content: string): Chunk[] {
  const lines = content.split(/\r?\n/)
  const chunks: Chunk[] = []
  let start = 0
  while (start < lines.length) {
    let end = Math.min(lines.length, start + CHUNK_LINES)
    let text = lines.slice(start, end).join('\n')
    while (text.length > CHUNK_MAX_CHARS && end > start + 1) {
      end = Math.max(start + 1, Math.floor((start + end) / 2))
      text = lines.slice(start, end).join('\n')
    }
    // 单行就超预算（生成的 JSON / 压缩代码）：按字符切开，不硬塞一个巨块
    if (text.length > CHUNK_MAX_CHARS && end === start + 1) {
      const line = lines[start] ?? ''
      for (let offset = 0; offset < line.length; offset += CHUNK_MAX_CHARS) {
        chunks.push({
          index: chunks.length,
          startLine: start + 1,
          endLine: start + 1,
          content: line.slice(offset, offset + CHUNK_MAX_CHARS),
        })
      }
      start += 1
      continue
    }
    if (text.trim().length >= CHUNK_MIN_CHARS) {
      chunks.push({ index: chunks.length, startLine: start + 1, endLine: end, content: text })
    }
    if (end >= lines.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP_LINES)
  }
  return chunks
}
