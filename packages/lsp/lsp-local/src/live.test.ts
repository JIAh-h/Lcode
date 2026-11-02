import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalSubprocess } from '../../../subprocess/subprocess-local/src/index.ts'
import { createLocalLsp } from './index.ts'

const requireFromDesktop = createRequire(join(process.cwd(), 'apps', 'desktop', 'package.json'))

describe('LocalLspService（真实 typescript-language-server）', () => {
  it('对仓库文件返回诊断（可为空数组，但请求必须成功）', async () => {
    const cli = requireFromDesktop.resolve('typescript-language-server/lib/cli.mjs')
    const lsp = createLocalLsp({
      servers: { typescript: { command: process.execPath, args: [cli, '--stdio'] } },
      subprocess: createLocalSubprocess(),
      defaultWorkspace: process.cwd(),
      readFile: (path) => readFileSync(path, 'utf8'),
      initializeTimeoutMs: 60_000,
      diagnosticsTimeoutMs: 30_000,
    })
    try {
      const items = await lsp.query({
        language: 'typescript',
        workspaceRoot: process.cwd(),
        filePath: 'packages/core/tools/src/types.ts',
        kind: 'diagnostics',
      })
      expect(Array.isArray(items)).toBe(true)
      console.log('diagnostics:', JSON.stringify(items).slice(0, 400))
    } finally {
      await lsp.dispose()
    }
  }, 120_000)
})
