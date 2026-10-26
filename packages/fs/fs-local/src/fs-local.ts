import type {
  FsEditHunk,
  FsEditInput,
  FsEditResult,
  FsGlobOpts,
  FsGlobResult,
  FsGrepOpts,
  FsGrepResult,
  FsMutationAccess,
  FsMutationAuthority,
  FsReadOpts,
  FsReadResult,
  FsService,
  FsStat,
  FsWriteOpts,
  FsWriteResult,
} from '@lcode/fs'
import { canonicalPath, normalizePath } from '@lcode/fs'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * `fs-local` —— 本机文件系统实现（批次⑤）。
 *
 * ## 三件它**不做**的事（都在别处）
 *
 * - **不做工作区边界判定**：那是接口层的事（20 §6.1），这层只管读写。
 * - **不做审批**：审批在 `tools/pre-execute` 的 waterfall 里，工具侧根本不感知。
 * - **不碰凭据文件**：`.env*`、`.ssh/` 这类路径的读取要不要放行由策略层决定，
 *   这里照样能读——把"能不能读"混进"怎么读"会让策略散落在实现里。
 *
 * ## 为什么 grep/glob 自己走目录而不是引 ripgrep
 *
 * 骨架阶段要的是**行为正确**（分组、截断标注、行号列号），不是极限性能。引一个
 * 外部二进制会引入"它没装/版本不同/Windows 上路径怪"这三类与产品无关的失败。
 * 等真的成为瓶颈时再换——那时接口不变，换的是这一个文件。
 */

export interface LocalFsOptions {
  /** 工作区根（**仅用于把相对路径解析成绝对路径**，不做边界判定） */
  readonly workspaceRoot: string
  /** 配置后，所有 write/edit 都必须消费一次由策略层签发的精确写入许可。 */
  readonly mutationAuthority?: FsMutationAuthority | undefined
}

const DEFAULT_READ_LIMIT = 2000
const DEFAULT_MAX_RESULTS = 500

/** 目录遍历时跳过的名字（否则 `node_modules` 一项就能吃掉全部预算） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target'])

/**
 * 内存 broker：授权绑定至一次工具调用与精确规范化路径，consume 后立即删除。
 * 它不替代 OS 沙箱；职责是把“策略已放行”安全传递到唯一的本机文件 Provider。
 */
export function createFsMutationAuthority(): FsMutationAuthority {
  const grants = new Map<string, ReadonlySet<string>>()
  const keyOf = (access: FsMutationAccess): string => `${access.sessionId}\u0000${access.callId}`
  return {
    grant(grant): void {
      if (grant.sessionId === '' || grant.callId === '' || grant.paths.length === 0) return
      grants.set(keyOf(grant), new Set(grant.paths.map((path) => canonicalPath(path))))
    },
    consume(access, path): void {
      if (access === undefined || access.sessionId === '' || access.callId === '') {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_DENIED,
          message: '文件写入缺少策略签发的一次性许可',
          userMessage: '这次文件修改没有得到有效授权，已拒绝执行。',
          retryable: false,
        })
      }
      const key = keyOf(access)
      const paths = grants.get(key)
      grants.delete(key)
      const target = canonicalPath(path)
      if (paths?.has(target) === true) return
      throw new LcodeErrorImpl({
        code: ERROR_CODES.ET_DENIED,
        message: `文件写入不在本次授权范围内：${target}`,
        userMessage: '这次文件修改不在已批准的路径范围内，已拒绝执行。',
        retryable: false,
      })
    },
  }
}

function invalid(message: string, userMessage: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.ET_INVALID_ARGS, message, userMessage, retryable: false })
}

function ioFailed(message: string, cause: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ET_ERROR,
    message,
    userMessage: '读写这个文件失败了，请检查路径与权限。',
    retryable: false,
    cause,
  })
}

