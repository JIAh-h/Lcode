import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SandboxService } from '@lcode/sandbox'

/**
 * 记录本机获得过 OS 级授权的沙箱工作区。
 *
 * Windows helper 的 prepare 会给工作区写入 AppContainer ACL；正常路径在“取消信任”
 * 时撤销，但进程崩溃/断电会留下残留。这里把授予过的工作区记下来，启动时对**不再
 * 受信任**的目录做一次撤销（GC），避免 ACL 无限累积。
 */

const RELATIVE = join('sandbox', 'sandbox-grants.json')

interface PersistedGrants {
  readonly version: 1
  readonly workspaces: readonly string[]
}

function grantsFile(home: string): string {
  return join(home, RELATIVE)
}

function load(home: string): string[] {
  const file = grantsFile(home)
  if (!existsSync(file)) return []
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedGrants>
    return value.version === 1 && Array.isArray(value.workspaces)
      ? value.workspaces.filter((item): item is string => typeof item === 'string' && item !== '')
      : []
  } catch {
    return []
  }
}

function persist(home: string, workspaces: readonly string[]): void {
  const file = grantsFile(home)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  const next: PersistedGrants = { version: 1, workspaces: [...new Set(workspaces)] }
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** 一次成功的沙箱包装后调用；同一工作区只记一次。 */
export function recordSandboxGrant(home: string, workspace: string): void {
  if (workspace === '') return
  const list = load(home)
  if (list.includes(workspace)) return
  persist(home, [...list, workspace])
}

export interface SandboxGrantGcResult {
  readonly revoked: readonly string[]
  readonly kept: readonly string[]
}

/**
 * 启动 GC：撤销**不再受信任**的工作区 ACL；撤销失败的保留到下次启动重试。
 * 不阻塞启动（调用方负责吞掉异常）。
 */
export async function gcSandboxGrants(input: {
  readonly home: string
  readonly sandbox: SandboxService
  readonly isTrusted: (workspace: string) => boolean
}): Promise<SandboxGrantGcResult> {
  const list = load(input.home)
  const revoked: string[] = []
  const kept: string[] = []
  for (const workspace of list) {
    if (input.isTrusted(workspace)) {
      kept.push(workspace)
      continue
    }
    if (input.sandbox.releaseWorkspace === undefined) {
      kept.push(workspace)
      continue
    }
    try {
      const result = await input.sandbox.releaseWorkspace(workspace)
      if (result.released) revoked.push(workspace)
      else kept.push(workspace)
    } catch {
      kept.push(workspace)
    }
  }
  if (kept.length !== list.length) persist(input.home, kept)
  return { revoked, kept }
}
