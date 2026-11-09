import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 开发态启动 Electron（`pnpm dev:desktop` 的最后一步）。
 *
 * ## 为什么需要这个包装（一个真实踩过的坑）
 *
 * 主进程按 `process.env.VITE_DEV_SERVER_URL` 决定加载 **vite dev server** 还是
 * **`dist/renderer/index.html`**（见 `electron/main.ts`）。而原来的 dev 脚本是
 * `wait-on … && electron .`——**没有任何东西设那个变量**。后果是：
 *
 * > vite 起来了、HMR 也在转，但窗口加载的是上一次 `build:renderer` 的`dist` 产物。
 * > 改渲染层代码「看起来没生效」，实际上是在看旧构建。
 *
 * 这类"两个东西都正常、就是没接上"的问题，症状是"我明明改了"——所以宁可多一个
 * 明确的启动器，也不要依赖 shell 的环境变量前缀（`VAR=x cmd` 在 Windows 的 cmd 里
 * 不成立，而这里三平台都要能跑）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const require = createRequire(import.meta.url)

/** 取 electron 的可执行文件路径（用包自己的导出，不猜 node_modules 布局） */
const electronPath = require('electron')

/*
 * GPU 兜底：默认**开启**，需要**两个**开关。
 *
 * ## 实测结论（逐一验证，不要凭直觉增减）
 *
 * 这台机器（NVIDIA GTX 1650 + Intel UHD，驱动 2022/2023 年）上：
 *
 * | 组合 | 结果 |
 * | --- | --- |
 * | 默认（无开关） | GPU 进程崩溃 ×6 → `FATAL: GPU process isn't usable` |
 * | `--disable-gpu` | ❌ 仍然崩溃 |
 * | `--disable-gpu --use-gl=swiftshader` | ❌ 渲染进程崩溃 |
 * | **`--no-sandbox --disable-gpu`** | ✅ **渲染成功** |
 *
 * 关键点是 `--no-sandbox`：没有它，`--disable-gpu` 单独用不起作用——
 * Chromium 的沙箱在拉起 GPU 子进程时先崩，后面就再没有机会走到软件渲染。
 *
 * 想恢复硬件加速（更新驱动后）：`LCODE_HARDWARE_GL=1 pnpm dev:desktop`
 */
const SOFTWARE_GL_FLAGS = ['--no-sandbox', '--disable-gpu']

/** 默认软件渲染；只有显式要硬件加速才不加 */
function wantsSoftwareGl() {
  return process.env.LCODE_HARDWARE_GL !== '1'
}

/*
 * 排查渲染层白屏用的调试端口。
 *
 * 渲染进程的 console 错误**不会**出现在主进程 stdout 里——主进程日志干净、
 * 窗口一片白，是这类问题最典型的症状。开这个端口后可以用 CDP 直接读
 * `Runtime.consoleAPICalled` 与 `Runtime.exceptionThrown`。
 *
 * 只在显式设了 `LCODE_DEBUG_PORT` 时开，不默认暴露调试入口。
 */
const debugPort = process.env.LCODE_DEBUG_PORT
const DEBUG_FLAGS = debugPort === undefined || debugPort === '' ? [] : [`--remote-debugging-port=${debugPort}`]

const child = spawn(electronPath, [desktopRoot, ...(wantsSoftwareGl() ? SOFTWARE_GL_FLAGS : []), ...DEBUG_FLAGS], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // 这两个都设上：主进程只认它们中的一个，而设两个能让"为什么没走 dev server"消失
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173',
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    // 这个变量会让 Electron 以纯 Node 模式运行（`electron.app` 变成 undefined），
    // 某些工具链会把它留在环境里，启动前必须清掉。
    ELECTRON_RUN_AS_NODE: undefined,
    // （DevTools 默认不自动弹；运行中按 F12 或 Ctrl+Shift+I 开关。
    //  想让它在启动时就打开：LCODE_DEVTOOLS=1 pnpm dev:desktop）
  },
})

child.on('close', (code) => {
  process.exit(code ?? 0)
})
