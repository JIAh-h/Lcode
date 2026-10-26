import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalWebAllowlist } from './web-allowlist.ts'

let home = ''
afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('LocalWebAllowlist', () => {
  it('按工作区去重、规范化并持久化', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-web-allow-'))
    const service = createLocalWebAllowlist({ home })
    service.add('C:/repo/a', ['Example.com', 'example.com', '*.', ''])
    service.add('C:/repo/a', ['api.example.com'])
    expect(service.listFor('C:/repo/a')).toEqual(['api.example.com', 'example.com'])
    expect(service.listFor('C:/repo/b')).toEqual([])

    const reopened = createLocalWebAllowlist({ home })
    expect(reopened.snapshot()).toEqual([{ workspace: 'C:/repo/a', domains: ['api.example.com', 'example.com'] }])
    expect(JSON.parse(readFileSync(join(home, 'web-allowlist.json'), 'utf8'))).toMatchObject({ version: 1 })
  })

  it('移除单个域名；最后一个移除后清掉该工作区', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-web-allow-'))
    const service = createLocalWebAllowlist({ home })
    service.add('C:/repo/a', ['example.com', 'api.example.com'])
    service.remove('C:/repo/a', 'example.com')
    expect(service.listFor('C:/repo/a')).toEqual(['api.example.com'])
    service.remove('C:/repo/a', 'api.example.com')
    expect(service.snapshot()).toEqual([])
  })

  it('清理整个失效工作区', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-web-allow-'))
    const service = createLocalWebAllowlist({ home })
    service.add('C:/repo/a', ['example.com'])
    service.add('C:/repo/b', ['api.example.com'])
    service.removeWorkspace('C:/repo/a')
    expect(service.snapshot()).toEqual([{ workspace: 'C:/repo/b', domains: ['api.example.com'] }])
    service.removeWorkspace('C:/repo/missing')
    expect(service.snapshot()).toHaveLength(1)
  })

  it('损坏文件按空白名单处理', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-web-allow-'))
    writeFileSync(join(home, 'web-allowlist.json'), '{坏', 'utf8')
    expect(createLocalWebAllowlist({ home }).snapshot()).toEqual([])
  })
})
