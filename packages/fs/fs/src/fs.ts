/**
 * FsService —— 文件系统能力（文档 20 §6.1 文件族；21 §3.1–3.5 是工具侧的规范值形状）。
 *
 * ## 两条纪律
 *
 * - **路径在进入本接口前已被规范化并做过工作区边界判定**（20 §6.1）：实现层不得各自
 *   实现一套边界判定，否则"算不算工作区内"会有多个答案。
 * - **返回规范值（无损 JSON）**，不是裸字符串：同一份值同时服务模型、UI 投影与回放（D8）。
 *
 * ## 为什么 `read` 给的是**行窗口**而不是整段 content
 *
 * 21 §3.1 要求 `read` 支持 `offset`/`limit` 并把**行号**一起返回——模型后续要 `edit`
 * 某个位置时，行号是它的坐标系。返回一整段文本会让模型自己数行，那是错误的主要来源。
 */

/** 一行（带行号；行号从 1 起，与编辑器一致） */
export interface FsLine {
  readonly number: number
  readonly text: string
}

/** 读文件（21 §3.1 的规范值形状） */
export interface FsReadResult {
  readonly path: string
  /** 本次窗口的起始行（1 起） */
  readonly offset: number
  readonly lines: readonly FsLine[]
  /** 文件总行数（不受窗口影响——模型据此判断"还有多少没看"） */
  readonly totalLines: number
  /** 是否因为窗口而截断 */
  readonly truncated: boolean
}

export interface FsWriteResult {
  readonly path: string
  readonly bytesWritten: number
  /** 本次是否新建了文件（已存在则为 false） */
  readonly created: boolean
  /** 整体写入的前后行差异；用于写后审查和会话回放，不依赖重新读取当前文件。 */
  readonly hunks: readonly FsEditHunk[]
}

/** 一处替换（`edit` 的结果；diff 卡片据此**纯投影重建**，不重读文件——20 §6.3 / M-DIFF-01） */
export interface FsEditHunk {
  /** 起始行（1 起） */
  readonly start: number
  readonly end: number
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
}

export interface FsEditResult {
  readonly path: string
  readonly applied: number
  readonly hunks: readonly FsEditHunk[]
}

export interface FsGlobResult {
  readonly paths: readonly string[]
  /** 是否因为 `maxResults` 而截断——**必须显式标注**，不能让模型以为看到了全部（M-TOOL-03） */
  readonly truncated: boolean
  readonly total: number
}

export interface FsGrepMatch {
  readonly path: string
  /** 1 起 */
  readonly line: number
  /** 1 起 */
  readonly column: number
  readonly text: string
}

export interface FsGrepResult {
  readonly matches: readonly FsGrepMatch[]
  readonly truncated: boolean
  readonly total: number
}

export interface FsStat {
  readonly path: string
  readonly kind: 'file' | 'dir' | 'symlink'
  readonly size: number
  readonly mtimeMs: number
}

export interface FsReadOpts {
  /** 起始行，1 起（默认 1） */
  readonly offset?: number | undefined
  /** 最多读多少行（默认 2000） */
  readonly limit?: number | undefined
}

export interface FsWriteOpts {
  readonly createDirs?: boolean | undefined
  /** 由策略层为一次已批准的写调用签发；配置了 broker 的 Provider 必须消费它。 */
  readonly mutationAccess?: FsMutationAccess | undefined
}

/** 一次写入调用的身份，不能跨会话或跨 tool call 复用。 */
export interface FsMutationAccess {
  readonly sessionId: string
  readonly callId: string
}

/** 策略层签发给文件 Provider 的精确一次性写入许可。 */
export interface FsMutationGrant extends FsMutationAccess {
  readonly paths: readonly string[]
}

/** 文件能力 broker 的最小接口。 */
export interface FsMutationAuthority {
  grant(grant: FsMutationGrant): void
  consume(access: FsMutationAccess | undefined, path: string): void
}

export interface FsEditInput {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  /** 是否替换全部匹配（默认 false；false 时匹配不唯一即报错） */
  readonly replaceAll?: boolean | undefined
  /** 同 `FsWriteOpts.mutationAccess`。 */
  readonly mutationAccess?: FsMutationAccess | undefined
}

export interface FsGlobOpts {
  /** 搜索起点（默认工作区根） */
  readonly path?: string | undefined
  /** 额外的文件过滤（如 `*.ts`） */
  readonly include?: string | undefined
  readonly maxResults?: number | undefined
}

export interface FsGrepOpts extends FsGlobOpts {
  /** 大小写敏感（默认 true） */
  readonly caseSensitive?: boolean | undefined
}

export interface FsService {
  read(path: string, opts?: FsReadOpts): Promise<FsReadResult>
  write(path: string, data: string, opts?: FsWriteOpts): Promise<FsWriteResult>
  /**
   * 精确替换。
   *
   * **匹配不唯一时报错，不猜**（M-TOOL-02）：`oldText` 在文件里出现 0 次或多于 1 次
   * （且没开 `replaceAll`）都算失败。猜一个位置去改，是"看起来成功但改错了地方"的来源。
   */
  edit(input: FsEditInput): Promise<FsEditResult>
  glob(pattern: string, opts?: FsGlobOpts): Promise<FsGlobResult>
  grep(pattern: string, opts?: FsGrepOpts): Promise<FsGrepResult>
  stat(path: string): Promise<FsStat>
  readdir(path: string): Promise<readonly string[]>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    fs: FsService
  }
  interface Events {
    /** 观察到文件变化（写工具执行后发；22 的 fs/observed 在骨架阶段合并到这个名字） */
    'fs/changed': { readonly path: string; readonly kind: 'create' | 'update' | 'delete' }
  }
}

/** 路径工具（接口层统一，22 §7.3） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/**
 * 工作区边界判定（C4：工作区外写入需审批）。
 *
 * ⚠️ 这是**字符串前缀**判断，不是路径解析——所以调用方给的必须是已规范化、
 * 已 `resolve()` 过的**绝对路径**。相对路径、`..`、符号链接都会让这个判断失真，
 * 而那正是"以为在工作区内、实际写到了外面"的成因。
 */
export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = normalizePath(workspaceRoot)
  const t = normalizePath(target)
  return t === root || t.startsWith(root + '/')
}
