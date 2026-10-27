import { build, context } from 'esbuild'
import { copyFile, cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把 Electron **主进程与预加载脚本**各打成一个自包含的 CJS 文件。
 *
 * ## 为什么主进程必须打包
 *
 * 主进程是 **CJS**，而仓库里**所有 `@lcode/*` 包只导出 TS 源码**（`exports` 指向
 * `src/index.ts`，见 PROJECT-SKELETON §3 记的那条偏差："发布链搭建时切回 lib/"）。
 * 于是 `tsc` 把 `import '@lcode/model-api'` 编译成 `require('@lcode/model-api')`，
 * 运行期 Node 去解析那个包的 main 字段——拿到 `.ts` 文件，直接 `SyntaxError`。
 *
 * 三种出路里选了这个：
 *
 * | 出路 | 代价 |
 * |---|---|
 * | 给每个包加构建产物（`lib/`） | 全仓 85 个包都要改 exports + 加构建步骤；且与"源码即产物"的现状冲突 |
 * | 主进程改用 tsx/ESM | Electron 33 的 ESM 主进程加载器有兼容问题（见 tsconfig.electron.json 注释） |
 * | **esbuild 打包（本脚本）** | 只影响这两个产物；`@lcode/*` 的 TS 源码被内联，**不需要任何包改 exports** |
 *
 * preload 其实没有 `@lcode/*` 依赖（它只用 `electron` 的 `contextBridge`），
 * 但一并交给 esbuild 是为了让"主进程侧产物"只有一条构建路径——避免出现
 * "一半是 tsc 出的、一半是 esbuild 出的"，那种不一致排查起来很费劲。
 * 代价：`tsc` 对 `electron/` 改为**只做类型检查**（`noEmit`）。
 *
 * ## 纪律
 *
 * - **`electron` 是 external**：由 Electron 运行时提供，打进来会坏。
 * - **原生模块是 external**：`better-sqlite3` 的 `.node` 必须由运行期按 ABI 选
 *   （见 `session-persistence-sqlite/src/native.ts`），静态内联只会拿到错误 ABI 的那份。
 * - **两个产物的配置必须分开**：见 `MAIN_ONLY` 的注释（一个实测踩过的坑）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')

/** 必须留给运行期的依赖（不打进来） */
const EXTERNAL = ['electron', 'better-sqlite3']

/**
 * 把 external 的原生模块重定向到**应用自己的** `node_modules`。
 *
 * 为什么必须这么做：产物在 `apps/desktop/dist/main.js`，而 `@lcode/*` 的源码被内联了
 * ——也就是内联进来的 `require('better-sqlite3')` 会从 **`dist/`** 出发解析，
 * 而 pnpm 严格隔离下它只是 `@lcode/session-persistence-sqlite` 的依赖，
 * 从应用目录看不到（实测报 `Cannot find module 'better-sqlite3'`）。
 *
 * 修法：让主进程**自己声明**这个依赖（见 apps/desktop/package.json），
 * 再用解析插件把它钉到应用根目录下——走 Node 的模块解析规则，
 * 与产物被放在哪一层无关（比"多向上走几层"稳）。
 */
const RESOLVE_FROM_APP = {
  name: 'resolve-external-from-app',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      path: join(desktopRoot, 'node_modules', 'better-sqlite3'),
      external: true,
    }))
  },
}

const SHARED = {
  bundle: true,
  platform: 'node',
  target: 'node20', // Electron 33 内置 Node 20.18.3
  format: 'cjs',
  sourcemap: true,
  external: EXTERNAL,
  logLevel: 'info',
  plugins: [RESOLVE_FROM_APP],
}

/**
 * **只有主进程**需要的额外配置：`import.meta.url` 的 CJS 等价物。
 *
 * ⚠️ **绝不能加给 preload**。preload 在 `sandbox: true` 下运行，那个沙箱里
 * **只允许 `require('electron')`**（以及少数被 polyfill 的内置模块）——
 * banner 里一句 `require("node:url")` 会让整个 preload 抛错、静默不执行，
 * 表现为渲染层 `window.lcode` 是 undefined（UI 上就是"当前环境没有主进程桥"）。
 * **这个坑实测踩过**：两个产物共用一份配置时最容易犯，而且报错信息完全不指向这里。
 *
 * 主进程需要它的原因是：内联进来的 `@lcode/*` 里有 `createRequire(import.meta.url)`
 * （`session-persistence-sqlite/src/native.ts`、`session-persistence-jsonl/src/zstd.ts`），
 * 而 CJS 输出下 `import.meta` 是空的。
 */
