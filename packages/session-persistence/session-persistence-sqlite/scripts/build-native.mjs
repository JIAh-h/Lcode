/**
 * 产出 Electron 运行时所需的 better-sqlite3 二进制（docs/24 §7.1 / T0.1）。
 *
 * 用法：pnpm --filter @lcode/session-persistence-sqlite native:build
 *
 * 为什么需要它：`better-sqlite3` 是原生模块，一份 `.node` 只能服务一个 ABI——
 * 系统 Node 22 是 ABI 127，Electron 33 内置 Node 20 是 ABI 130。两端都要能跑
 * （CLI / vitest 在 Node 下，桌面主进程在 Electron 下），所以必须双份构建。
 *
 * 步骤：
 * 1. 备份当前的 Node 版二进制到 `native/node-<ABI>/`（首次运行时它由 prebuild-install 装出来）；
 * 2. 用 `@electron/rebuild` 按 `apps/desktop` 锁定的 Electron 版本编译；
 * 3. 把编译产物固化到 `native/electron-<ABI>/`；
 * 4. **把 Node 版还原回 build/Release/**——不还原的话 CLI 与 vitest 全部 ERR_DLOPEN_FAILED。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgDir, '../../..')

const say = (s) => process.stdout.write(s + '\n')

/** Electron 版本以 apps/desktop 的依赖为准，避免两处各写一个版本号 */
function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8'))
  const raw = (pkg.devDependencies ?? {}).electron ?? (pkg.dependencies ?? {}).electron
  if (!raw) throw new Error('apps/desktop/package.json 里没有 electron 依赖')
  return raw.replace(/^[^\d]*/, '')
}

const modDir = dirname(dirname(require.resolve('better-sqlite3')))
const builtPath = join(modDir, 'build', 'Release', 'better_sqlite3.node')
const nodeAbi = process.versions.modules
const version = electronVersion()

say(`better-sqlite3 : ${modDir.replace(/\\/g, '/')}`)
say(`Electron 版本   : ${version}（取自 apps/desktop）`)
say(`当前 Node ABI   : ${nodeAbi}`)

// 1) 备份 Node 版
if (!existsSync(builtPath)) {
  throw new Error(
    `未找到 Node 版二进制：${builtPath}\n` +
      `请先在仓库根执行 pnpm install（better-sqlite3 已列入 pnpm-workspace.yaml 的 onlyBuiltDependencies）。`,
  )
}
const nodeStashDir = join(pkgDir, 'native', `node-${nodeAbi}`)
mkdirSync(nodeStashDir, { recursive: true })
const nodeStash = join(nodeStashDir, 'better_sqlite3.node')
copyFileSync(builtPath, nodeStash)
say(`✔ 已备份 Node 版 → native/node-${nodeAbi}/better_sqlite3.node`)

// 2) 为 Electron 编译
const rebuildCli = join(repoRoot, 'node_modules/@electron/rebuild/lib/cli.js')
if (!existsSync(rebuildCli)) throw new Error('缺少 @electron/rebuild，请先在仓库根执行 pnpm install')
say('→ 正在为 Electron 编译（需要 MSVC + Windows SDK）…')
execFileSync(process.execPath, [rebuildCli, '-v', version, '-m', pkgDir, '-o', 'better-sqlite3', '--force'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/' },
})

// 3) 固化 Electron 版。目标目录名用「编译目标的 ABI」，即 Electron 内置 Node 的 ABI。
//    @electron/rebuild 会把它写进 build/Release/，我们把它挪到独立目录后再还原 Node 版。
const electronAbi = readElectronAbi()
if (!existsSync(builtPath)) throw new Error(`编译产物不存在：${builtPath}`)
const electronStashDir = join(pkgDir, 'native', `electron-${electronAbi}`)
mkdirSync(electronStashDir, { recursive: true })
copyFileSync(builtPath, join(electronStashDir, 'better_sqlite3.node'))
say(`✔ 已固化 Electron 版 → native/electron-${electronAbi}/better_sqlite3.node`)

// 4) 还原 Node 版
copyFileSync(nodeStash, builtPath)
say(`✔ 已还原 Node 版 → build/Release/better_sqlite3.node`)

say('')
say('两端验证：')
say('  node   packages/session-persistence/session-persistence-sqlite/scripts/probe-sqlite.mjs')
say('  ELECTRON_RUN_AS_NODE=1 <electron.exe> packages/session-persistence/session-persistence-sqlite/scripts/probe-sqlite.mjs')

/** 读 Electron 内置的 Node ABI：让 electron 以 run-as-node 模式报出自己的 modules 号 */
function readElectronAbi() {
  const electronExe = join(repoRoot, 'apps/desktop/node_modules/electron/dist/electron.exe')
  if (!existsSync(electronExe)) {
    say('⚠ 未找到 electron.exe，无法自动读取 Electron ABI；回落到当前 Node ABI，目录名可能不准')
    return nodeAbi
  }
  try {
    const out = execFileSync(electronExe, ['-e', 'process.stdout.write(process.versions.modules)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
      .toString()
      .trim()
    return /^\d+$/.test(out) ? out : nodeAbi
  } catch {
    say('⚠ 读取 Electron ABI 失败；回落到当前 Node ABI')
    return nodeAbi
  }
}
