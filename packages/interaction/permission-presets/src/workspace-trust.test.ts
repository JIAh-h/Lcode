import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalWorkspaceTrust } from './workspace-trust.ts'

let home = ''

afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('WorkspaceTrustService', () => {
  it('只信任精确目录并持久化，不会把父目录授权给子目录', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-trust-'))
    const service = createLocalWorkspaceTrust({ home, now: () => 123 })
    service.setTrusted('/repo/app', true)

    expect(service.isTrusted('/repo/app')).toBe(true)
    expect(service.isTrusted('/repo/app/packages/child')).toBe(false)
    expect(service.list()).toEqual([{ path: resolve('/repo/app'), trustedAt: 123 }])
    expect(readFileSync(join(home, 'trusted-workspaces.json'), 'utf8')).not.toContain('api_key')

    const reopened = createLocalWorkspaceTrust({ home })
    expect(reopened.isTrusted('/repo/app')).toBe(true)
    reopened.setTrusted('/repo/app', false)
    expect(reopened.list()).toEqual([])
  })
})
