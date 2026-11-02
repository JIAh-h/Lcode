import { describe, expect, it } from 'vitest'
import { discoverAutoLspServers, findExecutable } from './lsp-discovery.ts'

describe('lsp-discovery', () => {
  it('Windows 只接受原生 exe，跳过 npm 的 cmd shim', () => {
    const env = { PATH: 'C:\\tools;C:\\npm', PATHEXT: '.EXE;.CMD' }
    const present = new Set([
      'C:\\tools\\rust-analyzer.EXE',
      'C:\\tools\\pylsp.EXE',
      'C:\\npm\\gopls.CMD',
    ])
    const exists = (path: string): boolean => present.has(path)
    const servers = discoverAutoLspServers({ env, platform: 'win32', exists })
    expect(servers.rust?.command).toBe('C:\\tools\\rust-analyzer.EXE')
    expect(servers.python?.command).toBe('C:\\tools\\pylsp.EXE')
    expect(servers.go).toBeUndefined()
    expect(servers.cpp).toBeUndefined()
  })

  it('POSIX 使用冒号分隔 PATH，并按候选顺序选择 Python 服务器', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' }
    const present = new Set(['/usr/local/bin/pyright-langserver', '/usr/bin/clangd'])
    const servers = discoverAutoLspServers({
      env,
      platform: 'linux',
      exists: (path) => present.has(path),
    })
    expect(servers.python).toMatchObject({ command: '/usr/local/bin/pyright-langserver', args: ['--stdio'] })
    expect(servers.c?.command).toBe('/usr/bin/clangd')
    expect(servers.cpp?.command).toBe('/usr/bin/clangd')
  })

  it('绝对路径直接检查存在性', () => {
    expect(findExecutable('/opt/bin/gopls', { platform: 'linux', exists: () => true })).toBe('/opt/bin/gopls')
    expect(findExecutable('/opt/bin/gopls', { platform: 'linux', exists: () => false })).toBeUndefined()
  })
})