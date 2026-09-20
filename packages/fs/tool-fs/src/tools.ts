import { normalizePath } from '@lcode/fs'
import type { FsService } from '@lcode/fs'
import type { ToolDefinition } from '@lcode/tools'
import { resolve } from 'node:path'

/**
 * 文件工具族（21 §3.1–3.5；批次⑤）。
 *
 * ## 一条贯穿全部五个工具的纪律：**让模型能自己纠错**
 *
 * 每个返回的规范值都带上"它需要知道但拿不到"的信息：
 * - `read` 给 `totalLines` 与 `truncated` → 它知道还有多少没看
 * - `glob`/`grep` 给 `truncated` 与 `total` → 它知道自己的模式太宽
 * - `edit` 失败时说明"出现 N 次" → 它知道该补多少上下文
 *
 * 这不是体贴，是**正确性**：模型看不到文件，唯一的坐标系就是我们返回的这几个数。
 * 少给一个，它就只能猜，而猜错的代价是改错文件。
 *
 * ## 五个工具的 `describeAction`
 *
 * 审批与权限判定要看"这次调用想碰什么"（12 §5.4）。由工具自己申报而不是让策略
 * 去解析 JSON——只有工具知道哪个字段是路径。省略 `describeAction` 的调用
 * 会被策略当成"无副作用"直接放行，所以**有副作用的工具必须申报**。
 */

export interface ToolFsDeps {
  readonly fs: FsService
  /**
   * 工作区根（**新会话的默认**；也给"拿不到会话"时兜底）。
   *
   * ⚠️ 别拿它当唯一的根：一个进程里可以开着多个工作区的会话，而这个对象是**单例**。
   * 每次调用真正用的是 `workspaceOf(scope.sessionId)`（见下）。
   */
  readonly workspaceRoot: string
  /**
   * 按**会话**取工作区根。
   *
   * 这是"路径在进入 `FsService` 之前已被解析"的那一步（20 §6.1）：
   * `fs` 是单例、只认绝对路径，而相对路径要按**当前会话**的工作区来解。
   * 少了它，A 会话里说 `read hello.txt` 会去 B 会话的工作区找。
   */
  readonly workspaceOf?: ((sessionId: string) => string | undefined) | undefined
  /** 从 `ExecuteOpts.scope` 里取出会话 id（默认认 `{ sessionId }`） */
  readonly sessionIdOf?: ((scope: unknown) => string | undefined) | undefined
}

/** 把一个路径按工作区解析成绝对路径（POSIX 分隔符，与接口层判定口径一致） */
function absolute(workspaceRoot: string, p: string): string {
  return normalizePath(resolve(workspaceRoot, p))
}

