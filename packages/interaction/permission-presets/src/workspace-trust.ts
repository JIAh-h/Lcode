import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 用户明确授予过信任的目录。路径精确匹配，绝不隐式继承给子目录。 */
export interface TrustedWorkspace {
  readonly path: string
  readonly trustedAt: number
}

export interface WorkspaceTrustService {
  isTrusted(workspace: string): boolean
  list(): readonly TrustedWorkspace[]
  setTrusted(workspace: string, trusted: boolean): void
}

export interface LocalWorkspaceTrustOptions {
  readonly home: string
  readonly now?: (() => number) | undefined
}

interface TrustFile {
  readonly version: 1
  readonly trusted: readonly TrustedWorkspace[]
}

/**
 * `~/.lcode/trusted-workspaces.json` 的本地实现。
 *
 * 只记录规范化后的绝对目录，并以写临时文件再 rename 的方式更新。信任状态是
 * 宿主侧安全边界，不能依赖 renderer 的内存状态或工作区自己的配置文件。
 */
export function createLocalWorkspaceTrust(options: LocalWorkspaceTrustOptions): WorkspaceTrustService {
  const file = resolve(options.home, 'trusted-workspaces.json')
  const now = options.now ?? (() => Date.now())
  let entries = load(file)

  return {
    isTrusted(workspace) {
      const normalized = normalizeWorkspace(workspace)
      return entries.some((entry) => entry.path === normalized)
    },
    list() {
      return [...entries]
    },
    setTrusted(workspace, trusted) {
      const normalized = normalizeWorkspace(workspace)
      entries = trusted
        ? [...entries.filter((entry) => entry.path !== normalized), { path: normalized, trustedAt: now() }]
        : entries.filter((entry) => entry.path !== normalized)
      persist(file, entries)
    },
  }
}

function normalizeWorkspace(workspace: string): string {
  return resolve(workspace)
}

function load(file: string): TrustedWorkspace[] {
  if (!existsSync(file)) return []
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrustFile>
    if (value.version !== 1 || !Array.isArray(value.trusted)) return []
    return value.trusted.flatMap((entry) =>
      typeof entry?.path === 'string' && typeof entry.trustedAt === 'number'
        ? [{ path: normalizeWorkspace(entry.path), trustedAt: entry.trustedAt }]
        : [],
    )
  } catch {
    // 损坏配置绝不解释成“所有目录可信”。用户可在设置里重新授予信任。
    return []
  }
}

function persist(file: string, entries: readonly TrustedWorkspace[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  const payload: TrustFile = { version: 1, trusted: entries }
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

declare module '@lcode/context' {
  interface Services {
    workspaceTrust: WorkspaceTrustService
  }
}
