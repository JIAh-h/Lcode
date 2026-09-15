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

const child = spawn(electronPath, [desktopRoot], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // 这两个都设上：主进程只认它们中的一个，而设两个能让"为什么没走 dev server"消失
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173',
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    // （DevTools 默认不自动弹；运行中按 F12 或 Ctrl+Shift+I 开关。
    //  想让它在启动时就打开：LCODE_DEVTOOLS=1 pnpm dev:desktop）
  },
})

child.on('close', (code) => {
  process.exit(code ?? 0)
})