export function createFsTools(deps: ToolFsDeps): readonly ToolDefinition[] {
  const { fs } = deps
  const sessionIdOf = deps.sessionIdOf ?? defaultSessionIdOf

  /**
   * 这次调用该以哪个工作区为根。
   *
   * 优先按会话；取不到会话（或那个会话的工作区查不到）才回落到构造时的根。
   * 回落到 `process.cwd()` 会让"在 A 项目里读 hello.txt"读到 IDE 的目录 —— 实测踩过。
   */
  const rootFor = (opts: { readonly scope?: unknown }): string => {
    const sessionId = sessionIdOf(opts.scope)
    if (sessionId !== undefined) {
      const fromSession = deps.workspaceOf?.(sessionId)
      if (fromSession !== undefined && fromSession !== '') return fromSession
    }
    return deps.workspaceRoot
  }

  const read: ToolDefinition = {
    name: 'read',
    description:
      '读取一个文件的内容，按行返回并带行号。用 offset/limit 读大文件的某一段。' +
      '返回的 totalLines 是整个文件的行数（不受窗口影响），truncated 表示有没有被窗口截断。',
    card: 'read',
    presentationMeta: (_args, value) => {
      const result = value as { path?: unknown; offset?: unknown; lines?: unknown; totalLines?: unknown; truncated?: unknown }
      return {
        path: typeof result.path === 'string' ? result.path : '',
        offset: typeof result.offset === 'number' ? result.offset : 1,
        lines: Array.isArray(result.lines) ? result.lines : [],
        totalLines: typeof result.totalLines === 'number' ? result.totalLines : 0,
        truncated: result.truncated === true,
      }
    },
    timeoutMs: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径或相对工作区）' },
        offset: { type: 'number', description: '起始行，从 1 开始（默认 1）' },
        limit: { type: 'number', description: '最多读多少行（默认 2000）' },
      },
      required: ['path'],
    },
    describeAction: (parsed) => {
      const p = parsed as { path: string }
      return { summary: `读取 ${p.path}`, paths: [{ path: p.path, mode: 'read' }] }
    },
    execute: async (call, opts) => {
      const p = call.parsed as { path: string; offset?: number; limit?: number }
      return (await fs.read(absolute(rootFor(opts), p.path), {
        ...(p.offset === undefined ? {} : { offset: p.offset }),
        ...(p.limit === undefined ? {} : { limit: p.limit }),
      })) as never
    },
  }

  const write: ToolDefinition = {
    name: 'write',
    description:
      '写入一个文件（整体覆盖，文件不存在则创建）。要改文件的一小部分请用 edit —— ' +
      'write 会把文件内容整个替换掉。',
    card: 'diff',
    presentationMeta: (args, value) => {
      const p = args as { path: string; content: string }
      const result = value as { path?: unknown; bytesWritten?: unknown; created?: unknown; hunks?: unknown }
      const path = typeof result.path === 'string' ? result.path : p.path
      const hunks = Array.isArray(result.hunks) ? result.hunks : []
      const lineCounts = hunks.reduce(
        (counts, h) => {
          if (!isRecord(h)) return counts
          return {
            additions: counts.additions + (Array.isArray(h.newLines) ? h.newLines.length : 0),
            deletions: counts.deletions + (Array.isArray(h.oldLines) ? h.oldLines.length : 0),
          }
        },
        { additions: 0, deletions: 0 },
      )
      return {
        path,
        changes: [{ path, kind: result.created === true ? 'create' : 'modify', additions: lineCounts.additions, deletions: lineCounts.deletions }],
        bytesWritten: typeof result.bytesWritten === 'number' ? result.bytesWritten : 0,
        created: result.created === true,
        hunks,
      }
    },
    timeoutMs: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
    describeAction: (parsed) => {
      const p = parsed as { path: string }
      return { summary: `写入 ${p.path}`, paths: [{ path: p.path, mode: 'write' }] }
    },
    execute: async (call, opts) => {
      const p = call.parsed as { path: string; content: string }
      return (await fs.write(absolute(rootFor(opts), p.path), p.content, {
        createDirs: true,
        ...mutationAccessFor(call.callId, opts.scope, sessionIdOf),
      })) as never
    },
  }

  const edit: ToolDefinition = {
    name: 'edit',
    description:
      '把文件里的一段文字替换成另一段。old 必须在文件里**唯一出现**，否则会报错让你补充上下文' +
      '（这是刻意的：猜位置会改错地方）。要替换全部匹配就设 replaceAll。',
    card: 'diff',
    presentationMeta: (args, value) => {
      const p = args as { path: string }
      const result = value as { path?: unknown; applied?: unknown; hunks?: unknown }
      const hunks = Array.isArray(result.hunks) ? result.hunks : []
      const path = typeof result.path === 'string' ? result.path : p.path
      return {
        path,
        changes: [{ path, kind: 'modify', additions: hunks.reduce((n, h) => n + (isRecord(h) && Array.isArray(h.newLines) ? h.newLines.length : 0), 0), deletions: hunks.reduce((n, h) => n + (isRecord(h) && Array.isArray(h.oldLines) ? h.oldLines.length : 0), 0) }],
        applied: typeof result.applied === 'number' ? result.applied : 0,
        hunks,
      }
    },
    timeoutMs: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old: { type: 'string', description: '要被替换的文字（需与文件内容逐字符一致）' },
        new: { type: 'string', description: '替换成什么' },
        replaceAll: { type: 'boolean', description: '是否替换全部匹配（默认 false）' },
      },
      required: ['path', 'old', 'new'],
    },
    describeAction: (parsed) => {
      const p = parsed as { path: string }
      return { summary: `编辑 ${p.path}`, paths: [{ path: p.path, mode: 'write' }] }
    },
    execute: async (call, opts) => {
      const p = call.parsed as { path: string; old: string; new: string; replaceAll?: boolean }
      return (await fs.edit({
        path: absolute(rootFor(opts), p.path),
        oldText: p.old,
        newText: p.new,
        ...(p.replaceAll === undefined ? {} : { replaceAll: p.replaceAll }),
        ...mutationAccessFor(call.callId, opts.scope, sessionIdOf),
      })) as never
    },
  }

  const glob: ToolDefinition = {
    name: 'glob',
    description:
      '按文件名模式找文件（支持 * 与 **）。返回的 truncated 表示结果被截断了 —— ' +
      '为 true 时请收窄模式，否则你会以为看到了全部。',
    card: 'search',
    presentationMeta: (_args, value) => {
      const result = value as { paths?: unknown; truncated?: unknown; total?: unknown }
      return {
        paths: Array.isArray(result.paths) ? result.paths : [],
        truncated: result.truncated === true,
        total: typeof result.total === 'number' ? result.total : 0,
      }
    },
    timeoutMs: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名模式，如 **/*.ts' },
        path: { type: 'string', description: '搜索起点（默认工作区根）' },
        include: { type: 'string', description: '额外的文件名过滤' },
      },
      required: ['pattern'],
    },
    // 只读且不返回文件内容，不触发审批
    execute: async (call, opts) => {
      const p = call.parsed as { pattern: string; path?: string; include?: string }
      const root = rootFor(opts)
      return (await fs.glob(p.pattern, {
        path: p.path === undefined ? root : absolute(root, p.path),
        ...(p.include === undefined ? {} : { include: p.include }),
      })) as never
    },
  }

  const grep: ToolDefinition = {
    name: 'grep',
    description:
      '在文件内容里搜正则。结果按 path/line/column 给出，truncated 表示被截断 —— ' +
      '为 true 时请收窄模式，否则你会以为找全了。',
    card: 'search',
    presentationMeta: (_args, value) => {
      const result = value as { matches?: unknown; truncated?: unknown; total?: unknown }
      return {
        matches: Array.isArray(result.matches) ? result.matches : [],
        truncated: result.truncated === true,
        total: typeof result.total === 'number' ? result.total : 0,
      }
    },
    timeoutMs: 15_000,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索起点（默认工作区根）' },
        include: { type: 'string', description: '只搜匹配这个模式的文件' },
      },
      required: ['pattern'],
    },
    execute: async (call, opts) => {
      const p = call.parsed as { pattern: string; path?: string; include?: string }
      const root = rootFor(opts)
      return (await fs.grep(p.pattern, {
        path: p.path === undefined ? root : absolute(root, p.path),
        ...(p.include === undefined ? {} : { include: p.include }),
      })) as never
    },
  }

  return [read, write, edit, glob, grep] as readonly ToolDefinition[]
}

/** 认引擎传下来的 scope 形状（`{ sessionId }`） */
function defaultSessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const id = (scope as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 文件 Provider 的一次性写入许可由策略 hook 按同一 `(sessionId, callId)` 签发。
 * 没有会话身份时不伪造许可：带 broker 的 Provider 会以 ET-DENIED fail-closed。
 */
function mutationAccessFor(
  callId: string,
  scope: unknown,
  sessionIdOf: (scope: unknown) => string | undefined,
): { readonly mutationAccess?: { readonly sessionId: string; readonly callId: string } } {
  const sessionId = sessionIdOf(scope)
  return sessionId === undefined ? {} : { mutationAccess: { sessionId, callId } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