export function createLocalFs(options: LocalFsOptions): FsService {
  const root = normalizePath(resolve(options.workspaceRoot))

  /** 相对路径 → 绝对路径（返回**规范化后的 POSIX 形式**，与接口层的判定口径一致） */
  const abs = (p: string): string => normalizePath(resolve(root, p))

  return {
    async read(path: string, opts: FsReadOpts = {}): Promise<FsReadResult> {
      const file = abs(path)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (err) {
        throw ioFailed(`读取失败：${file}`, err)
      }
      // 尾部换行不算一行：`a\nb\n` 是 2 行，不是 3 行。否则模型看到的行号会
      // 比编辑器里多一个，而它接下来要用这个行号去 edit。
      const all = text === '' ? [] : text.replace(/\n$/, '').split('\n')
      const offset = Math.max(1, opts.offset ?? 1)
      const limit = Math.max(1, opts.limit ?? DEFAULT_READ_LIMIT)
      const window = all.slice(offset - 1, offset - 1 + limit)
      return {
        path: file,
        offset,
        lines: window.map((line, i) => ({ number: offset + i, text: line })),
        totalLines: all.length,
        truncated: offset - 1 + window.length < all.length,
      }
    },

    async write(path: string, data: string, opts: FsWriteOpts = {}): Promise<FsWriteResult> {
      // 真实路径：写入许可与落盘都必须跟随 symlink，避免“判定是工作区内、实际写到外面”
      const file = canonicalPath(abs(path))
      options.mutationAuthority?.consume(opts.mutationAccess, file)
      const created = !(await exists(file))
      let before = ''
      if (!created) {
        try {
          before = await readFile(file, 'utf8')
        } catch (err) {
          throw ioFailed(`写入前读取失败：${file}`, err)
        }
      }
      try {
        if (opts.createDirs !== false) await mkdir(dirname(file), { recursive: true })
        await writeFile(file, data, 'utf8')
      } catch (err) {
        throw ioFailed(`写入失败：${file}`, err)
      }
      const oldLines = linesOf(before)
      return {
        path: file,
        bytesWritten: Buffer.byteLength(data, 'utf8'),
        created,
        hunks: [{ start: 1, end: oldLines.length, oldLines, newLines: linesOf(data) }],
      }
    },

    async edit(input: FsEditInput): Promise<FsEditResult> {
      const file = canonicalPath(abs(input.path))
      options.mutationAuthority?.consume(input.mutationAccess, file)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (err) {
        throw ioFailed(`编辑前读取失败：${file}`, err)
      }
      if (input.oldText === '') throw invalid('oldText 不能为空', '要替换的内容不能为空。')

      const occurrences = countOccurrences(text, input.oldText)
      if (occurrences === 0) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_INVALID_ARGS,
          message: `要替换的内容在 ${file} 里找不到`,
          // 这里**必须**说清楚"没动文件"——否则用户会担心改坏了一半
          userMessage: '要替换的那段文字在文件里没找到，文件没有被改动。',
          retryable: false,
        })
      }
      if (occurrences > 1 && input.replaceAll !== true) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_INVALID_ARGS,
          message: `要替换的内容在 ${file} 里出现了 ${occurrences} 次，无法确定改哪一处`,
          // **不猜**是刻意的（M-TOOL-02）：猜错位置是"看起来成功、其实改错了"的典型成因
          userMessage: `这段文字在文件里出现了 ${occurrences} 次。请给出更长的上下文，或明确要求全部替换。`,
          retryable: false,
        })
      }

      const hunks = hunksOf(text, input.oldText, input.newText, input.replaceAll === true)
      const next = input.replaceAll === true ? text.split(input.oldText).join(input.newText) : replaceFirst(text, input.oldText, input.newText)
      try {
        await writeFile(file, next, 'utf8')
      } catch (err) {
        throw ioFailed(`写入失败：${file}`, err)
      }
      return { path: file, applied: hunks.length, hunks }
    },

    async glob(pattern: string, opts: FsGlobOpts = {}): Promise<FsGlobResult> {
      const base = opts.path === undefined || opts.path === '' ? root : abs(opts.path)
      const max = Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS)
      const matcher = globToRegExp(pattern)
      const include = opts.include === undefined ? undefined : globToRegExp(opts.include)

      const all: string[] = []
      await walk(base, (file) => {
        const rel = normalizePath(relative(root, file))
        if (!matcher.test(rel) && !matcher.test(basename(rel))) return
        if (include !== undefined && !include.test(basename(rel)) && !include.test(rel)) return
        all.push(rel)
      })
      all.sort()
      return { paths: all.slice(0, max), truncated: all.length > max, total: all.length }
    },

    async grep(pattern: string, opts: FsGrepOpts = {}): Promise<FsGrepResult> {
      const base = opts.path === undefined || opts.path === '' ? root : abs(opts.path)
      const max = Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS)
      const flags = opts.caseSensitive === false ? 'i' : ''
      let regex: RegExp
      try {
        regex = new RegExp(pattern, flags)
      } catch (err) {
        throw invalid(`正则非法：${pattern}（${err instanceof Error ? err.message : String(err)}）`, '这个搜索模式不是合法的正则。')
      }
      const include = opts.include === undefined ? undefined : globToRegExp(opts.include)

      const matches: FsGrepResult['matches'][number][] = []
      let total = 0
      await walk(base, (file) => {
        const rel = normalizePath(relative(root, file))
        if (include !== undefined && !include.test(basename(rel)) && !include.test(rel)) return
        let text: string
        try {
          text = readFileSyncText(file)
        } catch {
          return // 二进制 / 读不动：跳过，不让一个文件毁掉整次搜索
        }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const at = regex.exec(line)
          if (at === null) continue
          total += 1
          // 收集到上限就只记数（`total` 仍要准，否则"截断了多少"说不清）
          if (matches.length < max) {
            matches.push({ path: rel, line: i + 1, column: at.index + 1, text: line })
          }
        }
      })
      return { matches, truncated: total > matches.length, total }
    },

    async stat(path: string): Promise<FsStat> {
      const file = abs(path)
      try {
        const s = await stat(file)
        return {
          path: file,
          kind: s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'file',
          size: s.size,
          mtimeMs: s.mtimeMs,
        }
      } catch (err) {
        throw ioFailed(`stat 失败：${file}`, err)
      }
    },

    async readdir(path: string): Promise<readonly string[]> {
      const dir = abs(path)
      try {
        return (await readdir(dir)).slice().sort()
      } catch (err) {
        throw ioFailed(`列目录失败：${dir}`, err)
      }
    },
  }
}

