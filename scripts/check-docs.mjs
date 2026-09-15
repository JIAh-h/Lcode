import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { resolvePython } from './lib/python.mjs'

/**
 * `pnpm check:docs` —— 文档集校验（文档 23 §8.1 门禁表第七项）。
 *
 * 包一层而不是直接 `python docs/tools/check.py`，原因是解释器名跨平台不同
 * （见 `./lib/python.mjs`）。这里只负责找到解释器、转发参数、透传退出码；
 * 真正的校验规则仍在 `docs/tools/check.py` 里，不在本文件里重复。
 *
 * 用法：`pnpm check:docs [--verbose ...]`（其余参数原样转发给 check.py）
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'docs', 'tools', 'check.py')

const python = resolvePython()
if (python === null) {
  console.error(
    '✗ 未找到可用的 Python 3 解释器（已尝试 python3 / python / py -3）。\n' +
      '  安装 Python 3 后重试，或用 LCODE_PYTHON 显式指定解释器路径。',
  )
  process.exit(1)
}

const result = spawnSync(python.command, [...python.args, SCRIPT, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