const MAIN_ONLY = {
  define: { 'import.meta.url': '__lcodeImportMetaUrl' },
  banner: {
    js: 'var __lcodeImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
}

const TARGETS = [
  {
    entry: join(desktopRoot, 'electron', 'main.ts'),
    out: join(desktopRoot, 'dist', 'main.js'),
    extra: MAIN_ONLY,
  },
  {
    entry: join(desktopRoot, 'electron', 'preload.ts'),
    out: join(desktopRoot, 'dist', 'preload.js'),
    extra: {},
  },
]

const watch = process.argv.includes('--watch')

/**
 * 把 zstd 的 `.wasm` 复制到主进程产物旁边（`dist/`）。
 *
 * **为什么必须复制**：`@bokuweb/zstd-wasm` 的 emscripten 模块按
 * `readFile(resolve(__dirname, './zstd.wasm'))` 找它——而它被 esbuild **内联**进
 * `dist/main.js` 后，`__dirname` 是应用产物目录，不是包目录。不复制就会：
 *
 * ```
 * ENOENT: ... \apps\desktop\dist\zstd.wasm
 * ```
 *
 * 后果比"压缩不可用"严重得多：`createAgentRuntime()` 开头就 `await initZstd()`，
 * 所以**建会话直接失败**（实测踩过）。
 *
 * 也可以选择把 wasm 标成 external 并改路径，但那是给第三方包打补丁；
 * 复制一份 250KB 的文件更稳、也不需要知道它内部怎么解析。
 */
async function copyZstdWasm() {
  const src = fileURLToPath(
    new URL('../../../node_modules/.pnpm/@bokuweb+zstd-wasm@0.0.27/node_modules/@bokuweb/zstd-wasm/dist/common/zstd.wasm', import.meta.url),
  )
  const dest = join(desktopRoot, 'dist', 'zstd.wasm')
  await mkdir(join(desktopRoot, 'dist'), { recursive: true })
  await copyFile(src, dest)
  console.log(`  dist\\zstd.wasm     ${(await stat(dest)).size} B`)
}

/** The plugin runner must remain a standalone ESM file for `node <runner> <entry>`. */
async function copyPluginUtilityRunner() {
  const src = join(desktopRoot, '..', '..', 'packages', 'extension', 'plugin-host', 'src', 'utility-runner.mjs')
  const dest = join(desktopRoot, 'dist', 'utility-runner.mjs')
  await mkdir(join(desktopRoot, 'dist'), { recursive: true })
  await copyFile(src, dest)
  console.log(`  dist\\utility-runner.mjs     ${(await stat(dest)).size} B`)
}

/** 受控 fs worker：主进程读取源码后通过 `--eval` 注入沙箱子进程，避免子进程读应用目录。 */
async function copyFsWorker() {
  const src = join(desktopRoot, '..', '..', 'packages', 'fs', 'fs-sandbox', 'src', 'fs-worker.cjs')
  const dest = join(desktopRoot, 'dist', 'fs-worker.cjs')
  await mkdir(join(desktopRoot, 'dist'), { recursive: true })
  await copyFile(src, dest)
  console.log(`  dist\\fs-worker.cjs     ${(await stat(dest)).size} B`)
}

/**
 * 内置技能随应用分发：主进程会从这里读取并保证 `~/.lcode/skills` 至少有一份。
 * 放到 `dist/` 而不是仓库根，portable 打包复制 dist 时自动带上。
 */
async function copyBuiltinSkills() {
  const src = join(desktopRoot, 'resources', 'skills')
  const dest = join(desktopRoot, 'dist', 'skills')
  await rm(dest, { recursive: true, force: true })
  await cp(src, dest, { recursive: true })
  console.log('  dist\\skills\\        内置技能')
}

/**
 * 应用图标放到 `dist/`：BrowserWindow 的 `icon` 按 `__dirname`（即 dist）解析，
 * portable 打包复制 dist 时一并带走，开发与打包两种形态都找得到。
 */
async function copyAppIcon() {
  const src = join(desktopRoot, 'resources', 'app_icon.ico')
  const dest = join(desktopRoot, 'dist', 'app_icon.ico')
  await mkdir(join(desktopRoot, 'dist'), { recursive: true })
  await copyFile(src, dest)
  console.log(`  dist\\app_icon.ico     ${(await stat(dest)).size} B`)
}

if (watch) {
  await copyZstdWasm()
  await copyPluginUtilityRunner()
  await copyFsWorker()
  await copyBuiltinSkills()
  await copyAppIcon()
  const contexts = await Promise.all(
    TARGETS.map((t) => context({ ...SHARED, ...t.extra, entryPoints: [t.entry], outfile: t.out })),
  )
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[build-main] 监听中（Ctrl+C 退出）')
} else {
  await Promise.all(
    TARGETS.map((t) => build({ ...SHARED, ...t.extra, entryPoints: [t.entry], outfile: t.out })),
  )
  await copyZstdWasm()
  await copyPluginUtilityRunner()
  await copyFsWorker()
  await copyBuiltinSkills()
  await copyAppIcon()
}
