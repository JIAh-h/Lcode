import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 跨会话的网络出站审计（`~/.lcode/network-audit.jsonl`）。
 *
 * 会话日志里的 `network/request` 仍然保留；这个文件只服务于“设置 → 网络访问”的
 * 全局最近记录，避免为了看一眼谁访问了什么而逐个打开会话。
 */
export interface NetworkAuditEntry {
  readonly at: number
  readonly sessionId: string
  readonly workspace: string
  readonly tool: string
  readonly domain: string
  readonly decision: 'allowed' | 'denied'
  readonly url?: string
  readonly detail?: string
}

export interface NetworkAuditPort {
  append(entry: Omit<NetworkAuditEntry, 'at'> & { readonly at?: number | undefined }): void
}

export interface NetworkAuditService extends NetworkAuditPort {
  list(limit?: number): readonly NetworkAuditEntry[]
  clear(): void
}

const DEFAULT_MAX_BYTES = 1024 * 1024

export function createLocalNetworkAudit(input: { readonly home: string; readonly maxBytes?: number | undefined }): NetworkAuditService {
  const file = join(input.home, 'network-audit.jsonl')
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES

  return {
    append(entry) {
      mkdirSync(dirname(file), { recursive: true })
      rotateIfNeeded(file, maxBytes)
      const record: NetworkAuditEntry = {
        at: entry.at ?? Date.now(),
        sessionId: entry.sessionId,
        workspace: entry.workspace,
        tool: entry.tool,
        domain: entry.domain,
        decision: entry.decision,
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      }
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    },
    list(limit = 50) {
      if (!existsSync(file)) return []
      const cap = Math.min(500, Math.max(1, Math.floor(limit)))
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return []
      }
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      const out: NetworkAuditEntry[] = []
      for (let index = lines.length - 1; index >= 0 && out.length < cap; index -= 1) {
        const entry = parseEntry(lines[index] ?? '')
        if (entry !== undefined) out.push(entry)
      }
      return out
    },
    clear() {
      rmSync(file, { force: true })
    },
  }
}

function rotateIfNeeded(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size <= maxBytes) return
  } catch {
    return
  }
  const rotated = `${file}.1`
  rmSync(rotated, { force: true })
  try {
    renameSync(file, rotated)
  } catch {
    // 轮转失败不能阻断新的审计写入；旧文件会被后续 clear/轮转处理
  }
}

function parseEntry(line: string): NetworkAuditEntry | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    const at = value['at']
    const sessionId = value['sessionId']
    const workspace = value['workspace']
    const tool = value['tool']
    const domain = value['domain']
    const decision = value['decision']
    if (
      typeof at !== 'number' ||
      typeof sessionId !== 'string' ||
      typeof workspace !== 'string' ||
      typeof tool !== 'string' ||
      typeof domain !== 'string' ||
      (decision !== 'allowed' && decision !== 'denied')
    ) return undefined
    return {
      at,
      sessionId,
      workspace,
      tool,
      domain,
      decision,
      ...(typeof value['url'] === 'string' ? { url: value['url'] } : {}),
      ...(typeof value['detail'] === 'string' ? { detail: value['detail'] } : {}),
    }
  } catch {
    return undefined
  }
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    networkAudit: NetworkAuditService
  }
}
