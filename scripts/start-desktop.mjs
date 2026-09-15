/**
 * Lcode 桌面应用启动器（开发辅助）。
 * 用法：node scripts/start-desktop.mjs [--dev]
 *  - 默认：加载已构建产物（apps/desktop/dist）
 *  - --dev：走 Vite dev server（需先自行启动 pnpm --filter @lcode/desktop dev）
 *
 * 职责：清理 ELECTRON_RUN_AS_NODE（沙箱环境常见陷阱）、透传 GPU 兼容参数、收集运行日志。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const appDir = join(root, 'apps/desktop')
/** 运行日志统一放 `apps/desktop/log/`（已 gitignore），别散在包根目录 */
const logDir = join(appDir, 'log')
mkdirSync(logDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const args = ['--no-sandbox', '--disable-gpu', '--in-process-gpu', appDir]
const child = spawn(electronExe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

const log = createWriteStream(join(logDir, 'electron-run.log'), { flags: 'a' })
log.write(`\n===== launch ${new Date().toISOString()} pid=${child.pid} =====\n`)
child.stdout.pipe(log)
child.stderr.pipe(log)
child.on('exit', (code) => {
  log.write(`\n[exited code=${code}]\n`)
  process.exitCode = code ?? 0
})
