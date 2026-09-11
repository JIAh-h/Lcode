import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron'
import { join } from 'node:path'

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'

// 兼容虚拟化/远程环境：禁用硬件加速，避免 GPU 进程崩溃导致整窗退出
app.disableHardwareAcceleration()

// 移除 Electron 默认原生菜单（File/Edit/View/Window/Help）——应用内自绘「文件/编辑/视图/帮助」菜单栏
Menu.setApplicationMenu(null)

/**
 * 主进程（文档 10 §2 / 20 §7.1）。
 * 职责：承载 agent runtime（骨架阶段仅窗口生命周期）+ IPC 桥。
 * 硬性：持状态；不渲染。渲染进程崩溃不得杀死会话（状态在 main）。
 * 注：桌面端走 CJS（Electron 33 / Node 20 的 ESM 主进程加载器有兼容问题），__dirname 直接可用。
 */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Lcode',
    backgroundColor: '#FFFFFF',
    // 隐藏系统标题栏，右上角保留原生最小化/最大化/关闭按钮（Windows overlay）。
    // 应用自绘顶栏（侧栏开关 + 菜单）与窗口控制同行，即 WorkBuddy 式标准桌面排版。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F7F7F8', symbolColor: '#5A5A62', height: 38 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, 'renderer', 'index.html'))
  }
  return win
}

// ── IPC 白名单（骨架：与 preload 通道一一对应；契约见 21 §2.13） ──
ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-theme', () => 'light')
ipcMain.handle('shell:open-settings', () => {
  // TODO(批次⑦)：路由到设置页
  return 'ok'
})
// 选择本地文件夹（首页「选择项目 / 新建项目」）
ipcMain.handle('dialog:choose-folder', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = win
    ? await dialog.showOpenDialog(win, { title: '选择项目文件夹', properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ title: '选择项目文件夹', properties: ['openDirectory'] })
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
})

app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
