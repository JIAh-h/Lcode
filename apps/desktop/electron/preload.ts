import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * preload（文档 20 §7.1 硬性）：contextBridge 白名单 API。
 * 只暴露明确的方法，**不暴露 ipcRenderer**。
 * 契约对齐 21 §2.13 UI IPC 通道对照。
 */
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getTheme: (): Promise<'light' | 'dark'> => ipcRenderer.invoke('app:get-theme'),
  openSettings: (): Promise<string> => ipcRenderer.invoke('shell:open-settings'),
  /** 系统文件夹选择框；取消返回 null */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-folder'),
  /** 拖拽文件 → 本地绝对路径（Electron 32+ 移除了 File.path，用 webUtils 解析） */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
} as const

export type LcodeBridge = typeof api

contextBridge.exposeInMainWorld('lcode', api)