// ─────────── 内部 ───────────

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function readFileSyncText(file: string): string {
  // grep 里用同步读：遍历是深度优先的顺序流程，异步化只是把 await 撒得到处都是、
  // 并不带来并发收益（真正的并发要按批 gather，那是性能优化之后再做的事）。
  // 注意要 `import { readFileSync } from 'node:fs'`，ESM 下没有 require。
  return readFileSync(file, 'utf8')
}

function linesOf(text: string): readonly string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

function replaceFirst(text: string, needle: string, replacement: string): string {
  const at = text.indexOf(needle)
  return at < 0 ? text : text.slice(0, at) + replacement + text.slice(at + needle.length)
}

/**
 * 算出替换前后的行区间（diff 卡片的原料）。
 *
 * 刻意**只做行级的粗粒度切分**：卡片要的是"改了哪几行"，不是字符级 diff。
 * 做得更细需要真正的 diff 算法，而收益只是行内高亮。
 */
function hunksOf(text: string, oldText: string, newText: string, all: boolean): FsEditHunk[] {
  const hunks: FsEditHunk[] = []
  const positions: number[] = []
  let at = text.indexOf(oldText)
  while (at >= 0) {
    positions.push(at)
    if (!all) break
    at = text.indexOf(oldText, at + oldText.length)
  }
  for (const pos of positions) {
    const startLine = text.slice(0, pos).split('\n').length
    const oldLines = oldText.split('\n')
    hunks.push({
      start: startLine,
      end: startLine + oldLines.length - 1,
      oldLines,
      newLines: newText.split('\n'),
    })
  }
  return hunks
}

function basename(p: string): string {
  const at = p.lastIndexOf('/')
  return at < 0 ? p : p.slice(at + 1)
}

/** 深度优先遍历（跳过 `SKIP_DIRS`；不跟随符号链接，避免环路） */
async function walk(dir: string, onFile: (file: string) => void): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 读不动的目录（权限之类）直接跳过，不让它毁掉整次遍历
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, onFile)
    } else if (entry.isFile()) {
      onFile(normalizePath(full))
    }
  }
}

/**
 * 极小的 glob（`*` / `**` / `?`）。
 *
 * 不引第三方实现：要支持的语法很小，而依赖带来的"版本/打包/平台"成本比这 20 行高。
 * 真需要 `{a,b}` 这类扩展时再换（接口不变）。
 */
function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
        // `**/` 应当也能匹配"零层目录"（`**/*.ts` 要能匹配根下的 `a.ts`）
        if (pattern[i + 1] === '/') i += 1
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
