import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxService } from '@lcode/sandbox'
import { gcSandboxGrants, recordSandboxGrant } from './sandbox-grants.ts'

let home = ''
afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

function fakeSandbox(released: boolean): SandboxService & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async status() {
      return {
        available: true,
        mechanism: 'test',
        knownEscapeSurfaces: [],
        degraded: false,
        capabilities: {
          platform: 'win32',
          mechanism: 'test',
          boundaries: {
            filesystem: { state: 'enforced', plannedMechanism: 'test', message: '' },
            network: { state: 'enforced', plannedMechanism: 'test', message: '' },
            spawn: { state: 'enforced', plannedMechanism: 'test', message: '' },
          },
          reason: '',
        },
      }
    },
    async wrap(argv) {
      return { enforced: true, wrappedArgv: [...argv] }
    },
    async releaseWorkspace(workspace) {
      calls.push(workspace)
      return { released }
    },
  }
}

describe('sandbox-grants', () => {
  it('记录去重并持久化', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-grants-'))
    recordSandboxGrant(home, 'C:/repo/a')
    recordSandboxGrant(home, 'C:/repo/a')
    recordSandboxGrant(home, 'C:/repo/b')
    const value = JSON.parse(readFileSync(join(home, 'sandbox', 'sandbox-grants.json'), 'utf8')) as { workspaces: string[] }
    expect(value.workspaces).toEqual(['C:/repo/a', 'C:/repo/b'])
  })

  it('启动 GC 只撤销不受信任的工作区，并从日志移除', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-grants-'))
    recordSandboxGrant(home, 'C:/repo/trusted')
    recordSandboxGrant(home, 'C:/repo/stale')
    const sandbox = fakeSandbox(true)
    const result = await gcSandboxGrants({ home, sandbox, isTrusted: (workspace) => workspace === 'C:/repo/trusted' })
    expect(result.revoked).toEqual(['C:/repo/stale'])
    expect(result.kept).toEqual(['C:/repo/trusted'])
    expect(sandbox.calls).toEqual(['C:/repo/stale'])
    const value = JSON.parse(readFileSync(join(home, 'sandbox', 'sandbox-grants.json'), 'utf8')) as { workspaces: string[] }
    expect(value.workspaces).toEqual(['C:/repo/trusted'])
  })

  it('撤销失败时保留日志，下次启动重试', async () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-grants-'))
    recordSandboxGrant(home, 'C:/repo/stale')
    const result = await gcSandboxGrants({ home, sandbox: fakeSandbox(false), isTrusted: () => false })
    expect(result.revoked).toEqual([])
    expect(result.kept).toEqual(['C:/repo/stale'])
    const file = join(home, 'sandbox', 'sandbox-grants.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).workspaces).toEqual(['C:/repo/stale'])
  })
})
