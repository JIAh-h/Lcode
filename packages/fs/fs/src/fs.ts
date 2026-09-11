/** 文件读取结果（规范值，21 §3.1） */
export interface FsReadResult {
  readonly path: string
  readonly content: string
  readonly totalLines: number
  /** 读取的区间（按行窗口读时） */
  readonly range?: { readonly from: number; readonly to: number }
}

export interface FsWriteResult {
  readonly path: string
  readonly bytes: number
}

export interface FsStat {
  readonly path: string
  readonly kind: 'file' | 'dir' | 'symlink'
  readonly size: number
  readonly mtimeMs: number
}

export interface WriteOpts {
  readonly createDirs?: boolean
  readonly overwrite?: boolean
}

/**
 * FsService —— 文件系统能力（文档 20 §4.2 接口形状示例）。
 * 路径在进入接口层时已被规范化并做过工作区边界判定（实现层不得各自实现）。
 */
export interface FsService {
  read(path: string, opts?: { readonly range?: readonly [number, number] }): Promise<FsReadResult>
  write(path: string, data: string, opts?: WriteOpts): Promise<FsWriteResult>
  stat(path: string): Promise<FsStat>
  readdir(path: string): Promise<readonly string[]>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    fs: FsService
  }
  interface Events {
    'fs/changed': { readonly path: string; readonly kind: 'create' | 'update' | 'delete' }
  }
}

/** 路径工具（接口层统一，22 §7.3） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/** 工作区边界判定（C4：工作区外写入需审批） */
export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = normalizePath(workspaceRoot)
  const t = normalizePath(target)
  return t === root || t.startsWith(root + '/')
}
