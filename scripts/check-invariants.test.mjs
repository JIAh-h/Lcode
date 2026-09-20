// T7.1：验证 I6 门禁确实能把故意违规打红，同时忽略注释和字符串。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'lcode-invariants-'))
const sourceDir = join(root, 'packages', 'core', 'agent-loop', 'src')
const consumerDir = join(root, 'packages', 'shell', 'shell-local', 'src')
const providerDir = join(root, 'packages', 'subprocess', 'subprocess-local', 'src')
const fsConsumerDir = join(root, 'packages', 'fs', 'tool-fs', 'src')
const fsProviderDir = join(root, 'packages', 'fs', 'fs-local', 'src')
const lspConsumerDir = join(root, 'packages', 'lsp', 'lsp-stdio', 'src')
const script = join(process.cwd(), 'scripts', 'check-invariants.mjs')
mkdirSync(sourceDir, { recursive: true })
mkdirSync(consumerDir, { recursive: true })
mkdirSync(providerDir, { recursive: true })
mkdirSync(fsConsumerDir, { recursive: true })
mkdirSync(fsProviderDir, { recursive: true })
mkdirSync(lspConsumerDir, { recursive: true })

try {
  writeFileSync(join(sourceDir, 'engine.ts'), '// approval\nconst text = "needsApproval"\nexport const ok = true\n')
  execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' })

  writeFileSync(join(sourceDir, 'engine.ts'), 'export const needsApproval = true\n')
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, '--root', root], {
        stdio: 'pipe',
      }),
    (error) => error?.status === 1 && String(error.stderr).includes('needsApproval'),
  )

  writeFileSync(join(sourceDir, 'engine.ts'), 'export function hasBudget(tokens: number) { return tokens > 100 }\n')
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, '--root', root], {
        stdio: 'pipe',
      }),
    (error) => error?.status === 1 && String(error.stderr).includes('tokens'),
  )

  // P5-00：Provider 可以使用原生进程 API，消费者不可以直接绕过它。
  writeFileSync(join(sourceDir, 'engine.ts'), 'export const ok = true\n')
  writeFileSync(join(providerDir, 'provider.ts'), "import { spawn } from 'node:child_process'\nvoid spawn\n")
  execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' })

  writeFileSync(join(consumerDir, 'bypass.ts'), "import { spawn } from 'node:child_process'\nvoid spawn\n")
  assert.throws(
    () => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }),
    (error) => error?.status === 1 && String(error.stderr).includes('消费者直接导入原生执行 API'),
  )

  writeFileSync(join(consumerDir, 'bypass.ts'), 'export const clean = true\n')
  writeFileSync(join(fsProviderDir, 'provider.ts'), "import { readFileSync } from 'node:fs'\nvoid readFileSync\n")
  execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' })

  writeFileSync(join(fsConsumerDir, 'bypass.ts'), "import { readFileSync } from 'node:fs'\nvoid readFileSync\n")
  assert.throws(
    () => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }),
    (error) => error?.status === 1 && String(error.stderr).includes('消费者直接导入原生执行 API'),
  )

  writeFileSync(join(fsConsumerDir, 'bypass.ts'), 'export const clean = true\n')
  writeFileSync(join(lspConsumerDir, 'bypass.ts'), "import { spawn } from 'node:child_process'\nvoid spawn\n")
  assert.throws(
    () => execFileSync(process.execPath, [script, '--root', root], { stdio: 'pipe' }),
    (error) => error?.status === 1 && String(error.stderr).includes('lsp/lsp-stdio'),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('✓ I6 故意违规探针通过（违规变更会使门禁返回非零）')
