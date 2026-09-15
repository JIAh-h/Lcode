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
  /** 界面语言：读取已落盘的偏好（首次启动为 null） */
  getLocale: (): Promise<string | null> => ipcRenderer.invoke('app:get-locale'),
  /** 界面语言：写入偏好（主进程落盘） */
  setLocale: (locale: string): Promise<void> => ipcRenderer.invoke('app:set-locale', locale),
  /** 系统文件夹选择框；取消返回 null。`title` 由渲染进程按当前语言传入 */
  chooseFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:choose-folder', title),
  /** 系统文件选择框（附件）；取消返回 null */
  chooseFile: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:choose-file', title),
  /** 拖拽文件 → 本地绝对路径（Electron 32+ 移除了 File.path，用 webUtils 解析） */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ─── 模型配置（21 §2.7 `model.*`；批次④）───
  //
  // 每个方法都是**薄转发**：主进程侧才是权威（文档 20「main 持状态、renderer 只渲染」）。
  // 这里不放任何业务判断——渲染进程是不可信的（21 §1.1 边界②），校验必须在主进程做。
  model: {
    /** 已配置的供应商与自定义模型清单（**不含凭据值**，只有引用名） */
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:model.list'),
    /** 保存一份自定义模型（含 API Key；值由主进程写进凭据存储，不进 settings） */
    save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.save', input),
    remove: (name: string): Promise<unknown> => ipcRenderer.invoke('lcode:model.remove', name),
    /** 连通性自检（"测试连接"）。**永不抛错**，返回六类归因之一 */
    probe: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.probe', input),
    setDefault: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.setDefault', input),
    getDefault: (): Promise<unknown> => ipcRenderer.invoke('lcode:model.getDefault'),
    /** 某个凭据引用有没有值（**只回布尔**，值不进渲染进程） */
    hasCredential: (ref: string): Promise<boolean> => ipcRenderer.invoke('lcode:model.hasCredential', ref),
  },

  // ─── 对话（T5.3；21 §2.2/§2.13）───
  session: {
    list: (input?: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.list', input),
    create: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.create', input),
    /** 打开会话：返回 meta + 已有历史，并开始推送它之后的事件 */
    open: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:session.open', sessionId),
    /** 订阅结构/表面事件（即时） */
    onEvent: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('lcode:session.event', listener)
      return () => ipcRenderer.removeListener('lcode:session.event', listener)
    },
    /** 订阅流式 chunk（**批量**到达，见主进程的合帧逻辑） */
    onChunks: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('lcode:session.chunks', listener)
      return () => ipcRenderer.removeListener('lcode:session.chunks', listener)
    },
    /**
     * 订阅"这一轮失败了"。
     *
     * 事件流里 `turn/end {reason:'error'}` **不带原因**（那是个纯终态），而失败的那个
     * Promise 在主进程侧被 `enqueue` 的空 settle 吞掉了——渲染层永远看不到它。
     * 所以失败原因走这条单独的通道过来，界面才有东西可显示。
     */
    onTurnFailed: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('lcode:session.turnFailed', listener)
      return () => ipcRenderer.removeListener('lcode:session.turnFailed', listener)
    },
  },
  agent: {
    send: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.send', input),
    cancel: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:agent.cancel', sessionId),
  },
  approval: {
    /**
     * 订阅审批问题（12 §5）。
     *
     * **不订阅 = 没人应答 = fail-closed**（D11）：内核那边会落成 `unavailable`
     * 并拒绝执行。所以这条通道断了不会让危险操作溜过去——这正是不需要
     * "默认放行"来保证可用性的原因。
     */
    onAsked: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('lcode:approval.asked', listener)
      return () => ipcRenderer.removeListener('lcode:approval.asked', listener)
    },
    /** 回答。同一个 callId 只能答一次（二次应答报错——一次审批只管一次） */
    answer: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:approval.answer', input),
    /** 当前还挂着的问题（窗口刷新后据此恢复弹窗） */
    pending: (): Promise<unknown> => ipcRenderer.invoke('lcode:approval.pending'),
  },
} as const

export type LcodeBridge = typeof api

contextBridge.exposeInMainWorld('lcode', api)
