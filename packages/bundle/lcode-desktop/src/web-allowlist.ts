import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 按**工作区**记住的 web 工具域名白名单。
 *
 * 审批一次即记入该工作区，之后同域名不再打断；用户可在设置 → 网络访问里移除。
 * 与 shell 的一次性联网授权不同：这里只影响 web_fetch/web_search 的应用层域名判定，
 * 不改变 OS 沙箱的网络能力。
 */
export interface WebAllowlistEntry {
  readonly workspace: string
  readonly domains: readonly string[]
}

export interface WebAllowlistService {
  listFor(workspace: string): readonly string[]
  add(workspace: string, domains: readonly string[]): void
  remove(workspace: string, domain: string): void
  removeWorkspace(workspace: string): void
  snapshot(): readonly WebAllowlistEntry[]
}

interface Persisted {
  readonly version: 1
  readonly workspaces: Readonly<Record<string, readonly string[]>>
}

export function createLocalWebAllowlist(input: { readonly home: string }): WebAllowlistService {
  const file = join(input.home, 'web-allowlist.json')
  let state = load(file)
  const persistState = (next: Persisted): void => {
    state = next
    persist(file, next)
  }
  return {
    listFor: (workspace) => state.workspaces[workspace] ?? [],
    add(workspace, domains) {
      const cleaned = normalizeDomains(domains)
      if (workspace === '' || cleaned.length === 0) return
      const current = state.workspaces[workspace] ?? []
      const merged = [...new Set([...current, ...cleaned])].sort()
      if (merged.length === current.length && merged.every((domain, index) => domain === current[index])) return
      persistState({ version: 1, workspaces: { ...state.workspaces, [workspace]: merged } })
    },
    remove(workspace, domain) {
      const current = state.workspaces[workspace] ?? []
      const next = current.filter((item) => item !== normalizeDomain(domain))
      if (next.length === current.length) return
      const workspaces = { ...state.workspaces }
      if (next.length === 0) delete workspaces[workspace]
      else workspaces[workspace] = next
      persistState({ version: 1, workspaces })
    },
    removeWorkspace(workspace) {
      if (state.workspaces[workspace] === undefined) return
      const workspaces = { ...state.workspaces }
      delete workspaces[workspace]
      persistState({ version: 1, workspaces })
    },
    snapshot: () => Object.entries(state.workspaces)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workspace, domains]) => ({ workspace, domains: [...domains] })),
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function normalizeDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map(normalizeDomain).filter((domain) => domain !== '' && domain !== '*'))]
}

function load(file: string): Persisted {
  if (!existsSync(file)) return { version: 1, workspaces: {} }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>
    if (value.version !== 1 || typeof value.workspaces !== 'object' || value.workspaces === null) return { version: 1, workspaces: {} }
    const workspaces: Record<string, string[]> = {}
    for (const [workspace, domains] of Object.entries(value.workspaces)) {
      if (!Array.isArray(domains)) continue
      const cleaned = normalizeDomains(domains.filter((domain): domain is string => typeof domain === 'string'))
      if (cleaned.length > 0) workspaces[workspace] = cleaned.sort()
    }
    return { version: 1, workspaces }
  } catch {
    return { version: 1, workspaces: {} }
  }
}

function persist(file: string, value: Persisted): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    webAllowlist: WebAllowlistService
  }
}
