/**
 * electron-builder 配置（Windows NSIS 安装器）。
 *
 * ## 为什么 files 指向 `out/lcode-win32-x64/resources/app`
 *
 * `package-portable.mjs` 已经把那套「Electron 运行时 + 我们的 bundle」收集好了，
 * 其中含三样 electron-builder 默认处理不了的东西：
 *
 * 1. `better-sqlite3` —— 主进程 bundle 对它保持 external，必须随包发布；
 * 2. Electron ABI 的原生模块（`native/electron-130/better_sqlite3.node`）——
 *    不是 npm 常规 install 的产物，靠 `Lcode/native:build` 编出来；
 * 3. `lcode-sandbox-win32.exe` —— 自研沙箱 helper。
 *
 * 让 electron-builder 从零解析这些依赖很容易漏，而且它的默认 asar 打包会破坏
 * 原生模块的加载路径。所以这里**复用 portable 脚本已产出的 app 目录**，
 * electron-builder 只负责：打 asar → 套进 Electron runtime → 生成 NSIS 安装器。
 *
 * ## 与 portable 包的关系
 *
 * 两者共用同一份 staging：`package-portable.mjs` 产出 `out/lcode-win32-x64/`，
 * 本配置再把它封成安装器。所以 `package:setup` 会先跑 portable 那一步。
 */
const { join } = require('node:path')

const repoRoot = join(__dirname, '..', '..')

module.exports = {
  appId: 'dev.lcode.desktop',
  productName: 'Lcode',
  copyright: 'Copyright © Lcode',
  /*
   * **显式指定 Electron 版本**。
   *
   * electron-builder 默认去「项目目录」的 node_modules 里找 electron 来推断版本；
   * 但我们的 app 目录是 portable 脚本产出的 staging（`out/.../resources/app`），
   * 那里没有被 pnpm 提升的 electron 包，于是它报
   * "Cannot compute electron version from installed node modules"。
   * 直接把版本号写死在这里最稳，也和 `package-portable.mjs` 复制的 runtime 一致。
   */
  electronVersion: '33.4.11',

  /*
   * 用绝对路径而不是相对路径：electron-builder 对 `directories.*` 的相对基准
   * 与配置文件所在目录并不一致（实测 `../../out/...` 会被解析到错误位置）。
   */
  directories: {
    // 复用 portable 的产出；electron-builder 会写到这里
    output: join(repoRoot, 'out'),
    // 「应用内容」= portable 脚本收集好的 app 目录
    app: join(repoRoot, 'out', 'lcode-win32-x64', 'resources', 'app'),
  },

  /*
   * 只打包应用内容本身。分发用的 electron runtime 由 electron-builder 自己
   * 从 devDependencies 的 electron 取——那份与 portable 脚本复制的是同一个版本，
   * 所以不用重复带上 staging 里的 runtime 文件。
   */
  files: [
    /*
     * 含 node_modules：staging 里它是 portable 脚本手拷进来的（`better-sqlite3`
     * 与自研原生绑定），electron-builder 的依赖解析看不到它，必须显式带上。
     * 末尾那条规则只是省掉源码映射（soucemap 不进安装包）。
     */
    '**/*',
    '!**/*.map',
  ],
  /*
   * 关掉 electron-builder 的依赖收集：它会在我们的 staging 上找不到包树，
   * 然后**把 node_modules 整个丢掉**（实测：35 个文件、数据库与原生绑定缺失）。
   * 我们已经在 portable 脚本里自己收集好了，不需要它再解析一遍。
   */
  npmRebuild: false,
  buildDependenciesFromSource: false,

  /*
   * 原生模块不能进 asar：Node 的 `process.dlopen` 无法从 asar 内加载 .node 文件。
   * `better-sqlite3` 与我们的 native binding 都要解出来。
   */
  /*
   * **关闭 asar**。
   *
   * 试过 `asar: true` + 显式 `files` 包含 node_modules：electron-builder 仍会把
   * `node_modules` 整个丢掉（它的依赖解析在我们的 staging 上找不到包树），
   * 结果 asar 里只有 35 个文件、`better-sqlite3` 与原生绑定全部缺失——
   * 装完打不开数据库。反复调 `files`/`asarUnpack` 都绕不过它的默认行为。
   *
   * 关掉 asar 后目录结构与 portable 包完全一致，`process.dlopen` 也能直接
   * 加载 `.node`（asar 内的原生模块本来就得 unpack，这里省掉那层间接）。
   * 代价是文件数多一点，但安装器体积差异可以忽略。
   */
  asar: false,

  win: {
    icon: join(repoRoot, 'apps', 'desktop', 'resources', 'app_icon.ico'),
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    /*
     * 显式指定 exe 的元数据，避免沿用 Electron 默认值
     * （rcedit 在 portable 脚本里已经做过一次，这里让 electron-builder 再做一次，
     * 保证两条发布路径的产物一致）。
     */
    legalTrademarks: 'Lcode',
  },

  /*
   * **用 extraResources 兜住 node_modules**。
   *
   * electron-builder 对名为 `node_modules` 的目录有不可绕过的排除：试过
   * `asar:true` + 显式 files、`asar:false`、`npmRebuild:false`，产物里始终只有
   * 35 个文件、`better-sqlite3` 与自研原生绑定全部缺失（装完打不开数据库）。
   *
   * `extraResources` 是它提供的"原样拷贝到 resources/"通道，不受那套排除规则
   * 影响。落地路径与 staging 里完全一致（`resources/app/node_modules`），
   * 所以主进程的模块解析不需要任何改动。
   */
  extraResources: [
    {
      from: join(repoRoot, 'out', 'lcode-win32-x64', 'resources', 'app', 'node_modules'),
      to: 'app/node_modules',
    },
  ],

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Lcode',
    /*
     * 卸载时保留用户数据：`~/.lcode` 里有会话、插件、模型配置，
     * 默认删掉会让用户「卸载再装」丢光历史（那个目录不在安装路径下，
     * 但有些卸载器会顺手清 %USERPROFILE% 下的应用目录，这里明确不删）。
     */
    deleteAppDataOnUninstall: false,
    installerIcon: join(repoRoot, 'apps', 'desktop', 'resources', 'app_icon.ico'),
    uninstallerIcon: join(repoRoot, 'apps', 'desktop', 'resources', 'app_icon.ico'),
  },
}
