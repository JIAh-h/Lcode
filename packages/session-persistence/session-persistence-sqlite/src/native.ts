import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type BetterSqlite3 from 'better-sqlite3'

/**
 * 原生模块加载（docs/24 §7.1 的落地）。
 *
 * **为什么需要这个文件**：`better-sqlite3` 是原生模块，一份 `.node` 二进制只能服务一个
 * ABI。实测（T0.1）：
 * - 系统 Node 22.22.2 → ABI **127**
 * - Electron 33.4.11 主进程（内置 Node 20.18.3）→ ABI **130**
 *
 * 编了 Electron 版，Node 侧立刻 `ERR_DLOPEN_FAILED`；反之亦然。而两端都要能跑
 * （CLI / vitest 在 Node 下，桌面主进程在 Electron 下），所以必须**双份构建**：
 *
 * - Node 侧：`prebuild-install` 装出来的 `build/Release/better_sqlite3.node`，交给
 *   `better-sqlite3` 自己解析（本模块不干预）。
 * - Electron 侧：`@electron/rebuild` 编好后固化到 `native/electron-<ABI>/`，
 *   运行时通过构造参数 `nativeBinding` 显式指定。
 *
 * 生成与刷新见同包 `scripts/build-native.mjs`（`pnpm native:build`）。
 *
 * 注：`better-sqlite3` **v13 不可用**——它把连接放到 worker 线程，在 Electron 33 下
 * `new Database()` 会直接让进程硬崩（无异常可捕）。故锁 v11。升级前请重跑 T0.1 探针。
 */

const require = createRequire(import.meta.url)

/** 本包的包名（`require.resolve` 与 package.json 校验共用一处，避免写错） */
const PACKAGE_NAME = '@lcode/session-persistence-sqlite'

/**
 * 显式指定包根目录（`.node` 二进制就在它的 `native/` 下）。
 *
 * **谁需要调它**：把本包**打包**进自己产物的宿主（桌面主进程的 esbuild bundle）。
 * 那种形态下本模块的代码住在宿主的 `dist/main.js` 里，`import.meta.url` 指向宿主文件，
 * 于是"向上找包根"与"`require.resolve` 找包"**两条路都断**——
 * 二进制明明在 `node_modules/@lcode/session-persistence-sqlite/native/`，
 * 但没有任何一条从宿主出发的路径能猜出它。
 *
 * 与其在打包脚本里写"多向上走 N 层"这种脆弱规则，不如让装配层一次说清。
 */
let packageRootOverride: string | undefined

export function setNativePackageRoot(root: string): void {
  packageRootOverride = root
}

/**
 * 包根目录：`.node` 二进制就放在它的 `native/` 下。
 *
 * 三种形态依次试：
 * 1. **装配层显式指定**（打包形态；见 `setNativePackageRoot`）；
 * 2. `require.resolve`（源码直跑；走 pnpm 的 `node_modules` 链接，与文件位置无关）；
 * 3. 从本文件向上走（兜底）。
 */
function findPackageRoot(): string {
  if (packageRootOverride !== undefined) return packageRootOverride
  // 注意：**不能**用 `require.resolve('<pkg>/package.json')`——本包只导出 `.`，
  // 子路径会被 `ERR_PACKAGE_PATH_NOT_EXPORTED` 挡住（实测）。
  // 只能 resolve 入口，再沿目录向上找带同名 package.json 的那一层。
  try {
    let dir = dirname(require.resolve(PACKAGE_NAME))
    for (let i = 0; i < 6; i++) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
        if (parsed.name === PACKAGE_NAME) return dir
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // 落到"从本文件向上走"的兜底
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }
      if (parsed.name === PACKAGE_NAME) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `native.ts：找不到 ${PACKAGE_NAME} 的包根目录（原生二进制就在它的 native/ 下）。\n` +
      '若本包被**打包**进了宿主产物，请在装配层调用 setNativePackageRoot() 显式指定。',
  )
}

/**
 * 当前运行时应当使用的原生二进制路径。
 *
 * - 在 Electron 下：返回固化的 Electron 版路径；**缺失则返回 undefined 并让调用方报错**
 *   （宁可显式失败，也不要静默回落到 ABI 不匹配的模块——那会变成不可捕捉的崩溃）。
 * - 在 Node 下：返回 undefined，表示交给 `better-sqlite3` 自行解析其 prebuild。
 */
export function nativeBindingPath(): string | undefined {
  if (!process.versions.electron) return undefined
  const abi = process.versions.modules
  return join(findPackageRoot(), 'native', `electron-${abi}`, 'better_sqlite3.node')
}

/** 在 Electron 下缺少对应 ABI 的构建产物时抛出（附修复指引） */
export function assertNativeBindingAvailable(): void {
  if (!process.versions.electron) return
  const path = nativeBindingPath()
  if (path && !existsSync(path)) {
    throw new Error(
      `Electron 运行时的 better-sqlite3 二进制缺失（ABI ${process.versions.modules}）：${path}\n` +
        `请执行：pnpm --filter @lcode/session-persistence-sqlite native:build`,
    )
  }
}

/** better-sqlite3 模块本体（CJS 包，需 createRequire） */
export function loadBetterSqlite3(): typeof BetterSqlite3 {
  return require('better-sqlite3') as typeof BetterSqlite3
}

/**
 * 打开数据库。**产品代码一律走这里**，不要直接 `new Database()`——
 * 那样在 Electron 下会因 ABI 不匹配而崩。
 */
export function openDatabase(
  filename: string,
  options?: Omit<BetterSqlite3.Options, 'nativeBinding'>,
): BetterSqlite3.Database {
  const Database = loadBetterSqlite3()
  const binding = nativeBindingPath()
  return binding ? new Database(filename, { ...options, nativeBinding: binding }) : new Database(filename, options)
}
