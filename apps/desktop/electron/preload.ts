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
  /** 选择单个 SKILL.md */
  chooseSkillMarkdown: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:choose-skill-markdown', title),
  /** 选择技能 zip */
  chooseSkillArchive: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:choose-skill-archive', title),
  /** 导入会话：只选 JSONL，单选（P8-01） */
  chooseSessionFile: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:choose-session-file', title),
  /** 请求关闭窗口（走主进程的关闭确认；window.close() 会绕过确认） */
  requestClose: (): Promise<void> => ipcRenderer.invoke('app:request-close'),
  /** 主进程请求渲染层展示关闭确认 */
  onCloseRequest: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('lcode:app.close-request', listener)
    return () => {
      ipcRenderer.off('lcode:app.close-request', listener)
    }
  },
  answerClose: (input: { decision: 'cancel' | 'minimize' | 'quit'; remember: boolean }): Promise<void> =>
    ipcRenderer.invoke('app:close-answer', input),
  /** 已展示自绘确认框（主进程据此不再回落原生对话框） */
  ackClose: (): Promise<void> => ipcRenderer.invoke('app:close-ack'),
  /** 用系统浏览器打开链接（仅 http/https） */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
  /** 侧栏本地视图状态（置顶 / 归档 / 折叠） */
  getSidebar: (): Promise<unknown> => ipcRenderer.invoke('app:get-sidebar'),
  setSidebar: (input: unknown): Promise<unknown> => ipcRenderer.invoke('app:set-sidebar', input),
  /** 拖拽文件 → 本地绝对路径（Electron 32+ 移除了 File.path，用 webUtils 解析） */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 拖入路径的文件类型（文件/文件夹）；拿不到返回 null */
  pathKind: (path: string): Promise<{ kind: 'file' | 'folder' | null }> =>
    ipcRenderer.invoke('lcode:path.kind', { path }),

  // ─── 模型配置（21 §2.7 `model.*`；批次④）───
  //
  // 每个方法都是**薄转发**：主进程侧才是权威（文档 20「main 持状态、renderer 只渲染」）。
  // 这里不放任何业务判断——渲染进程是不可信的（21 §1.1 边界②），校验必须在主进程做。
  model: {
    /** 已配置的供应商与自定义模型清单（**不含凭据值**，只有引用名） */
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:model.list'),
    /** 保存一份自定义模型（含 API Key；值由主进程写进凭据存储，不进 settings） */
    save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.save', input),
    /** 供应商对单个模型给出的资源上限（拿不到返回空对象） */
    limits: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.limits', input),
    /** 用未保存的 URL/Key 探测可用模型（测试连接） */
    discover: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.discover', input),
    /** 用未保存的 URL/Key 查单个模型的窗口上限（下拉选中后用） */
    limitsUnsaved: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.limitsUnsaved', input),
    remove: (name: string): Promise<unknown> => ipcRenderer.invoke('lcode:model.remove', name),
    /** 连通性自检（"测试连接"）。**永不抛错**，返回六类归因之一 */
    probe: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.probe', input),
    setDefault: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:model.setDefault', input),
    getDefault: (): Promise<unknown> => ipcRenderer.invoke('lcode:model.getDefault'),
    /** 某个凭据引用有没有值（**只回布尔**，值不进渲染进程） */
    hasCredential: (ref: string): Promise<boolean> => ipcRenderer.invoke('lcode:model.hasCredential', ref),
  },

  /** 内容寻址附件：图片缩略图按需读取，避免把 base64 一次性全塞进渲染层 */
  attachments: {
    read: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:attachments.read', input),
  },

  /** 本地技能目录与管理（用户 ~/.lcode/skills 可写，工作区 .lcode/skills 只读） */
  skills: {
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:skills.list'),
    import: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:skills.import', input),
    remove: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:skills.remove', input),
  },

  // ─── 对话（T5.3；21 §2.2/§2.13）───
  session: {
    list: (input?: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.list', input),
    create: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.create', input),
    /** 打开会话：返回 meta + 已有历史，并开始推送它之后的事件 */
    open: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:session.open', sessionId),
    delete: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.delete', input),
    restore: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.restore', input),
    rename: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.rename', input),
    purge: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.purge', input),
    trash: (): Promise<unknown> => ipcRenderer.invoke('lcode:session.trash'),
    emptyTrash: (): Promise<unknown> => ipcRenderer.invoke('lcode:session.emptyTrash'),
    export: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.export', input),
    import: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.import', input),
    fork: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.fork', input),
    /** 回放时的精确请求快照；主进程只接受 session id 与事件序号。 */
    history: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.history', input),
    /** 大事件 payload 按需读取，避免随打开会话一次性传给渲染进程。 */
    body: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:event.body', input),
    /** 某次工具调用的权限、审批与沙箱证据。 */
    why: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:trace.why', input),
    /** 已闭合轮的只读检查点。 */
    checkpoints: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.checkpoints', input),
    fileCheckpoints: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.fileCheckpoints', input),
    restoreCheckpoint: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.checkpoint.restore', input),
    /** 编辑后重发：回退文件与日志到该提问之前，再把它重新发出去 */
    rewindSend: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.rewindSend', input),
    /** 重试最后一轮（仅限没有执行过工具的回合），清掉失败回答后原样重发 */
    retryTurn: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.retryTurn', input),
    /** 输入框状态栏：当前会话的上下文占用估算 */
    contextUsage: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:session.contextUsage', sessionId),
    /** 手动压缩较早历史（当前默认模型生成摘要） */
    compact: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:session.compact', sessionId),
    /** 压缩预览：生成摘要但不改日志 */
    compactPreview: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.compactPreview', input),
    compactApply: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.compactApply', input),
    compactUndo: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.compactUndo', input),
    /** 固定/屏蔽某一轮 */
    marker: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:session.marker', input),
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
    /** 任何窗口完成创建、删除、恢复或分叉后，刷新侧栏会话树。 */
    onChanged: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('lcode:session.changed', listener)
      return () => ipcRenderer.removeListener('lcode:session.changed', listener)
    },
  },
  agent: {
    send: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.send', input),
    steer: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.steer', input),
    queue: {
      list: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.queue.list', input),
      edit: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.queue.edit', input),
      remove: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.queue.remove', input),
      clear: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.queue.clear', input),
      guide: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agent.queue.guide', input),
    },
    cancel: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:agent.cancel', sessionId),
    resume: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('lcode:agent.resume', sessionId),
  },
  plan: {
    enter: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plan.enter', input),
    confirm: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plan.confirm', input),
    /** 退出只读探索（未提交计划时也能退出，避免被锁在计划模式里） */
    cancel: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plan.cancel', input),
  },
  workspaceTrust: {
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:workspace-trust.list'),
    set: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:workspace-trust.set', input),
  },
  /** 输入框状态栏 / 右侧变更面板：工作区 Git 信息、状态与分支切换 */
  workspace: {
    gitInfo: (path: string): Promise<unknown> => ipcRenderer.invoke('lcode:workspace.gitInfo', path),
    gitStatus: (path: string): Promise<unknown> => ipcRenderer.invoke('lcode:workspace.gitStatus', path),
    gitBranches: (path: string): Promise<unknown> => ipcRenderer.invoke('lcode:workspace.gitBranches', path),
    gitSwitch: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:workspace.gitSwitch', input),
    gitDiff: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:workspace.gitDiff', input),
  },
  permissions: {
    get: (): Promise<unknown> => ipcRenderer.invoke('lcode:permissions.get'),
    set: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:permissions.set', input),
  },
  /** Agent 预设：全局默认模式（标准 / 创造占位），与权限档位正交 */
  agentPreset: {
    get: (): Promise<unknown> => ipcRenderer.invoke('lcode:agentPreset.get'),
    set: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:agentPreset.set', input),
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:agentPreset.list'),
  },
  /** web 工具按工作区记住的域名白名单 */
  webAllowlist: {
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:webAllowlist.list'),
    remove: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:webAllowlist.remove', input),
    prune: (): Promise<unknown> => ipcRenderer.invoke('lcode:webAllowlist.prune'),
  },
  /** 跨会话网络请求审计（只读记录 + 清空） */
  networkAudit: {
    list: (input?: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:networkAudit.list', input),
    clear: (): Promise<unknown> => ipcRenderer.invoke('lcode:networkAudit.clear'),
  },
  /** 网页搜索（Tavily）；Key 只进主进程凭据存储，状态接口只回布尔/来源 */
  webSearch: {
    status: (): Promise<unknown> => ipcRenderer.invoke('lcode:webSearch.status'),
    save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:webSearch.save', input),
    remove: (): Promise<unknown> => ipcRenderer.invoke('lcode:webSearch.remove'),
    test: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:webSearch.test', input),
  },
  plugins: {
    list: (): Promise<unknown> => ipcRenderer.invoke('lcode:plugins.list'),
    inspect: (): Promise<unknown> => ipcRenderer.invoke('lcode:plugins.inspect'),
    install: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plugins.install', input),
    activate: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plugins.activate', input),
    deactivate: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plugins.deactivate', input),
    uninstall: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:plugins.uninstall', input),
  },
  runtime: {
    composition: (): Promise<unknown> => ipcRenderer.invoke('lcode:runtime.composition'),
    /** 内置插件总览（只读）：会话/全局、按模式的配置与运行状态 */
    builtinPlugins: (): Promise<unknown> => ipcRenderer.invoke('lcode:runtime.builtinPlugins'),
  },
  /** 系统沙箱状态（设置页只读展示） */
  sandbox: {
    status: (): Promise<unknown> => ipcRenderer.invoke('lcode:sandbox.status'),
  },
  tasks: {
    list: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:tasks.list', input),
    readJob: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:tasks.job.read', input),
    killJob: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:tasks.job.kill', input),
    readTerminal: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:tasks.terminal.read', input),
    closeTerminal: (input: unknown): Promise<unknown> => ipcRenderer.invoke('lcode:tasks.terminal.close', input),
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
    /** 当前还挂着的问题（窗口刷新后据此恢复弹窗，返回完整请求而非只有 callId） */
    pending: (): Promise<unknown> => ipcRenderer.invoke('lcode:approval.pending'),
  },
} as const

export type LcodeBridge = typeof api

contextBridge.exposeInMainWorld('lcode', api)
