import { app, BrowserWindow, Menu, ipcMain, dialog, session, shell } from "electron";
import type { ImageAttachmentWriter } from "@lcode/lcode-desktop";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  BUILTIN_AGENT_PRESETS,
  SELECTABLE_AGENT_PRESETS,
  buildBuiltinPluginCatalog,
  buildUserContent,
  createAgentRuntime,
  createCodeIndex,
  createDesktopModelFeature,
  discoverAutoLspServers,
  gcSessionAttachments,
  importSkill,
  mergeGitNumstat,
  parseGitNumstatZ,
  parseGitStatusZ,
  putAttachment,
  readAttachment,
  removeUserSkill,
  seedBuiltinSkills,
} from "@lcode/lcode-desktop";
import type { ParsedGitFile } from "@lcode/lcode-desktop";
import type { AgentRuntime, CodeIndexService, DesktopModelFeature, DesktopServices, LspServerDef, McpServerConfig } from "@lcode/lcode-desktop";
import { createApprovalService } from "@lcode/approval";
import { createWebFetcher } from "@lcode/web-fetch";
import {
  createTavilySearchBackend,
  createWebSearcher,
  TAVILY_API_KEY_REF,
  TAVILY_PROVIDER,
} from "@lcode/web-search";
import type { ApprovalChannel, ApprovalRequest } from "@lcode/approval";
import type { ApprovalResult, ContentBlock } from "@lcode/session";

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";

// 兼容虚拟化/远程环境：禁用硬件加速，避免 GPU 进程崩溃导致整窗退出
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

// 移除 Electron 默认原生菜单（File/Edit/View/Window/Help）——应用内自绘「文件/编辑/视图/帮助」菜单栏
Menu.setApplicationMenu(null);

/**
 * 主进程（文档 10 §2 / 20 §7.1）。
 * 职责：承载 agent runtime（骨架阶段仅窗口生命周期）+ IPC 桥。
 * 硬性：持状态；不渲染。渲染进程崩溃不得杀死会话（状态在 main）。
 * 注：桌面端走 CJS（Electron 33 / Node 20 的 ESM 主进程加载器有兼容问题），__dirname 直接可用。
 */
/**
 * 关闭窗口的确认：避免一次误点就结束 Vite 与主进程 watch。
 *
 * `window-close.json` 只在用户勾选「不再询问」后写入；文件不存在 = 每次都问。
 * 与 `locale.json` 同一套路：状态落盘在主进程，渲染层不参与。
 */
type CloseDecision = "minimize" | "quit";

function closePrefFile(): string {
  return join(app.getPath("userData"), "window-close.json");
}

function readCloseDecision(): CloseDecision | null {
  try {
    const parsed = JSON.parse(readFileSync(closePrefFile(), "utf8")) as {
      decision?: unknown;
    };
    return parsed.decision === "minimize" || parsed.decision === "quit"
      ? parsed.decision
      : null;
  } catch {
    // 首次启动、文件损坏都按“每次询问”处理
    return null;
  }
}

function saveCloseDecision(decision: CloseDecision): void {
  try {
    writeFileSync(closePrefFile(), JSON.stringify({ decision }), "utf8");
  } catch (error) {
    console.error("[lcode] 保存关闭偏好失败：", error);
  }
}

/** 原生对话框只能由主进程出字，所以这里按已落盘的语言给文案（主进程仍不持有界面语言状态） */
function closeDialogLabels(): {
  title: string;
  message: string;
  detail: string;
  cancel: string;
  minimize: string;
  quit: string;
  dontAsk: string;
} {
  let locale: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(localeFile(), "utf8")) as {
      locale?: unknown;
    };
    locale = typeof parsed.locale === "string" ? parsed.locale : null;
  } catch {
    locale = null;
  }
  if (locale === "en-US") {
    return {
      title: "Close Lcode",
      message: "Close the Lcode window?",
      detail:
        "Minimizing keeps Vite and the main-process watcher running; quitting stops work in progress.",
      cancel: "Cancel",
      minimize: "Minimize",
      quit: "Quit",
      dontAsk: "Don't ask again",
    };
  }
  return {
    title: "关闭 Lcode",
    message: "要关闭 Lcode 窗口吗？",
    detail:
      "最小化后 Vite 与主进程 watch 会继续运行；退出应用会停止正在进行的工作。",
    cancel: "取消",
    minimize: "最小化",
    quit: "退出应用",
    dontAsk: "不再询问",
  };
}

let quitting = false;
let askingClose = false;
/**
 * 渲染层回答关闭确认的回执。
 * 同一时刻只可能有一个待答的关闭请求；渲染层卡死时走原生对话框兜底。
 */
let closeAnswer: ((decision: "cancel" | CloseDecision, remember: boolean) => void) | null = null;
/** 渲染层已收到请求并展示了自绘弹窗——收到 ack 后就不再计时兜底 */
let closeAcked = false;
let closeFallbackTimer: NodeJS.Timeout | null = null;

function askCloseDecision(win: BrowserWindow): Promise<"cancel" | CloseDecision> {
  return new Promise((resolve) => {
    let settled = false;
    const clearFallback = (): void => {
      if (closeFallbackTimer !== null) {
        clearTimeout(closeFallbackTimer);
        closeFallbackTimer = null;
      }
    };
    const finish = (decision: "cancel" | CloseDecision): void => {
      if (settled) return;
      settled = true;
      clearFallback();
      closeAnswer = null;
      closeAcked = false;
      win.off("unresponsive", onUnresponsive);
      resolve(decision);
    };
    const fallbackToNative = (): void => {
      if (settled) return;
      settled = true;
      clearFallback();
      closeAnswer = null;
      closeAcked = false;
      win.off("unresponsive", onUnresponsive);
      console.warn("[lcode] 渲染层未确认关闭，回落原生对话框");
      void nativeCloseDecision(win).then(resolve);
    };
    const onUnresponsive = (): void => fallbackToNative();
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      void nativeCloseDecision(win).then(resolve);
      return;
    }
    closeAnswer = (decision, remember) => {
      if (remember && decision !== "cancel") saveCloseDecision(decision);
      finish(decision);
    };
    closeAcked = false;
    // 从任务栏关闭时窗口可能是最小化的：先还原，否则弹窗看得见但窗口没了
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.once("unresponsive", onUnresponsive);
    win.webContents.send("lcode:app.close-request");
    // 只有“渲染层压根没接住请求”才兜底；用户犹豫多久都不该再弹原生框
    closeFallbackTimer = setTimeout(() => {
      if (settled || closeAcked) return;
      fallbackToNative();
    }, 3000);
  });
}

/** 兜底：渲染层来不及回答时仍用系统对话框（样式不统一，但保证关得掉） */
async function nativeCloseDecision(
  win: BrowserWindow,
): Promise<"cancel" | CloseDecision> {
  const labels = closeDialogLabels();
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: "question",
    title: labels.title,
    message: labels.message,
    detail: labels.detail,
    buttons: [labels.cancel, labels.minimize, labels.quit],
    defaultId: 1,
    cancelId: 0,
    checkboxLabel: labels.dontAsk,
    checkboxChecked: false,
    noLink: true,
  });
  if (response === 1) {
    if (checkboxChecked) saveCloseDecision("minimize");
    return "minimize";
  }
  if (response === 2) {
    if (checkboxChecked) saveCloseDecision("quit");
    return "quit";
  }
  return "cancel";
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Lcode",
    backgroundColor: "#FFFFFF",
    // 窗口/任务栏图标（构建时复制到 dist，见 build-main.mjs 的 copyAppIcon）
    icon: join(__dirname, "app_icon.ico"),
    // 隐藏系统标题栏，右上角保留原生最小化/最大化/关闭按钮（Windows overlay）。
    // 应用自绘顶栏（侧栏开关 + 菜单）与窗口控制同行，即 WorkBuddy 式标准桌面排版。
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#F7F7F8", symbolColor: "#5A5A62", height: 38 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  /*
   * 渲染层诊断（仅开发态）。
   *
   * 为什么需要：渲染进程的 console 错误**不会**出现在主进程 stdout 里。
   * 症状是「主进程日志干净、窗口一片白」——这类问题靠猜几乎定位不了。
   * 这里把渲染层的异常、加载失败与控制台错误转发到主进程日志。
   *
   * 用 `LCODE_DEVTOOLS=1` 时原本要看 DevTools 才知道的东西，现在直接有输出。
   */
  if (process.env.NODE_ENV === "development" || process.env.VITE_DEV_SERVER_URL) {
    win.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error(`[renderer] 加载失败 ${code} ${description} ${url}`);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[renderer] 渲染进程退出：${details.reason} (exitCode=${details.exitCode})`);
    });
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      // level: 0=verbose 1=info 2=warning 3=error
      if (level < 2) return;
      const tag = level === 3 ? "error" : "warn";
      console.error(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on("did-finish-load", () => {
      void win.webContents
        .executeJavaScript(
          'JSON.stringify({ rootChildren: document.getElementById("root")?.childElementCount ?? -1, bodyLen: document.body.innerHTML.length })',
        )
        .then((state: string) => console.log(`[renderer] 已加载 ${state}`))
        .catch((error: unknown) => console.error("[renderer] 读取 DOM 失败", error));
    });
  }

  /*
   * 关闭按钮的三选一确认（Qoder 式）。
   *
   * 为什么必须拦：dev 下 `concurrently -k` 会在 Electron 退出时连带杀掉
   * Vite 与 build-main --watch，误点一次就要重新 `pnpm dev:desktop`。
   * `before-quit` 里会置 `quitting`，系统关机/托盘退出等真实退出不受影响。
   */
  win.on("close", (event) => {
    const remembered = readCloseDecision();
    if (quitting) return;
    if (askingClose) {
      event.preventDefault();
      return;
    }
    if (remembered === "minimize") {
      event.preventDefault();
      win.minimize();
      return;
    }
    if (remembered === "quit") {
      quitting = true;
      return;
    }
    event.preventDefault();
    askingClose = true;
    void askCloseDecision(win)
      .then((decision) => {
        if (decision === "minimize") win.minimize();
        else if (decision === "quit") {
          quitting = true;
          app.quit();
        }
      })
      .finally(() => {
        askingClose = false;
      });
  });

  if (
    process.env.NODE_ENV === "development" ||
    process.env.VITE_DEV_SERVER_URL
  ) {
    void win.loadURL(DEV_URL);
    /**
     * DevTools **按需打开**，不无条件弹。
     *
     * 原来这里是无条件 `openDevTools({ mode: 'detach' })`——每次 `dev:desktop` 都弹一个
     * 独立的 DevTools 窗口挡在主界面旁边。想调 UI 时手动开就够了，默认弹只是噪声。
     *
     * 设 `LCODE_DEVTOOLS=1` 可恢复"启动即打开"（排查启动期问题时需要它）。
     */
    if (process.env.LCODE_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void win.loadFile(join(__dirname, "renderer", "index.html"));
  }

  /**
   * 手动开 DevTools 的快捷键。
   *
   * **为什么需要显式加**：Electron 自带的 `Ctrl+Shift+I` 来自默认菜单，而这里
   * `Menu.setApplicationMenu(null)` 把菜单去掉了（应用内自绘菜单栏），于是那个内建
   * 快捷键也一并消失。不加的话"按需打开"就没有任何**可操作**的入口。
   *
   * 只在开发态挂：打包后的产物不该给终端用户留一个开 DevTools 的后门。
   * `F12` 一并支持（Windows 上的习惯键位）。
   */
  if (
    process.env.NODE_ENV === "development" ||
    process.env.VITE_DEV_SERVER_URL
  ) {
    win.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      const isToggle =
        input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i");
      if (isToggle) win.webContents.toggleDevTools();
    });
  }
  return win;
}

// ── IPC 白名单（骨架：与 preload 通道一一对应；契约见 21 §2.13） ──
ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("app:get-theme", () => "light");
/*
 * 窗口控制按钮（最小化/最大化/关闭）的配色跟随主题。
 *
 * `titleBarOverlay` 是原生 Windows 绘制，不吃 CSS 变量——应用切深色后
 * 按钮区还是浅色底，非常违和。渲染层每次切主题时调这个通道，
 * 主进程用 `setTitleBarOverlay` 同步（仅 WCO overlay 模式支持）。
 */
const OVERLAY_THEMES = {
  light: { color: "#F7F7F8", symbolColor: "#5A5A62" },
  dark: { color: "#101012", symbolColor: "#a6a6ae" },
} as const;
ipcMain.handle("app:set-overlay-theme", (_event, theme: unknown) => {
  const overlay = theme === "dark" ? OVERLAY_THEMES.dark : OVERLAY_THEMES.light;
  const win = BrowserWindow.getAllWindows()[0];
  try {
    win?.setTitleBarOverlay(overlay);
  } catch (error) {
    // 非 overlay 模式（如 Linux）不支持：主题照切，按钮配色保持原生
    console.warn("[overlay] setTitleBarOverlay 不可用:", error instanceof Error ? error.message : error);
  }
  return "ok";
});
ipcMain.handle("shell:open-settings", () => {
  // TODO(批次⑦)：路由到设置页
  return "ok";
});

/**
 * 界面语言的落盘（`userData/locale.json`）。
 *
 * 为什么放主进程而不是只靠渲染进程的浏览器存储：打包后渲染进程走 `file://`，
 * 而 `file` 不是标准 scheme，Electron 对非标准 scheme 默认禁用 web storage，
 * 因此「设置里选了英文，重启又变回中文」是必然的。主进程写文件则稳定可靠，
 * 也符合文档 20「main 持状态、renderer 只渲染」的分工。
 *
 * 当前只是一个小文件；等设置整体落盘（`packages/settings` 的 SettingsService）
 * 时把这两个 key 并进去即可，渲染层的 `t()` 调用方式不受影响。
 */
function localeFile(): string {
  return join(app.getPath("userData"), "locale.json");
}

function isLocale(v: unknown): v is "zh-CN" | "en-US" {
  return v === "zh-CN" || v === "en-US";
}

ipcMain.handle("app:get-locale", (): string | null => {
  try {
    const parsed = JSON.parse(readFileSync(localeFile(), "utf8")) as {
      locale?: unknown;
    };
    return isLocale(parsed.locale) ? parsed.locale : null;
  } catch {
    // 首次启动没有该文件，属正常
    return null;
  }
});

ipcMain.handle("app:set-locale", (_e: IpcMainInvokeEvent, locale: unknown) => {
  if (!isLocale(locale)) return;
  try {
    writeFileSync(localeFile(), JSON.stringify({ locale }), "utf8");
  } catch {
    // 写失败不影响本次会话内的语言切换
  }
});

/**
 * 侧栏的本地视图状态（置顶 / 归档 / 折叠）。
 * 与 `window-close.json` 同思路：纯 UI 偏好落在主进程，渲染层不碰存储。
 */
interface SidebarStateFile {
  pinnedWorkspaces: string[];
  archivedWorkspaces: string[];
  pinnedSessions: string[];
  collapsedWorkspaces: string[];
}

function sidebarFile(): string {
  return join(app.getPath("userData"), "sidebar.json");
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item !== "",
      ),
    ),
  ].slice(0, 500);
}

function readSidebarState(): SidebarStateFile {
  try {
    const parsed = JSON.parse(readFileSync(sidebarFile(), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      pinnedWorkspaces: readStringList(parsed["pinnedWorkspaces"]),
      archivedWorkspaces: readStringList(parsed["archivedWorkspaces"]),
      pinnedSessions: readStringList(parsed["pinnedSessions"]),
      collapsedWorkspaces: readStringList(parsed["collapsedWorkspaces"]),
    };
  } catch {
    return {
      pinnedWorkspaces: [],
      archivedWorkspaces: [],
      pinnedSessions: [],
      collapsedWorkspaces: [],
    };
  }
}

ipcMain.handle("app:get-sidebar", () => readSidebarState());

ipcMain.handle("app:set-sidebar", (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const state: SidebarStateFile = {
    pinnedWorkspaces: readStringList(record["pinnedWorkspaces"]),
    archivedWorkspaces: readStringList(record["archivedWorkspaces"]),
    pinnedSessions: readStringList(record["pinnedSessions"]),
    collapsedWorkspaces: readStringList(record["collapsedWorkspaces"]),
  };
  writeFileSync(sidebarFile(), JSON.stringify(state), "utf8");
  return state;
});

/**
 * 渲染层请求关闭窗口（应用内菜单「退出」）。
 *
 * 为什么不直接用 `window.close()`：渲染层的 `window.close()` 走 webContents 销毁路径，
 * **不会**触发 `BrowserWindow` 的 `close` 事件，于是绕过上面的关闭确认。
 */
ipcMain.handle("app:request-close", (event: IpcMainInvokeEvent) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

/** 渲染层对关闭确认的回答（`CloseConfirm` 组件） */
ipcMain.handle("app:close-answer", (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const decision = record["decision"];
  if (decision !== "cancel" && decision !== "minimize" && decision !== "quit") {
    throw new Error("decision 必须是 cancel / minimize / quit");
  }
  closeAnswer?.(decision, record["remember"] === true);
});

/** 渲染层已展示自绘确认框：撤销“没接住请求”的原生兜底计时 */
ipcMain.handle("app:close-ack", () => {
  closeAcked = true;
});

/** 用系统浏览器打开 http(s) 链接（模型输出里的链接只放行这两种协议） */
ipcMain.handle("app:open-external", (_e: IpcMainInvokeEvent, url: unknown) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("只允许 http/https 链接");
  }
  void shell.openExternal(url);
});

// 选择本地文件夹（首页「选择项目 / 新建项目」、输入区「＋ → 添加文件夹」）
ipcMain.handle(
  "dialog:choose-folder",
  (_e: IpcMainInvokeEvent, title?: string) =>
    pickPath({
      title: title || "选择项目文件夹",
      properties: ["openDirectory"],
    }),
);
// 选择本地文件（输入区「＋ → 添加文件」，FR-SESSION-004 附件）
ipcMain.handle("dialog:choose-file", (_e: IpcMainInvokeEvent, title?: string) =>
  pickPath({
    title: title || "选择要附加的文件",
    properties: ["openFile", "multiSelections"],
  }),
);
/**
 * 拖入路径是文件还是文件夹。
 *
 * `dataTransfer.files` 里两者都是 File，渲染层拿不到可靠类型；只回 kind，
 * 不回大小/时间等内容，避免把这个通道变成任意文件探测接口。
 */
ipcMain.handle("lcode:path.kind", (_e: IpcMainInvokeEvent, input: unknown) => {
  const path = (input as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || path === "") return { kind: null };
  try {
    const info = statSync(path);
    return { kind: info.isDirectory() ? "folder" : info.isFile() ? "file" : null };
  } catch {
    return { kind: null };
  }
});
// 导入技能：单文件 SKILL.md 或单个技能文件夹的 zip
ipcMain.handle(
  "dialog:choose-skill-markdown",
  (_e: IpcMainInvokeEvent, title?: string) =>
    pickPath({
      title: title || "选择 SKILL.md",
      properties: ["openFile"],
      filters: [{ name: "Skill", extensions: ["md", "markdown"] }],
    }),
);
ipcMain.handle(
  "dialog:choose-skill-archive",
  (_e: IpcMainInvokeEvent, title?: string) =>
    pickPath({
      title: title || "选择技能 zip",
      properties: ["openFile"],
      filters: [{ name: "Skill zip", extensions: ["zip"] }],
    }),
);
// 导入会话（P8-01）：只收导出格式，单选
ipcMain.handle(
  "dialog:choose-session-file",
  (_e: IpcMainInvokeEvent, title?: string) =>
    pickPath({
      title: title || "选择要导入的会话文件",
      properties: ["openFile"],
      filters: [
        { name: "Lcode 会话包", extensions: ["zip"] },
        { name: "JSONL 会话", extensions: ["jsonl"] },
      ],
    }),
);

/**
 * 标题由**渲染进程按当前界面语言传入**（`renderer/i18n`），主进程不做 i18n
 * ——系统选择框的标题只有主进程能设置，而"现在是什么语言"只有渲染进程知道。
 * 未传时用中文兜底（直接调 IPC 的调试场景）。
 */

/** 打开系统选择框；取消或无选中返回 null（契约见 21 §2.13） */
async function pickPath(options: OpenDialogOptions): Promise<string | null> {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const res = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return res.canceled ? null : (res.filePaths[0] ?? null);
}

// ─────────────── 模型配置（批次④；21 §2.7 `model.*` + §2.13 UI 通道） ───────────────

/**
 * 模型装配（集束）。**惰性初始化**：`createDesktopModelFeature()` 要读 settings、
 * 开凭据库，都在 `app.whenReady()` 之后才安全。
 *
 * 启动即把"上次存过的自定义供应商"注册进 `ctx.llm`——否则用户在设置里加的模型
 * 重启后就消失了（"配置没生效"里最难自查的一种）。
 */
let modelFeature: DesktopModelFeature | null = null;
let modelFeatureInit: Promise<DesktopModelFeature> | null = null;

async function models(): Promise<DesktopModelFeature> {
  if (modelFeature !== null) return modelFeature;
  if (modelFeatureInit === null) {
    modelFeatureInit = createDesktopModelFeature();
  }
  modelFeature = await modelFeatureInit;
  return modelFeature;
}

/**
 * 由显示名推导供应商 id（`公司网关` → `custom-<hash 前后缀>`）。
 *
 * 为什么要推导而不是让 UI 传：弹窗里用户填的是"模型名称"（如 `gpt-4o`）与供应商下拉，
 * **没有**"供应商 id"这个概念——那是内部标识。用显示名派生一个可读且唯一的 id，
 * 比让用户在已经够多的输入框里再填一个技术字段要好。
 */
function providerIdOf(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^[a-z]/.test(ascii) && ascii.length > 0)
    return `custom-${ascii.slice(0, 32)}`;
  // 纯中文之类的显示名：用一个稳定的短哈希，保证同一个名字总是同一个 id
  return `custom-${createHash("sha1").update(label).digest("hex").slice(0, 8)}`;
}

/** 保存/删除/探测/默认模型的通道。**全部薄转发**——逻辑在集束与边界层里。 */
ipcMain.handle("lcode:model.list", async () => {
  const feature = await models();
  const custom = await feature.listCustom();
  // 内置供应商（目前只有自定义适配器）与自定义清单一并给出，UI 一个循环渲染
  return { providers: feature.providers(), custom };
});

ipcMain.handle(
  "lcode:model.save",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const parsed = parseSaveInput(input);
    const feature = await models();
    const provider =
      input !== null &&
      typeof input === "object" &&
      typeof (input as { id?: unknown }).id === "string"
        ? (input as { id: string }).id
        : providerIdOf(parsed.label);
    const saved = await feature.saveCustom({
      name: provider,
      label: parsed.label,
      model: parsed.model,
      base_url: parsed.base_url,
      ...(parsed.protocol === undefined ? {} : { protocol: parsed.protocol }),
      ...(parsed.billing_type === undefined ? {} : { billing_type: parsed.billing_type }),
      ...(parsed.provider_preset === undefined ? {} : { provider_preset: parsed.provider_preset }),
      ...(parsed.api_key === "" ? {} : { api_key: parsed.api_key }),
      api_key_ref: refNameFor(provider),
      ...(parsed.context_window_in === undefined ? {} : { context_window_in: parsed.context_window_in }),
      ...(parsed.context_window_max === undefined ? {} : { context_window_max: parsed.context_window_max }),
      ...(parsed.context_window_out === undefined ? {} : { context_window_out: parsed.context_window_out }),
    });
    /*
     * 供应商上限是“尽量拿到”的元数据：`/models/{id}` 与 `/models` 都不是协议强制项。
     * 拿到就缓存进配置（运行时预算与设置页滑块都用它），拿不到就保留用户/旧值。
     * 同时把用户填的窗口夹到上限以内——窗口不能超过供应商给出的输入字段。
     */
    const limits = await feature.api.modelLimits({ provider, model: parsed.model });
    const effectiveMax = limits.contextWindow ?? parsed.context_window_max;
    /*
     * 用户显式设的窗口**不夹到供应商上报值以内**：百炼那类网关报的是部署默认 env
     * （实测 129024）而实际能接受更长输入，夹了就等于把用户手动调大的上限吃掉。
     */
    if (effectiveMax !== parsed.context_window_max) {
      await feature.saveCustom({
        name: provider,
        label: parsed.label,
        model: parsed.model,
        base_url: parsed.base_url,
        ...(parsed.protocol === undefined ? {} : { protocol: parsed.protocol }),
        ...(parsed.billing_type === undefined ? {} : { billing_type: parsed.billing_type }),
        ...(parsed.provider_preset === undefined ? {} : { provider_preset: parsed.provider_preset }),
        api_key_ref: saved.api_key_ref,
        ...(parsed.context_window_in === undefined ? {} : { context_window_in: parsed.context_window_in }),
        ...(effectiveMax === undefined ? {} : { context_window_max: effectiveMax }),
      });
    }
    /*
     * **第一个配好的模型自动成为默认**。
     *
     * 不这么做的话，用户"添加了模型、看着它出现在列表里"，然后回首页发消息却收到
     * 「还没有选择模型。请到「设置 → 模型」里选一个」——而他**刚刚就在那一页**。
     * 实测踩过：报错指向的页面正是他做过配置的页面，于是没人会想到"其实还缺一步选择默认"。
     *
     * 只在**当前没有默认**时才替他选：已经选过的默认不能被一次保存悄悄改掉
     * （用户可能同时配了好几家的模型，正在用的是另一家）。
     */
    const currentDefault = await feature.api.getDefault();
    if (currentDefault === undefined) {
      await feature.api.setDefault({
        selection: { provider, model: parsed.model },
      });
    } else if (currentDefault.provider === provider && currentDefault.model !== parsed.model) {
      // 改的是当前默认供应商的模型 id：默认选择必须立刻跟随，否则界面写 A、请求发 B
      await feature.api.setDefault({
        selection: { provider, model: parsed.model },
      });
    }
    return { ...saved, context_window_max: effectiveMax ?? null };
  },
);

ipcMain.handle(
  "lcode:model.limits",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const provider = record["provider"];
    const model = record["model"];
    if (typeof provider !== "string" || provider === "") return {};
    if (typeof model !== "string" || model === "") return {};
    const feature = await models();
    return await feature.api.modelLimits({ provider, model });
  },
);

ipcMain.handle(
  "lcode:model.discover",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const baseUrl = record["base_url"] ?? record["baseUrl"];
    const apiKey = record["api_key"] ?? record["apiKey"] ?? "";
    const credentialRef = record["credential_ref"];
    if (typeof baseUrl !== "string" || baseUrl.trim() === "")
      throw new Error("base_url 必填");
    if (typeof apiKey !== "string") throw new Error("api_key 必须是字符串");
    const protocol = record["protocol"] === "anthropic" ? "anthropic" : "openai";
    const feature = await models();
    // 未保存的配置只用于探测：不落 settings、不落凭据
    return await feature.discover({
      base_url: baseUrl,
      api_key: apiKey,
      protocol,
      ...(typeof credentialRef === "string" && credentialRef !== "" ? { credential_ref: credentialRef } : {}),
    });
  },
);

ipcMain.handle(
  "lcode:model.limitsUnsaved",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const baseUrl = record["base_url"] ?? record["baseUrl"];
    const model = record["model"];
    const apiKey = record["api_key"] ?? record["apiKey"] ?? "";
    const credentialRef = record["credential_ref"];
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return {};
    if (typeof model !== "string" || model === "") return {};
    if (typeof apiKey !== "string") return {};
    const protocol = record["protocol"] === "anthropic" ? "anthropic" : "openai";
    const feature = await models();
    return await feature.limitsUnsaved({
      base_url: baseUrl,
      model,
      api_key: apiKey,
      protocol,
      ...(typeof credentialRef === "string" && credentialRef !== "" ? { credential_ref: credentialRef } : {}),
    });
  },
);

ipcMain.handle(
  "lcode:model.remove",
  async (_e: IpcMainInvokeEvent, name: unknown) => {
    if (typeof name !== "string" || name === "") throw new Error("name 必填");
    const feature = await models();
    return feature.removeCustom({ name });
  },
);

ipcMain.handle(
  "lcode:model.probe",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const parsed = parseProbeInput(input);
    const feature = await models();
    // probe **永不抛错**，返回六类归因之一（21 §2.7 / 18 §8.2）
    return feature.api.probe(parsed);
  },
);

ipcMain.handle(
  "lcode:model.setDefault",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const parsed = parseSetDefaultInput(input);
    const feature = await models();
    return feature.api.setDefault({
      selection: { provider: parsed.provider, model: parsed.model },
    });
  },
);

/**
 * 某个凭据引用**有没有值**。
 *
 * **只回布尔**：UI 需要区分'已配置/未配置'（编辑时告诉用户留空即不改），
 * 但值本身永远不进渲染进程（I7 / 宪法第二条：值不进 UI）。
 * 这里用同步的  而不是 ——后者会把值读进内存，
 * 而这件事根本不需要值。
 */
ipcMain.handle(
  "lcode:model.hasCredential",
  async (_e: IpcMainInvokeEvent, ref: unknown) => {
    if (typeof ref !== "string" || ref === "") return false;
    const feature = await models();
    return feature.hasCredential(ref);
  },
);

ipcMain.handle("lcode:model.getDefault", async () => {
  const feature = await models();
  return (await feature.api.getDefault()) ?? null;
});

/**
 * 跨会话编排的模型配置（docs/26 §3.2）。
 *
 * 只存 `{ provider, model }`：与默认模型同一套形状，渲染层可以直接用现成的
 * 模型清单渲染下拉。**改完需要重开应用生效**——路由规则在装配时构造。
 */
ipcMain.handle("lcode:orchestration.get", async () => {
  const feature = await models();
  const raw = feature.services.readSetting("orchestration.routerModel");
  const routerModel =
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { provider?: unknown }).provider === "string" &&
    typeof (raw as { model?: unknown }).model === "string"
      ? {
          provider: (raw as { provider: string }).provider,
          model: (raw as { model: string }).model,
        }
      : null;
  return { routerModel, defaultMode: defaultModeOf(feature.services) };
});

/**
 * 新建编排会话时的默认档位（docs/26 §7.4）。
 *
 * **默认 `auto`**：勾选「作为编排调度会话」本身就是人给出的"这次需要拆"的显式信号，
 * 再让用户去别处切一档才肯执行，等于把同一个意图问两遍。
 * 想看它怎么拆而不真执行的人，可以在设置里改成 `observe`。
 */
function defaultModeOf(services: { readonly readSetting: (key: string) => unknown }): "auto" | "observe" {
  return services.readSetting("orchestration.defaultMode") === "observe" ? "observe" : "auto";
}

ipcMain.handle("lcode:orchestration.setDefaultMode", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const mode = record["mode"];
  if (mode !== "auto" && mode !== "observe") throw new Error("mode 必须是 auto 或 observe");
  const feature = await models();
  await feature.services.settings.setByKey("orchestration.defaultMode", mode);
  return { defaultMode: mode };
});

ipcMain.handle(
  "lcode:orchestration.setRouterModel",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const feature = await models();
    const record = (input ?? {}) as Record<string, unknown>;
    const provider = record["provider"];
    const model = record["model"];
    // `null` 表示"跟随默认模型"——那是合法取值，不是缺参
    if (provider === null || provider === "") {
      await feature.services.settings.setByKey("orchestration.routerModel", null);
      return { saved: true, routerModel: null };
    }
    if (typeof provider !== "string" || typeof model !== "string" || model === "") {
      throw new Error("同时需要 provider 与 model；要恢复跟随默认模型请传 null");
    }
    await feature.services.settings.setByKey("orchestration.routerModel", { provider, model });
    return { saved: true, routerModel: { provider, model } };
  },
);

// ─────────────── 跨会话编排：档位 / 在途 worker（docs/26 §7.4 / §6） ───────────────

/**
 * 某个会话当前的编排档位（`off` / `observe` / `auto`）。
 *
 * 传 `sessionId` 就是按会话解析（会话自己切过档就用自己的，否则回落全局兜底）。
 */
ipcMain.handle("lcode:orchestration.mode", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["sessionId"];
  const rt = await agentRuntime();
  if (typeof sessionId !== "string" || sessionId === "") return { mode: rt.orchestration.mode() };
  return { mode: rt.orchestration.modeFor(sessionId) };
});

ipcMain.handle("lcode:orchestration.setMode", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const mode = record["mode"];
  if (mode !== "off" && mode !== "observe" && mode !== "auto") {
    throw new Error("mode 必须是 off / observe / auto");
  }
  const sessionId = record["sessionId"];
  const rt = await agentRuntime();
  // 传了会话就只改那个会话（落事件可回放），否则改全局兜底值
  rt.orchestration.setMode(mode, "用户切换", typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined);
  return { mode: typeof sessionId === "string" && sessionId !== "" ? rt.orchestration.modeFor(sessionId) : rt.orchestration.mode() };
});

/** 某个 Router 下的在途 worker（列表 + 取消出口，docs/26 §6）。 */
ipcMain.handle("lcode:orchestration.workers", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const routerSessionId = record["routerSessionId"];
  if (typeof routerSessionId !== "string" || routerSessionId === "") {
    throw new Error("routerSessionId 必填");
  }
  const rt = await agentRuntime();
  return { workers: rt.orchestration.list({ routerSessionId }) };
});

ipcMain.handle("lcode:orchestration.cancelWorker", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const taskId = record["taskId"];
  if (typeof taskId !== "string" || taskId === "") throw new Error("taskId 必填");
  const rt = await agentRuntime();
  return { cancelled: await rt.orchestration.cancel(taskId) };
});

function refNameFor(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

// ─────────────── 对话（T5.3；21 §2.2 / §2.13） ───────────────

/**
 * agent 运行时**惰性装配**，且与模型配置**共享同一个 ctx**。
 *
 * 为什么必须共享：模型配置（设置页）写的是 `ctx.agentDefaultModel` / `ctx.llm`，
 * 而引擎读的也是这两个。两套 ctx 会让「设置页改了默认模型、引擎还用旧的」——
 * 那类问题极难自查，所以从装配上就不给它机会。
 */
let runtime: AgentRuntime | null = null;
let runtimeInit: Promise<AgentRuntime> | null = null;
let codeIndex: CodeIndexService | null = null;

/** 自定义 Embedding 的 API Key 单独存凭据存储，不复用聊天模型 Key。 */
const CODE_INDEX_EMBEDDING_KEY_REF = "CODE_INDEX_EMBEDDING_API_KEY";

/**
 * 代码索引的 embedding 配置：
 * - 默认复用「设置 → 模型」里已保存的服务商（base_url + 凭据）；
 * - 也可以选「自定义 Embedding」，直接给接口地址、Key 与模型名。
 */
async function resolveCodeIndexEmbedding(
  services: DesktopServices,
): Promise<{ readonly provider: string; readonly config: { readonly baseUrl: string; readonly model: string; readonly apiKey?: string } } | undefined> {
  const model = services.readSetting("codeIndex.model");
  if (typeof model !== "string" || model.trim() === "") return undefined;
  const explicit = services.readSetting("codeIndex.provider");
  const providerName = typeof explicit === "string" ? explicit.trim() : "";
  const baseSetting = services.readSetting("codeIndex.base_url");
  const customBase = typeof baseSetting === "string" ? baseSetting.trim() : "";
  if (providerName === "custom" || (providerName === "" && customBase !== "")) {
    if (customBase === "") return undefined;
    const credential = await services.credentials.resolve(CODE_INDEX_EMBEDDING_KEY_REF);
    return {
      provider: "custom",
      config: {
        baseUrl: customBase,
        model: model.trim(),
        ...(credential === undefined ? {} : { apiKey: credential.value }),
      },
    };
  }
  const fallback = services.readSetting("model.default_provider");
  const name = providerName !== ""
    ? providerName
    : typeof fallback === "string"
      ? fallback
      : "";
  const providers = services.readSetting("model.providers");
  const list = Array.isArray(providers) ? providers : [];
  const provider = list.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as { name?: unknown }).name === name,
  );
  if (provider === undefined) return undefined;
  const baseUrl = provider["base_url"];
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return undefined;
  const ref = typeof provider["api_key_ref"] === "string" ? provider["api_key_ref"] : "";
  const credential = ref === "" ? undefined : await services.credentials.resolve(ref);
  return {
    provider: name,
    config: {
      baseUrl,
      model: model.trim(),
      ...(credential === undefined ? {} : { apiKey: credential.value }),
    },
  };
}

/** 设置页读的形状：模型服务商以显示名返回，内部 id 只用于保存。 */
async function codeIndexConfigView(services: DesktopServices): Promise<{
  readonly provider: string | null;
  readonly model: string | null;
  readonly base_url: string | null;
  readonly has_api_key: boolean;
  readonly providers: readonly {
    readonly name: string;
    readonly label: string;
    readonly base_url: string;
    readonly preset: string | null;
  }[];
}> {
  const providersRaw = services.readSetting("model.providers");
  const providers = Array.isArray(providersRaw)
    ? providersRaw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .flatMap((item) => {
          const name = item["name"];
          if (typeof name !== "string" || name === "") return [];
          return [{
            name,
            label: typeof item["label"] === "string" && item["label"].trim() !== "" ? item["label"].trim() : name,
            base_url: typeof item["base_url"] === "string" ? item["base_url"] : "",
            preset: typeof item["provider_preset"] === "string" && item["provider_preset"] !== "" ? item["provider_preset"] : null,
          }];
        })
    : [];
  const provider = services.readSetting("codeIndex.provider");
  const model = services.readSetting("codeIndex.model");
  const base = services.readSetting("codeIndex.base_url");
  const credential = await services.credentials.resolve(CODE_INDEX_EMBEDDING_KEY_REF);
  return {
    provider: typeof provider === "string" && provider !== "" ? provider : null,
    model: typeof model === "string" && model !== "" ? model : null,
    base_url: typeof base === "string" && base !== "" ? base : null,
    has_api_key: credential !== undefined,
    providers,
  };
}

async function codeIndexService(): Promise<CodeIndexService> {
  if (codeIndex !== null) return codeIndex;
  const feature = await models();
  codeIndex = createCodeIndex({
    home: feature.services.home,
    resolveEmbedding: () => resolveCodeIndexEmbedding(feature.services),
  });
  return codeIndex;
}
/** 已订阅的会话 → 撤销器（避免同一会话被重复订阅） */
const sessionWatch = new Map<string, () => void>();
/** 已订阅"轮失败"的会话 → 撤销器 */
const turnFailureWatch = new Map<string, () => void>();
/** 会话 → 已上报过的失败 turn/end 的 seq（同一轮不重复推） */
const reportedTurnErrors = new Map<string, number>();

/**
 * **审批桥**（12 §5；21 §2.13）。
 *
 * 这是内核与用户之间**唯一**的审批通路。它做三件事：
 *
 * 1. `approval.ask` 挂出去 → 主进程把问题推给所有窗口
 * 2. 等窗口回话（`lcode:approval.answer`）
 * 3. 没有窗口/没人答 → 把 promise **删掉**，让内核的超时或 abort 走 fail-closed
 *
 * ## 为什么窗口关掉时必须把 promise 删掉
 *
 * 内核那边在等一个答案。如果窗口关了而 promise 永远挂着，那一轮就**永久卡住**
 * （用户取消也取消不掉，因为取消要经过同一轮的事件循环）。删掉它让"没人可问"
 * 变成一个明确的失败，而不是一个永不落地的等待。
 */
const pendingApprovals = new Map<
  string,
  {
    readonly request: ApprovalRequest;
    readonly resolve: (result: ApprovalResult) => void;
  }
>();

const approvalChannel: ApprovalChannel = {
  async ask(request) {
    // 没有窗口 = 没人可问 → 返回 undefined，审批服务会落成 `unavailable`（fail-closed）
    if (BrowserWindow.getAllWindows().length === 0) return undefined;
    pushToRenderer("lcode:approval.asked", request);
    return await new Promise<ApprovalResult | undefined>((resolve) => {
      pendingApprovals.set(request.callId, {
        request,
        resolve: (result) => resolve(result),
      });
    });
  },
};

/** 窗口全关时清空等不到的审批（否则内核那一轮会永久挂着） */
function abortPendingApprovals(): void {
  for (const { resolve } of pendingApprovals.values()) resolve("cancelled");
  pendingApprovals.clear();
}

/**
 * 读取 Electron/系统的代理设置，供 Node 侧 fetch 使用。
 * 只支持 HTTP(S) 代理；PAC/SOCKS 只配置时返回 undefined（直连），避免悄悄绕过代理。
 */
async function resolveSystemProxy(target: string): Promise<string | undefined> {
  try {
    const raw = await session.defaultSession.resolveProxy(target);
    for (const part of raw.split(";")) {
      const [kind, host] = part.trim().split(/\s+/, 2);
      if (host === undefined || host === "") continue;
      if (kind === "PROXY" || kind === "HTTPS") return `http://${host}`;
    }
  } catch {
    // 代理解析失败按直连处理，不阻断本地工具
  }
  return undefined;
}

/** fs worker 源码：打包态在 dist，开发态回退仓库源码；缺失时文件工具继续走 fs-local。 */
function readFsWorkerSource(): string | undefined {
  const candidates = [
    join(__dirname, "fs-worker.cjs"),
    join(__dirname, "../../../packages/fs/fs-sandbox/src/fs-worker.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // 继续找下一个候选
    }
  }
  console.warn("[lcode] 未找到 fs-worker.cjs，工作区文件工具将不使用 OS 沙箱 worker");
  return undefined;
}

/**
 * 语言服务器：TS/JS 用随包的 typescript-language-server；其余语言由 bundle 里的
 * `discoverAutoLspServers` 扫描 PATH，找到才注册。缺失时不阻塞，`lsp_query` 会返回
 * 带安装命令的错误。`~/.lcode/lsp.json` 仍可覆盖或追加语言。
 */
function readLspServers(home: string): Readonly<Record<string, LspServerDef>> {
  const servers: Record<string, LspServerDef> = {};
  try {
    const requireFromApp = createRequire(join(app.getAppPath(), "package.json"));
    const cli = requireFromApp.resolve("typescript-language-server/lib/cli.mjs");
    const typescript: LspServerDef = {
      command: process.execPath,
      args: [cli, "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    servers.typescript = typescript;
    servers.javascript = typescript;
  } catch {
    // 未随包安装时留空：查询对应语言会得到安装/配置提示
  }
  Object.assign(servers, discoverAutoLspServers());
  try {
    const parsed = JSON.parse(readFileSync(join(home, "lsp.json"), "utf8")) as { servers?: unknown };
    const custom = parsed.servers;
    if (typeof custom === "object" && custom !== null && !Array.isArray(custom)) {
      for (const [language, value] of Object.entries(custom as Record<string, unknown>)) {
        if (language.trim() === "" || typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const command = record["command"];
        if (typeof command !== "string" || command === "") continue;
        const args = Array.isArray(record["args"])
          ? record["args"].filter((item): item is string => typeof item === "string")
          : undefined;
        const env = typeof record["env"] === "object" && record["env"] !== null && !Array.isArray(record["env"])
          ? Object.fromEntries(
              Object.entries(record["env"] as Record<string, unknown>)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            )
          : undefined;
        servers[language.trim()] = {
          command,
          ...(args === undefined ? {} : { args }),
          ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
        };
      }
    }
  } catch {
    // 文件缺失或损坏：使用内置默认
  }
  return servers;
}

function mcpConfigPath(home: string): string {
  return join(home, "mcp.json");
}

/** 解析 mcp.json / 保存入参里的 servers 映射；结构不对的条目直接跳过。 */
function parseMcpServers(input: unknown): Record<string, McpServerConfig> {
  const root = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const source = root["servers"] ?? input;
  const servers: Record<string, McpServerConfig> = {};
  if (typeof source !== "object" || source === null || Array.isArray(source)) return servers;
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (name.trim() === "" || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const command = record["command"];
    if (typeof command !== "string" || command === "") continue;
    const args = Array.isArray(record["args"])
      ? record["args"].filter((item): item is string => typeof item === "string")
      : undefined;
    const env = typeof record["env"] === "object" && record["env"] !== null && !Array.isArray(record["env"])
      ? Object.fromEntries(
          Object.entries(record["env"] as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined;
    servers[name.trim()] = {
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
      ...(record["enabled"] === false ? { enabled: false } : {}),
    };
  }
  return servers;
}

function readMcpServers(home: string): Record<string, McpServerConfig> {
  try {
    return parseMcpServers(JSON.parse(readFileSync(mcpConfigPath(home), "utf8")));
  } catch {
    return {};
  }
}

async function agentRuntime(): Promise<AgentRuntime> {
  if (runtime !== null) return runtime;
  if (runtimeInit === null) {
    runtimeInit = (async () => {
      const feature = await models();
      /*
       * 网页工具：web_fetch 走域名白名单；web_search 默认内置 Tavily。
       * Key 每次调用时从本机凭据服务读取，设置页保存后无需重启；没有 Key 时
       * 工具仍可见，但会在执行阶段给出明确的配置提示。
       */
      const searcher = createWebSearcher(
        createTavilySearchBackend({
          resolveApiKey: async () =>
            (await feature.services.credentials.resolve(TAVILY_API_KEY_REF))?.value,
          resolveProxy: resolveSystemProxy,
        }),
      );
      const searchMaxResults = (): number => {
        const raw = feature.services.readSetting("webSearch.maxResults");
        return typeof raw === "number" && Number.isFinite(raw)
          ? Math.min(10, Math.max(1, Math.floor(raw)))
          : 5;
      };
      return createAgentRuntime({
        services: feature.services,
        approval: createApprovalService({ channel: approvalChannel }),
        builtinSkillsDir: join(__dirname, "skills"),
        fsWorkerSource: readFsWorkerSource(),
        lspServers: readLspServers(feature.services.home),
        mcpServers: readMcpServers(feature.services.home),
        codeSearch: async (input) => (await codeIndexService()).search(input),
        web: {
          fetch: createWebFetcher(undefined, { resolveProxy: resolveSystemProxy }).fetch,
          search: async (input) => {
            const configured = searchMaxResults();
            return searcher.search({
              ...input,
              maxResults: Math.min(configured, input.maxResults ?? configured),
            });
          },
          searchProvider: searcher.provider,
        },
        webSearch: true,
        /*
         * Router 专用模型（docs/26 §3.2）。设置里没配就跟随默认模型。
         *
         * 用 `readSetting` 直接读而不是走 IPC：这是启动时的一次性装配，
         * 而路由规则本身不需要热更新——改设置后重开应用即可生效。
         */
        ...(() => {
          const raw = feature.services.readSetting("orchestration.routerModel");
          if (raw === null || typeof raw !== "object") return {};
          const record = raw as { provider?: unknown; model?: unknown };
          if (typeof record.provider !== "string" || typeof record.model !== "string") return {};
          return { routerModel: { provider: record.provider, model: record.model } };
        })(),
        /*
         * 只给沙箱 helper 一个精确候选：
         * - 打包态只认 resources/app/native；
         * - 开发态认仓库里的构建产物。
         * 不再让 Provider 按 process.cwd() 兜底，避免被同名文件替换。
         */
        ...(process.platform === "win32"
          ? {
              sandboxHelperPaths: [
                app.isPackaged
                  ? join(process.resourcesPath, "app", "native", "lcode-sandbox-win32.exe")
                  : join(__dirname, "../../../packages/sandbox/sandbox-win32/native/lcode-sandbox-win32.exe"),
              ],
            }
          : {}),
      });
    })();
  }
  runtime = await runtimeInit;
  try {
    // 随包分发的技能至少要有一份在用户目录；失败不阻塞启动（技能目录仍可从内置根读取）
    seedBuiltinSkills({ home: runtime.services.home, sourceDir: join(__dirname, "skills") });
  } catch (error) {
    console.error("[lcode] 内置技能初始化失败：", error);
  }
  return runtime;
}

// ─────────────── Agent 预设（全局默认；与权限预设正交） ───────────────

ipcMain.handle("lcode:agentPreset.get", async () => (await agentRuntime()).ctx.get("agentPreset").snapshot());
ipcMain.handle("lcode:agentPreset.set", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const preset = (input as { preset?: unknown } | null)?.preset;
  if (typeof preset !== "string") throw new Error("preset 必填");
  return (await agentRuntime()).ctx.get("agentPreset").set(preset as never);
});
ipcMain.handle("lcode:agentPreset.list", async () => {
  const rt = await agentRuntime();
  return {
    presets: BUILTIN_AGENT_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      available: (SELECTABLE_AGENT_PRESETS as readonly string[]).includes(preset.id),
    })),
    current: rt.ctx.get("agentPreset").snapshot(),
  };
});

// ─────────────── web 域名白名单（按工作区） ───────────────

ipcMain.handle("lcode:webAllowlist.list", async () => (await agentRuntime()).ctx.get("webAllowlist").snapshot());
ipcMain.handle("lcode:webAllowlist.remove", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  const domain = record["domain"];
  if (typeof workspace !== "string" || workspace === "" || typeof domain !== "string" || domain === "") throw new Error("workspace 与 domain 必填");
  const allowlist = (await agentRuntime()).ctx.get("webAllowlist");
  allowlist.remove(workspace, domain);
  return allowlist.snapshot();
});
ipcMain.handle("lcode:webAllowlist.prune", async () => {
  const allowlist = (await agentRuntime()).ctx.get("webAllowlist");
  let removed = 0;
  for (const entry of allowlist.snapshot()) {
    if (existsSync(entry.workspace)) continue;
    allowlist.removeWorkspace(entry.workspace);
    removed += 1;
  }
  return { entries: allowlist.snapshot(), removed };
});

// ─────────────── 网络审计（跨会话最近记录） ───────────────

ipcMain.handle("lcode:networkAudit.list", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const raw = record["limit"];
  const limit = typeof raw === "number" && Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 50;
  return (await agentRuntime()).ctx.get("networkAudit").list(limit);
});
ipcMain.handle("lcode:networkAudit.clear", async () => {
  (await agentRuntime()).ctx.get("networkAudit").clear();
  return [];
});

// ─────────────── 网页搜索（Tavily 内置 provider） ───────────────

/**
 * credentials_refs 的 scope 约束只允许 llm / plugin:* / sandbox:*。
 * 内置搜索没有单独的 plugin 包，用 `plugin:web-search` 作为命名空间即可，
 * 不为一个 scope 改表结构；值本身仍只落在本机 0600 凭据文件。
 */
const TAVILY_CREDENTIAL_SCOPE = "plugin:web-search";

async function webSearchStatus(): Promise<{
  provider: typeof TAVILY_PROVIDER;
  configured: boolean;
  source: string | null;
  maxResults: number;
}> {
  const rt = await agentRuntime();
  const resolved = await rt.services.credentials.describeSource(TAVILY_API_KEY_REF);
  const refs = await rt.services.credentials.listRefs(TAVILY_CREDENTIAL_SCOPE);
  const storedBackend = refs.find((item) => item.ref === TAVILY_API_KEY_REF && item.present)?.source;
  const raw = rt.services.readSetting("webSearch.maxResults");
  const maxResults =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.min(10, Math.max(1, Math.floor(raw)))
      : 5;
  return {
    provider: TAVILY_PROVIDER,
    configured: resolved !== undefined,
    // `describeSource` 对已写入值统一回 keychain；实际后端以 credentials_refs 为准。
    source: storedBackend ?? resolved ?? null,
    maxResults,
  };
}

ipcMain.handle("lcode:webSearch.status", async () => webSearchStatus());

ipcMain.handle("lcode:webSearch.save", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const apiKey = typeof record["apiKey"] === "string" ? record["apiKey"].trim() : "";
  const maxResults = record["maxResults"];
  const rt = await agentRuntime();
  if (apiKey !== "") {
    if (apiKey.length > 512) throw new Error("Tavily API Key 过长");
    await rt.services.credentials.write(TAVILY_API_KEY_REF, apiKey, TAVILY_CREDENTIAL_SCOPE);
  }
  if (maxResults !== undefined) {
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
      throw new Error("每次结果数必须是 1-10 的整数");
    }
    await rt.services.settings.setByKey("webSearch.maxResults", maxResults);
  }
  return webSearchStatus();
});

ipcMain.handle("lcode:webSearch.remove", async () => {
  const rt = await agentRuntime();
  await rt.services.credentials.delete(TAVILY_API_KEY_REF);
  return webSearchStatus();
});

ipcMain.handle("lcode:webSearch.test", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const typed = typeof record["apiKey"] === "string" ? record["apiKey"].trim() : "";
  const rt = await agentRuntime();
  const stored = typed === "" ? (await rt.services.credentials.resolve(TAVILY_API_KEY_REF))?.value : undefined;
  const apiKey = typed !== "" ? typed : stored ?? "";
  if (apiKey === "") throw new Error("请先填写或保存 Tavily API Key");
  const backend = createTavilySearchBackend({
    resolveApiKey: () => apiKey,
    timeoutMs: 12_000,
    resolveProxy: resolveSystemProxy,
  });
  const results = await backend.search({ query: "Lcode AI coding tool", maxResults: 1 });
  return { ok: true, count: results.length };
});

// ─────────────── MCP 服务（本地 stdio；保存后运行时重连） ───────────────

ipcMain.handle("lcode:mcp.status", async () => {
  const rt = await agentRuntime();
  return { status: rt.ctx.get("mcp").status() };
});

ipcMain.handle("lcode:mcp.config", async () => {
  const rt = await agentRuntime();
  return { servers: readMcpServers(rt.services.home), path: mcpConfigPath(rt.services.home) };
});

ipcMain.handle("lcode:mcp.save", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const servers = parseMcpServers(record["servers"] === undefined ? input : { servers: record["servers"] });
  const rt = await agentRuntime();
  const path = mcpConfigPath(rt.services.home);
  writeFileSync(path, JSON.stringify({ version: 1, servers }, null, 2), "utf8");
  await rt.ctx.get("mcp").reload(servers);
  return { status: rt.ctx.get("mcp").status(), servers, path };
});

ipcMain.handle("lcode:mcp.reload", async () => {
  const rt = await agentRuntime();
  const servers = readMcpServers(rt.services.home);
  await rt.ctx.get("mcp").reload(servers);
  return { status: rt.ctx.get("mcp").status(), servers };
});

// ─────────────── 代码语义索引（code_search） ───────────────

ipcMain.handle("lcode:codeIndex.status", async () => (await codeIndexService()).status());

ipcMain.handle("lcode:codeIndex.config", async () => {
  const rt = await agentRuntime();
  return await codeIndexConfigView(rt.services);
});

ipcMain.handle("lcode:codeIndex.save", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const provider = typeof record["provider"] === "string" ? record["provider"].trim() : "";
  const model = typeof record["model"] === "string" ? record["model"].trim() : "";
  if (model === "") throw new Error("embedding 模型名必填");
  if (model.length > 200) throw new Error("embedding 模型名过长");
  const rt = await agentRuntime();
  if (provider === "custom") {
    const baseUrl = typeof record["base_url"] === "string" ? record["base_url"].trim() : "";
    if (baseUrl === "") throw new Error("自定义 Embedding 需要填写接口地址");
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("接口地址必须以 http:// 或 https:// 开头");
    await rt.services.settings.setByKey("codeIndex.provider", "custom");
    await rt.services.settings.setByKey("codeIndex.base_url", baseUrl);
    await rt.services.settings.setByKey("codeIndex.model", model);
    const apiKey = typeof record["api_key"] === "string" ? record["api_key"].trim() : "";
    if (apiKey !== "") await rt.services.credentials.write(CODE_INDEX_EMBEDDING_KEY_REF, apiKey);
  } else {
    if (provider === "") throw new Error("请选择服务商");
    const providersRaw = rt.services.readSetting("model.providers");
    const exists = Array.isArray(providersRaw) && providersRaw.some(
      (item) => typeof item === "object" && item !== null && (item as { name?: unknown }).name === provider,
    );
    if (!exists) throw new Error("所选服务商已不存在，请重新选择");
    await rt.services.settings.setByKey("codeIndex.provider", provider);
    await rt.services.settings.setByKey("codeIndex.base_url", "");
    await rt.services.settings.setByKey("codeIndex.model", model);
  }
  return await codeIndexConfigView(rt.services);
});

ipcMain.handle("lcode:codeIndex.rebuild", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  const root = resolve(workspace);
  let stat: Stats;
  try {
    stat = statSync(root);
  } catch {
    throw new Error("工作区目录不存在");
  }
  if (!stat.isDirectory()) throw new Error("工作区不是目录");
  return (await codeIndexService()).rebuild(root);
});

ipcMain.handle("lcode:codeIndex.clear", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  if (workspace !== undefined && typeof workspace !== "string") throw new Error("workspace 必须是字符串");
  const cleared = (await codeIndexService()).clear(
    workspace === undefined || workspace === "" ? undefined : resolve(workspace),
  );
  return { cleared };
});

// ─────────────── 权限预设（P4-05：主进程持状态，renderer 只显示） ───────────────

const PERMISSION_PRESETS = new Set(['只读', '工作区内修改', '完全访问']);

ipcMain.handle('lcode:permissions.get', async () => {
  const presets = (await agentRuntime()).ctx.get('permissionPresets');
  return { ...presets.snapshot(), audit: presets.audit() };
});

ipcMain.handle('lcode:permissions.set', async (_e: IpcMainInvokeEvent, input: unknown) => {
  const preset = (input as { preset?: unknown } | null)?.preset;
  if (typeof preset !== 'string' || !PERMISSION_PRESETS.has(preset)) throw new Error('未知的权限预设');
  const presets = (await agentRuntime()).ctx.get('permissionPresets');
  await presets.set(preset as Parameters<typeof presets.set>[0]);
  return { ...presets.snapshot(), audit: presets.audit() };
});

// ─────────────── 插件（P6 产品入口；renderer 只拿安全投影） ───────────────

interface PluginRef {
  readonly id: string;
  readonly version: string;
}

function pluginRef(input: unknown): PluginRef {
  if (typeof input !== 'object' || input === null) throw new Error('插件参数必须是对象');
  const record = input as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') throw new Error('插件 id 必填');
  if (typeof record.version !== 'string' || record.version === '') throw new Error('插件 version 必填');
  return { id: record.id, version: record.version };
}

function publicPlugins(rt: AgentRuntime) {
  const active = new Set(rt.plugins.inspect().map((entry) => `${entry.id}@${entry.version}`));
  return rt.plugins.list().map((entry) => ({
    id: entry.id,
    version: entry.version,
    state: entry.state,
    active: active.has(`${entry.id}@${entry.version}`),
    source: entry.source,
    installedAt: entry.installedAt,
    permissions: entry.permissions,
    contributes: entry.contributes,
  }));
}

ipcMain.handle('lcode:plugins.list', async () => publicPlugins(await agentRuntime()));
ipcMain.handle('lcode:plugins.inspect', async () => (await agentRuntime()).plugins.inspect());

/**
 * 渲染层加载 client 插件的结果回传（只为可观测性）。
 *
 * 渲染进程的 `console.warn` 在打包后不会进 dev 终端，排查"插件到底加载了没"
 * 时看不到任何线索。让它们把结果发一份过来，主进程的 stderr 一定可见。
 */
ipcMain.handle('lcode:plugins.clientReport', (_event, input: unknown) => {
  const record = (input ?? {}) as { loaded?: unknown; slots?: unknown };
  const loaded = Array.isArray(record.loaded) ? record.loaded : [];
  if (loaded.length === 0) {
    console.warn('[lcode] 渲染层没有加载任何 client 插件');
    return { ok: true };
  }
  console.info(`[lcode] 渲染层已加载 ${loaded.length} 个 client 插件：${loaded.map(String).join(', ')}`);
  return { ok: true };
});

/**
 * 渲染层插件（docs/30 §9）：把已启用插件的 client 入口**源码**交给渲染层。
 *
 * ## 为什么不给路径、让渲染层自己 import
 *
 * 渲染进程在开发态是 `http://localhost:5173`、生产态是 `file://`，两种协议的
 * 跨源规则不同；插件的 client 入口在 `~/.lcode/plugins/<id>/` 下，直接 `import()`
 * 一个本机绝对路径在 `file://` 下会被拦，在 http 下更不可能。所以统一走：
 * 主进程读源码 → IPC 传给渲染层 → 渲染层用 Blob URL 动态 import。
 *
 * 这样路径与协议差异全部消化在主进程，渲染层只负责执行字节。
 *
 * ## 安全边界
 *
 * - 只回**已启用且状态为 active** 的插件；
 * - 只读 manifest 里声明的 `contributes.client.entry`，不接受任意路径；
 * - 源码大小设上限（4 MB）：一个 client 插件不该有几 MB 的 JS，
 *   超了多半是打错了入口（比如指到了 node_modules 的 bundle）。
 */
const CLIENT_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 读取插件的用户配置（`config.json` 放在插件目录下）。
 *
 * 这是**当前最小的配置通道**：插件注册表还没有 config 存储（`plugins` 表
 * 只记 manifest 与权限）。用一个约定文件名而不是引入一套存储，理由是
 * 配置本来就是插件自己的数据，放它自己目录下最直白、也便于用户手改。
 *
 * 读不到或解析失败都返回空对象：配置缺失不该让插件整个不可用。
 */
function readPluginConfig(installPath: string): Record<string, unknown> {
  try {
    const file = join(installPath, 'config.json');
    if (!existsSync(file)) return {};
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    console.warn(`[lcode] 插件配置读取失败（${installPath}）：${String(error)}`);
    return {};
  }
}
ipcMain.handle('lcode:plugins.clientBundles', async () => {
  const rt = await agentRuntime();
  const bundles: {
    id: string;
    name: string;
    version: string;
    slots: readonly string[];
    source: string;
    config?: unknown;
  }[] = [];
  for (const entry of rt.plugins.list()) {
    const client = entry.contributes.client;
    /*
     * 只排除**被用户停用**的插件；`installed` 仍然放行。
     *
     * 理由：`state` 反映的是 **host 那半**的激活结果，而 client 那半在渲染层跑，
     * 两者互不依赖。要求 host 先激活成功才给 UI，会让"host 起不来但界面能用"
     * 的插件整个失效——host 侧现在还有既有的沙箱问题（AppContainer 下
     * electron 子进程无法启动），把两者绑一起等于 client 插件永远用不了。
     */
    if (client === undefined) continue;
    // 与 host 侧同一条路径拼接规则；manifest 已保证 entry 是包内 ./ 相对路径
    const file = join(entry.installPath, client.entry);
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > CLIENT_BUNDLE_MAX_BYTES) {
        console.warn(`[lcode] 跳过 ${entry.id} 的 client 入口（不是文件或超过 ${CLIENT_BUNDLE_MAX_BYTES} 字节）：${file}`);
        continue;
      }
      bundles.push({
        id: entry.id,
        // PluginInfo 不带 name（那是 manifest 的展示字段）；用 id 足够区分，界面也能认出来
        name: entry.id,
        version: entry.version,
        slots: client.slots,
        source: readFileSync(file, 'utf8'),
        // client 插件读 `globalThis.__lcodePluginConfig`；没配过就是空对象
        config: readPluginConfig(entry.installPath),
      });
    } catch (error) {
      // 入口缺失/读不了：跳过这个插件的 UI 部分，不影响它的 host 能力
      console.warn(`[lcode] 读取 ${entry.id} 的 client 入口失败：${String(error)}`);
    }
  }
  return bundles;
});
ipcMain.handle('lcode:runtime.composition', async () => (await agentRuntime()).composition);
/** 沙箱状态：机制、降级原因与三项边界（设置页只读展示）。 */
ipcMain.handle('lcode:sandbox.status', async () => (await agentRuntime()).ctx.get('sandbox').status());
/**
 * 内置插件总览：全局插件来自实际组合快照，会话插件来自当前工具注册表。
 * 只读视图；启用/停用由代码与模式决定（见 @lcode/lcode-desktop 的 builtin-plugins）。
 */
ipcMain.handle('lcode:runtime.builtinPlugins', async () => {
  const rt = await agentRuntime();
  return buildBuiltinPluginCatalog({
    composition: rt.composition,
    tools: rt.ctx.get('tools').schemas().map(({ name, description }) => ({ name, description })),
    platform: process.platform,
  });
});
ipcMain.handle('lcode:plugins.install', async (_e: IpcMainInvokeEvent, input: unknown) => {
  const path = (input as { path?: unknown } | null)?.path;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('插件目录 path 必填');
  const rt = await agentRuntime();
  const installed = await rt.plugins.installLocal(path);
  return { installed, plugins: publicPlugins(rt) };
});
ipcMain.handle('lcode:plugins.activate', async (_e: IpcMainInvokeEvent, input: unknown) => {
  const rt = await agentRuntime();
  await rt.plugins.activate(pluginRef(input));
  return publicPlugins(rt);
});
ipcMain.handle('lcode:plugins.deactivate', async (_e: IpcMainInvokeEvent, input: unknown) => {
  const rt = await agentRuntime();
  await rt.plugins.deactivate(pluginRef(input));
  return publicPlugins(rt);
});
ipcMain.handle('lcode:plugins.uninstall', async (_e: IpcMainInvokeEvent, input: unknown) => {
  const rt = await agentRuntime();
  await rt.plugins.uninstall(pluginRef(input));
  return publicPlugins(rt);
});

/** 把一条消息推给所有窗口 */
function pushToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * `assistant/chunk` 是高频流（每个 token 一条），逐条 `send` 会让 IPC 很吵。
 * 这里按 tick **合并成批**再发——与 22 §4.2 的 chunk 打包是同一个思路。
 *
 * （契约 21 §2.13 要求事件流走 `MessagePort` 做背压，那是批次⑦ 的性能优化。
 * 当前先把数据接对：端口化是同一份事件换一条更省事的通道，不改变语义。）
 */
const CHUNK_FLUSH_MS = 33;
const pendingChunks = new Map<string, unknown[]>();
let chunkTimer: NodeJS.Timeout | null = null;

function flushChunks(): void {
  chunkTimer = null;
  for (const [sessionId, chunks] of pendingChunks) {
    if (chunks.length > 0)
      pushToRenderer("lcode:session.chunks", {
        session_id: sessionId,
        chunks,
        // 仅作性能观测：renderer 可用同一系统时钟计算“IPC 发出 → 实际绘制”。
        // 不属于会话日志，重放也不依赖它。
        sent_at: Date.now(),
      });
  }
  pendingChunks.clear();
}

/** 确保某个会话的事件被推给渲染进程（幂等） */
async function ensureSessionWatch(sessionId: string): Promise<void> {
  if (sessionWatch.has(sessionId)) return;
  const rt = await agentRuntime();
  const dispose = rt.watchSession(sessionId, (event) => {
    if (event.type === "assistant/chunk") {
      const list = pendingChunks.get(sessionId) ?? [];
      // IPC 契约传的是 `StreamChunk[]`。`event.data` 还包含只属于持久化日志的
      // turn/step 包装；把整层包装发过去会让 renderer 按 `chunk.type` 读取时永远得不到文本。
      list.push(event.data.chunk);
      pendingChunks.set(sessionId, list);
      if (chunkTimer === null)
        chunkTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS);
      return;
    }
    /*
     * worker 会话诞生：**立刻**让所有渲染层刷新侧栏。
     *
     * worker 是编排 provider 在服务层建的、不经过任何 IPC handler，
     * 所以不会触发任何已有的 `session.changed` 推送——实测表现为
     * "worker 跑完才出现在侧栏"。`worker/session-created` 落在 Router 日志里，
     * 在这里转发一次即可补上这条路。
     */
    if (event.type === "worker/session-created") {
      pushToRenderer("lcode:session.changed", { session_id: event.data.workerSessionId });
      pushToRenderer("lcode:session.changed", { session_id: sessionId });
    }
    // 结构与表面事件**即时**推：它们是 UI 的骨架，攒批会让"正在做什么"看起来卡住
    pushToRenderer("lcode:session.event", { session_id: sessionId, event });
  });
  sessionWatch.set(sessionId, dispose);
}

ipcMain.handle(
  "lcode:session.list",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const rt = await agentRuntime();
    const record = (input ?? {}) as Record<string, unknown>;
    const workspace = record["workspace"];
    const limit = record["limit"];
    const cursor = record["cursor"];
    return rt.sessions.list({
      ...(typeof workspace === "string" ? { workspace } : {}),
      ...(typeof limit === "number" && Number.isFinite(limit)
        ? { limit }
        : {}),
      ...(typeof cursor === "string" ? { cursor } : {}),
      ...(record["includeArchived"] === true ? { includeArchived: true } : {}),
      ...(record["includeDeleted"] === true ? { includeDeleted: true } : {}),
    });
  },
);

ipcMain.handle(
  "lcode:session.create",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const rawCwd = record["cwd"];
    if (rawCwd !== undefined && typeof rawCwd !== "string")
      throw new Error("cwd 必须是字符串");
    // 空 cwd = 用户没有选择工作区：不要把它偷换成进程当前目录
    const cwd =
      typeof rawCwd === "string" && rawCwd.trim() !== "" ? rawCwd : undefined;
    const title =
      typeof record["title"] === "string" ? record["title"] : undefined;
    const rt = await agentRuntime();
    const result = await rt.sessions.create({
      ...(cwd === undefined ? {} : { cwd }),
      ...(title === undefined ? {} : { title }),
    });
    /*
     * 编排调度会话（docs/26 §3.3）。
     *
     * 在建会话的同一次调用里定角色，而不是让渲染层再发一次 IPC——两步的话
     * 中间任何一步失败都会留下"会话建了但角色没定"的半成品，用户看到的是一个
     * 普通会话，却以为自己在用 Router。
     */
    const role = record["role"];
    /*
     * 会话级 Agent 预设（docs/30 §6）。
     *
     * 语义分工：
     * - 设置页的「Agent 预设」= **新会话默认值**（可随时改，影响之后新建的会话）
     * - 本会话的预设 = 创建时确定的**不可变**取值（模式决定工具集）
     *
     * 所以这里**不写全局设置**——那会把"这次的选择"变成"以后所有会话的默认"，
     * 用户只是给这一个会话选了模式，没打算改默认。
     */
    const preset = record["preset"];
    const explicitPreset = preset === "creator" || preset === "standard" ? preset : undefined;
    const defaultPreset = (() => {
      try {
        return rt.ctx.get("agentPreset").get();
      } catch {
        return "standard" as const;
      }
    })();
    rt.ctx.get("sessionPreset").setPreset(
      result.session_id,
      explicitPreset ?? defaultPreset,
      explicitPreset === undefined ? "default" : "user",
    );
    if (role === "router") {
      rt.sessionRoles.setRole(result.session_id, "router", "用户在新建时选择");
      /*
       * 给这个会话定档位（docs/26 §7.4）。
       *
       * 勾选 Router 本身就是"这次需要跨会话拆任务"的人工声明，所以会话默认
       * 就是 `auto`：勾了却说"你还没切档"是自相矛盾的。
       * 想看它怎么拆而不真执行的人，把设置里的「新建时」改成 `observe`。
       */
      const defaultMode = defaultModeOf((await models()).services);
      rt.orchestration.setMode(defaultMode, "新建编排会话时按设置定档", result.session_id);
      /*
       * 立刻 flush：`setRole` 只追加事件，而侧栏读的是**索引**。
       * 不 flush 的话列表要等这条会话下一次写事件（用户发第一句话）才看得到
       * role，期间它会显示成普通会话——徽标"点了新建却没出现"就是这么来的（实测确认）。
       */
      await rt.sessions.flush({ session_id: result.session_id });
    }
    const workspace = rt.sessions.workspaceOf(result.session_id);
    if (workspace !== undefined) {
      const trusted = rt.ctx.get("workspaceTrust").isTrusted(workspace);
      rt.sessions.sessionServiceFor(result.session_id).append({
        type: "workspace/trust",
        data: { workspace, trusted },
      });
    }
    pushToRenderer("lcode:session.changed", { session_id: result.session_id });
    return result;
  },
);

// ─────────────── 工作区信任（精确目录，不继承子目录） ───────────────

ipcMain.handle("lcode:workspace-trust.list", async () => {
  return (await agentRuntime()).ctx.get("workspaceTrust").list();
});

ipcMain.handle("lcode:workspace-trust.set", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  const trusted = record["trusted"];
  const sessionId = record["session_id"];
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  if (typeof trusted !== "boolean") throw new Error("trusted 必须为布尔值");
  const rt = await agentRuntime();
  const release = !trusted && rt.ctx.get("sandbox").releaseWorkspace !== undefined
    ? await rt.ctx.get("sandbox").releaseWorkspace!(workspace)
    : undefined;
  rt.ctx.get("workspaceTrust").setTrusted(workspace, trusted);
  /*
   * 取消信任要同时收回 web 工具的域名授权：否则目录已不可信，之前批准的域名
   * 仍可静默搜索/抓取。审计历史保留，便于事后复盘。
   */
  if (!trusted) rt.ctx.get("webAllowlist").removeWorkspace(workspace);
  if (typeof sessionId === "string" && sessionId !== "") {
    rt.sessions.sessionServiceFor(sessionId).append({ type: "workspace/trust", data: { workspace, trusted } });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
  }
  return { workspace, trusted, ...(release === undefined ? {} : { sandbox_release: release }) };
});

/** 打开既有会话、开始推它的事件，并把**已有历史**一并给渲染层（事件流只管"之后"） */
ipcMain.handle(
  "lcode:session.open",
  async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    const resumed = await rt.sessions.resume({ session_id: sessionId });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);
    const meta = await rt.sessions.meta({ session_id: sessionId });
    const history = await rt.sessions.derive({ session_id: sessionId });
    /*
     * **末尾是不是一个失败的轮**。
     *
     * 为什么不能只靠实时推送：失败可能发生在**渲染层订阅之前**。首页的流程是
     * 「输入 → send → 跳转工作台」，而配错模型时整轮在几十毫秒内就失败了——
     * 等 `SessionStream` 挂载好，那条推送早就过去了。实测就是这样：主进程确实推了，
     * 但没有任何人在听，界面依旧空白。
     *
     * 所以失败状态必须能从**日志**里读出来（那个 turn/end 一直在），这样无论是
     * 实时到达还是事后打开，界面都能给出同一个答案。
     */
    const lastTurnEnd = [...rt.sessions.sessionServiceFor(sessionId).events()]
      .reverse()
      .find((e) => e.type === "turn/end");
    const lastTurnErrored =
      lastTurnEnd?.type === "turn/end" && lastTurnEnd.data.reason === "error";
    return {
      // `sessions.meta` 的 `header` 才是带 workspace/title 的会话元数据；
      // 直接回整个 meta 会让渲染层读不到 workspace/title（标题栏显示“未设置工作区/未命名会话”）。
      meta: meta.header,
      history,
      events: rt.sessions.sessionServiceFor(sessionId).events(),
      repaired: resumed.repaired,
      closers: resumed.closers ?? [],
      last_turn_errored: lastTurnErrored,
    };
  },
);

ipcMain.handle(
  "lcode:session.delete",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    const found = await rt.agents.get({ session_id: sessionId });
    if (found !== null) await rt.agents.dispose({ agent_id: found.agent_id });
    const result = await rt.sessions.delete({ session_id: sessionId });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return result;
  },
);

ipcMain.handle(
  "lcode:session.restore",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const result = await (
      await agentRuntime()
    ).sessions.restore({ session_id: sessionId });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return result;
  },
);

ipcMain.handle(
  "lcode:session.rename",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const title = record["title"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    if (typeof title !== "string") throw new Error("title 必须是字符串");
    const result = await (
      await agentRuntime()
    ).sessions.rename({ session_id: sessionId, title });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return result;
  },
);

ipcMain.handle(
  "lcode:session.purge",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const result = await (
      await agentRuntime()
    ).sessions.purge({
      session_id: sessionId,
      ...(record["exported"] === true ? { exported: true } : {}),
      ...(record["force"] === true ? { force: true } : {}),
    });
    // 附件是跨会话共享的内容寻址文件：删除会话后重新扫一遍引用再清理。
    // 放到下一拍执行，别让大目录扫描阻塞删除操作的返回。
    const home = (await agentRuntime()).services.home;
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    setTimeout(() => gcSessionAttachments(home), 0);
    return result;
  },
);

/**
 * 记忆（docs/28）：读取当前生效的记忆、编辑用户记忆。
 *
 * 展示层要能回答"模型到底记住了什么"，所以 `read` 返回的是**真正会注入的文本**
 * （已按行/字符上限裁剪），而不是原文——否则界面显示的内容与实际注入不一致，
 * 用户会以为自己写的东西生效了，其实被截断了。
 */
ipcMain.handle("lcode:memory.read", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const rt = await agentRuntime();
  const workspace = typeof record["workspace"] === "string" ? record["workspace"] : undefined;
  return rt.ctx.get("memory").read({ home: rt.services.home, workspaceRoot: workspace });
});

ipcMain.handle("lcode:memory.readUser", async () => {
  const rt = await agentRuntime();
  return rt.ctx.get("memory").readUser({ home: rt.services.home });
});

ipcMain.handle("lcode:memory.writeUser", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const text = record["text"];
  if (typeof text !== "string") throw new Error("text 必填");
  const rt = await agentRuntime();
  const result = rt.ctx.get("memory").writeUser({ home: rt.services.home, text });
  // 记忆进系统提示词：写完后前缀会变，通知界面刷新（下次请求自然拿新内容）
  pushToRenderer("lcode:session.changed", {});
  return result;
});

/** 回收站：永久归档后的文件（只读列表；可整体清空） */
ipcMain.handle("lcode:session.trash", async () =>
  (await agentRuntime()).sessions.listTrash(),
);

/**
 * 各目录真实占用（设置页「记忆」分区用它显示会话日志体积）。
 *
 * 归档/永久归档、缓存与回收站清理已经各有归属：
 * 会话菜单负责归档，`lcode:session.emptyTrash` 负责清空回收站。
 * 这里只读取用量，不重复提供清理入口。
 */
ipcMain.handle("lcode:storage.usage", async () => {
  const rt = await agentRuntime();
  return rt.sessions.storageUsage();
});

ipcMain.handle("lcode:session.emptyTrash", async () => {
  const rt = await agentRuntime();
  const result = await rt.sessions.prune({ emptyTrash: true, cache: false });
  setTimeout(() => gcSessionAttachments(rt.services.home), 0);
  return result;
});

ipcMain.handle(
  "lcode:session.export",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const format = record["format"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    if (format !== "jsonl" && format !== "md" && format !== "bundle")
      throw new Error("format 必须是 jsonl、md 或 bundle");
    return (await agentRuntime()).sessions.export({
      session_id: sessionId,
      format,
    });
  },
);

ipcMain.handle(
  "lcode:session.import",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const path = record["path"];
    const title = record["title"];
    if (typeof path !== "string" || path === "") throw new Error("path 必填");
    if (title !== undefined && typeof title !== "string") throw new Error("title 必须是字符串");
    return (await agentRuntime()).sessions.import({
      path,
      ...(typeof title === "string" && title !== "" ? { title } : {}),
    });
  },
);

ipcMain.handle(
  "lcode:session.fork",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["source_session_id"];
    const boundary = record["boundary"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("source_session_id 必填");
    if (
      typeof boundary !== "number" ||
      !Number.isInteger(boundary) ||
      boundary < 0
    )
      throw new Error("boundary 必须是非负整数");
    const result = await (
      await agentRuntime()
    ).sessions.fork({ source_session_id: sessionId, boundary });
    pushToRenderer("lcode:session.changed", { session_id: result.session_id });
    return result;
  },
);

/** 回放相关接口只接受会话 id + 非负事件序号；渲染进程不得传入路径或任意查询。 */
function parseHistorySeqInput(
  input: unknown,
  field: "up_to_seq" | "call_seq" | "seq",
): { readonly session_id: string; readonly [key: string]: string | number } {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const seq = record[field];
  if (typeof sessionId !== "string" || sessionId === "")
    throw new Error("session_id 必填");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)
    throw new Error(`${field} 必须是非负整数`);
  return { session_id: sessionId, [field]: seq };
}

ipcMain.handle("lcode:session.history", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const parsed = parseHistorySeqInput(input, "up_to_seq");
  return (await agentRuntime()).sessions.replay({
    session_id: parsed.session_id,
    up_to_seq: parsed["up_to_seq"] as number,
  });
});

ipcMain.handle("lcode:event.body", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const parsed = parseHistorySeqInput(input, "seq");
  return (await agentRuntime()).sessions.body({
    session_id: parsed.session_id,
    seq: parsed["seq"] as number,
  });
});

ipcMain.handle("lcode:trace.why", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const parsed = parseHistorySeqInput(input, "call_seq");
  return (await agentRuntime()).sessions.why({
    session_id: parsed.session_id,
    call_seq: parsed["call_seq"] as number,
  });
});

ipcMain.handle("lcode:session.checkpoints", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  return (await agentRuntime()).sessions.checkpoints({ session_id: sessionId });
});

ipcMain.handle("lcode:session.fileCheckpoints", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  return (await agentRuntime()).checkpoints.list(sessionId);
});

ipcMain.handle("lcode:session.checkpoint.restore", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const checkpointId = record["checkpoint_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof checkpointId !== "string" || checkpointId === "") throw new Error("checkpoint_id 必填");
  const rt = await agentRuntime();
  const workspaceRoot = rt.sessions.workspaceOf(sessionId);
  if (workspaceRoot === undefined) throw new Error("会话没有可恢复的工作区");
  const result = await rt.checkpoints.restore({ sessionId, workspaceRoot, session: rt.sessions.sessionServiceFor(sessionId), checkpointId });
  pushToRenderer("lcode:session.changed", { session_id: sessionId });
  return result;
});

function attachmentWriter(home: string): ImageAttachmentWriter {
  return { put: ({ mediaType, data }) => putAttachment({ home, mediaType, data }) };
}

ipcMain.handle("lcode:attachments.read", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const hash = record["hash"];
  const mediaType = record["media_type"];
  if (typeof hash !== "string" || typeof mediaType !== "string")
    throw new Error("hash 与 media_type 必填");
  const data = readAttachment({ home: (await agentRuntime()).services.home, hash, mediaType });
  if (data === undefined) throw new Error("附件不存在或已被清理");
  return { media_type: mediaType, data };
});

const execFileAsync = promisify(execFile);

ipcMain.handle("lcode:session.contextUsage", async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  const rt = await agentRuntime();
  await rt.sessions.resume({ session_id: sessionId });
  return rt.contextUsage({ sessionId });
});

ipcMain.handle("lcode:session.compact", async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  const rt = await agentRuntime();
  await rt.sessions.resume({ session_id: sessionId });
  const result = await rt.compactSession({ sessionId });
  pushToRenderer("lcode:session.changed", { session_id: sessionId });
  return result;
});

ipcMain.handle("lcode:session.compactPreview", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const keepRecentTurns = record["keep_recent_turns"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (keepRecentTurns !== undefined && (typeof keepRecentTurns !== "number" || !Number.isInteger(keepRecentTurns) || keepRecentTurns < 1)) {
    throw new Error("keep_recent_turns 必须是正整数");
  }
  const rt = await agentRuntime();
  await rt.sessions.resume({ session_id: sessionId });
  return rt.compactPreview({
    sessionId,
    ...(keepRecentTurns === undefined ? {} : { keepRecentTurns }),
  });
});

ipcMain.handle("lcode:session.compactApply", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const previewId = record["preview_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof previewId !== "string" || previewId === "") throw new Error("preview_id 必填");
  const result = await (await agentRuntime()).compactApply({ sessionId, previewId });
  pushToRenderer("lcode:session.changed", { session_id: sessionId });
  return result;
});

ipcMain.handle("lcode:session.compactUndo", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const compactionId = record["compaction_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof compactionId !== "string" || compactionId === "") throw new Error("compaction_id 必填");
  const result = await (await agentRuntime()).compactUndo({ sessionId, compactionId });
  pushToRenderer("lcode:session.changed", { session_id: sessionId });
  return result;
});

/** 固定/屏蔽某一轮：只写日志事件，不改动消息本身。 */
ipcMain.handle("lcode:session.marker", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const targetSeq = record["target_seq"];
  const pinned = record["pinned"];
  const muted = record["muted"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof targetSeq !== "number" || !Number.isInteger(targetSeq) || targetSeq < 0) {
    throw new Error("target_seq 必须是非负整数");
  }
  if (pinned !== undefined && typeof pinned !== "boolean") throw new Error("pinned 必须是布尔值");
  if (muted !== undefined && typeof muted !== "boolean") throw new Error("muted 必须是布尔值");
  if (pinned === undefined && muted === undefined) throw new Error("pinned 或 muted 必填");
  const rt = await agentRuntime();
  await rt.sessions.resume({ session_id: sessionId });
  const session = rt.sessions.sessionServiceFor(sessionId);
  const target = session.events().find((event) => event.seq === targetSeq);
  if (target === undefined || target.type !== "user/message") throw new Error("只能标记用户提问所在的轮次");
  assertSessionIdle(session);
  session.append({
    type: "context/turn-marker",
    data: {
      targetSeq,
      ...(pinned === undefined ? {} : { pinned }),
      ...(muted === undefined ? {} : { muted }),
    },
  });
  await ensureSessionWatch(sessionId);
  pushToRenderer("lcode:session.changed", { session_id: sessionId });
  return { target_seq: targetSeq, pinned: pinned === true, muted: muted === true };
});

function assertSessionIdle(session: { events(): readonly { readonly type: string }[] }): void {
  const boundary = [...session.events()].reverse().find((event) => event.type === "turn/start" || event.type === "turn/end");
  if (boundary?.type === "turn/start") throw new Error("这一轮还在执行，先暂停再调整上下文");
}

interface GitInfo {
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly mode: "local" | "worktree";
}

interface GitStatusResult extends GitInfo {
  readonly files: readonly ParsedGitFile[];
  readonly total: number;
  readonly truncated: boolean;
}

const GIT_STATUS_LIMIT = 300;

async function gitRun(workspace: string, args: readonly string[], timeoutMs = 4_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspace, ...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function gitErrorMessage(error: unknown, fallback: string): string {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const stderr = typeof record["stderr"] === "string" ? record["stderr"].trim() : "";
  if (stderr !== "") return stderr.slice(0, 1_000);
  if (error instanceof Error && error.message !== "") return error.message.slice(0, 1_000);
  return fallback;
}

/**
 * 输入框状态栏用：工作区是不是 Git 仓库、当前分支、是否 linked worktree。
 * 只读命令、2s 超时；不是仓库/没装 git 都回 local，不把 UI 卡住。
 */
ipcMain.handle("lcode:workspace.gitInfo", async (_e: IpcMainInvokeEvent, workspace: unknown) => {
  if (typeof workspace !== "string" || workspace === "") return { isRepo: false, branch: null, mode: "local" };
  return await workspaceGitInfo(workspace);
});

async function workspaceGitInfo(workspace: string): Promise<GitInfo> {
  try {
    if ((await gitRun(workspace, ["rev-parse", "--is-inside-work-tree"], 2_000)).trim() !== "true") {
      return { isRepo: false, branch: null, mode: "local" };
    }
    let branch = (await gitRun(workspace, ["rev-parse", "--abbrev-ref", "HEAD"], 2_000)).trim();
    if (branch === "HEAD") branch = (await gitRun(workspace, ["rev-parse", "--short", "HEAD"], 2_000)).trim();
    const gitDir = (await gitRun(workspace, ["rev-parse", "--git-dir"], 2_000)).trim();
    const commonDir = (await gitRun(workspace, ["rev-parse", "--git-common-dir"], 2_000)).trim();
    const mode = resolve(workspace, gitDir) === resolve(workspace, commonDir) ? "local" : "worktree";
    return { isRepo: true, branch: branch === "" ? null : branch, mode };
  } catch {
    return { isRepo: false, branch: null, mode: "local" };
  }
}

async function workspaceGitStatus(workspace: string): Promise<GitStatusResult> {
  const info = await workspaceGitInfo(workspace);
  if (!info.isRepo) return { ...info, files: [], total: 0, truncated: false };
  let statusZ: string;
  let stagedZ: string;
  let unstagedZ: string;
  try {
    [statusZ, stagedZ, unstagedZ] = await Promise.all([
      gitRun(workspace, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], 6_000),
      gitRun(workspace, ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"], 6_000),
      gitRun(workspace, ["-c", "core.fsmonitor=false", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--numstat", "-z"], 6_000),
    ]);
  } catch (error) {
    throw new Error(`读取 Git 状态失败：${gitErrorMessage(error, "git status 失败")}`);
  }
  const all = mergeGitNumstat(parseGitStatusZ(statusZ), parseGitNumstatZ(stagedZ), parseGitNumstatZ(unstagedZ));
  return {
    ...info,
    files: all.slice(0, GIT_STATUS_LIMIT),
    total: all.length,
    truncated: all.length > GIT_STATUS_LIMIT,
  };
}

async function workspaceGitBranches(workspace: string): Promise<{ branches: readonly string[]; current: string | null }> {
  const info = await workspaceGitInfo(workspace);
  if (!info.isRepo) return { branches: [], current: null };
  try {
    const output = await gitRun(workspace, ["for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads"]);
    const branches = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    return { branches, current: info.branch };
  } catch (error) {
    throw new Error(`读取 Git 分支失败：${gitErrorMessage(error, "git for-each-ref 失败")}`);
  }
}

async function workspaceGitSwitch(
  workspace: string,
  branch: string,
  allowDirty: boolean,
): Promise<{ ok: true; info: GitInfo } | { ok: false; code: "dirty"; files: readonly ParsedGitFile[]; total: number }> {
  const info = await workspaceGitInfo(workspace);
  if (!info.isRepo) throw new Error("当前工作区不是 Git 仓库");
  const branches = await workspaceGitBranches(workspace);
  if (!branches.branches.includes(branch)) throw new Error(`本地没有这个分支：${branch}`);
  if (info.branch === branch) return { ok: true, info };
  if (!allowDirty) {
    const status = await workspaceGitStatus(workspace);
    if (status.files.length > 0) return { ok: false, code: "dirty", files: status.files, total: status.total };
  }
  try {
    await gitRun(workspace, ["switch", branch], 15_000);
  } catch (error) {
    throw new Error(gitErrorMessage(error, "切换分支失败"));
  }
  return { ok: true, info: await workspaceGitInfo(workspace) };
}

const GIT_DIFF_MAX_LINES = 2_000;
const GIT_UNTRACKED_MAX_BYTES = 512 * 1024;

interface GitDiffLine {
  readonly kind: "context" | "add" | "delete" | "meta";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

interface GitDiffPart {
  readonly staged: boolean;
  readonly binary: boolean;
  readonly lines: readonly GitDiffLine[];
  readonly truncated: boolean;
}

interface GitDiffResult {
  readonly path: string;
  readonly untracked: boolean;
  readonly parts: readonly GitDiffPart[];
}

function parseUnifiedDiff(output: string): Omit<GitDiffPart, "staged"> {
  const rawLines = output.split(/\r?\n/);
  const lines: GitDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let binary = false;
  let truncated = false;
  let inHunk = false;
  for (const raw of rawLines) {
    if (lines.length >= GIT_DIFF_MAX_LINES) {
      truncated = true;
      break;
    }
    if (raw.startsWith("diff --git ") || raw.startsWith("index ")) continue;
    if (!inHunk && (raw.startsWith("--- ") || raw.startsWith("+++ "))) continue;
    if (raw.startsWith("new file mode ") || raw.startsWith("deleted file mode ") || raw.startsWith("old mode ") || raw.startsWith("new mode ") || raw.startsWith("similarity index ")) continue;
    if (raw.startsWith("rename from ") || raw.startsWith("rename to ")) continue;
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", oldLine: null, newLine: newLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "delete", oldLine: oldLine++, newLine: null, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith(" ")) {
      lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) });
      continue;
    }
    if (raw === "") continue;
    lines.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
  }
  return { binary, lines, truncated };
}

function untrackedDiff(workspace: string, path: string): Omit<GitDiffPart, "staged"> {
  const target = resolve(workspace, path);
  let buffer: Buffer;
  try {
    buffer = readFileSync(target);
  } catch (error) {
    throw new Error(`读取未跟踪文件失败：${gitErrorMessage(error, path)}`);
  }
  const truncatedBytes = buffer.length > GIT_UNTRACKED_MAX_BYTES;
  const slice = buffer.subarray(0, GIT_UNTRACKED_MAX_BYTES);
  if (slice.includes(0)) return { binary: true, lines: [], truncated: truncatedBytes };
  const text = new TextDecoder().decode(slice).replace(/\n$/, "");
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const truncatedLines = lines.length > GIT_DIFF_MAX_LINES;
  return {
    binary: false,
    lines: lines.slice(0, GIT_DIFF_MAX_LINES).map((line, index) => ({ kind: "add" as const, oldLine: null, newLine: index + 1, text: line })),
    truncated: truncatedBytes || truncatedLines,
  };
}

async function workspaceGitDiff(
  workspace: string,
  input: { readonly path: string; readonly oldPath?: string | undefined; readonly staged: boolean; readonly unstaged: boolean; readonly untracked: boolean },
): Promise<GitDiffResult> {
  const info = await workspaceGitInfo(workspace);
  if (!info.isRepo) throw new Error("当前工作区不是 Git 仓库");
  const root = resolve(workspace);
  const target = resolve(root, input.path);
  const relTarget = relative(root, target);
  if (relTarget === "" || relTarget.startsWith("..") || isAbsolute(relTarget)) {
    throw new Error("文件路径必须位于当前工作区内");
  }
  const path = relTarget.replace(/\\/g, "/");
  const paths = [path];
  if (typeof input.oldPath === "string" && input.oldPath !== "") {
    const oldTarget = resolve(root, input.oldPath);
    const oldRelative = relative(root, oldTarget);
    if (oldRelative !== "" && !oldRelative.startsWith("..") && !isAbsolute(oldRelative)) {
      paths.unshift(oldRelative.replace(/\\/g, "/"));
    }
  }

  if (input.untracked) {
    return { path, untracked: true, parts: [{ staged: false, ...untrackedDiff(root, path) }] };
  }

  const parts: GitDiffPart[] = [];
  const readPart = async (staged: boolean): Promise<void> => {
    const args = [
      "-c", "core.fsmonitor=false",
      "diff",
      ...(staged ? ["--cached"] : []),
      "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3",
      "--", ...paths,
    ];
    let output: string;
    try {
      output = await gitRun(workspace, args, 8_000);
    } catch (error) {
      throw new Error(`读取文件 diff 失败：${gitErrorMessage(error, path)}`);
    }
    parts.push({ staged, ...parseUnifiedDiff(output) });
  };
  if (input.staged) await readPart(true);
  if (input.unstaged) await readPart(false);
  return { path, untracked: false, parts };
}

ipcMain.handle("lcode:workspace.gitDiff", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  const path = record["path"];
  const oldPath = record["oldPath"];
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  if (typeof path !== "string" || path === "") throw new Error("path 必填");
  return await workspaceGitDiff(workspace, {
    path,
    ...(typeof oldPath === "string" && oldPath !== "" ? { oldPath } : {}),
    staged: record["staged"] === true,
    unstaged: record["unstaged"] === true,
    untracked: record["untracked"] === true,
  });
});

ipcMain.handle("lcode:workspace.gitStatus", async (_e: IpcMainInvokeEvent, workspace: unknown) => {
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  return await workspaceGitStatus(workspace);
});

ipcMain.handle("lcode:workspace.gitBranches", async (_e: IpcMainInvokeEvent, workspace: unknown) => {
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  return await workspaceGitBranches(workspace);
});

ipcMain.handle("lcode:workspace.gitSwitch", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  const branch = record["branch"];
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  if (typeof branch !== "string" || branch === "") throw new Error("branch 必填");
  const rt = await agentRuntime();
  if (!rt.ctx.get("workspaceTrust").isTrusted(workspace)) {
    throw new Error("工作区尚未信任，先信任此文件夹再切换分支");
  }
  return await workspaceGitSwitch(workspace, branch, record["allowDirty"] === true);
});

// ─────────────── 工作区文件树（右侧「文件」面板） ───────────────
//
// Git 仓库用 `git ls-files -co --exclude-standard` 拿「已跟踪 + 未忽略的未跟踪文件」，
// 由 git 自己解释 .gitignore，避免在主进程重写一套匹配规则；不是仓库（或 git 失败）
// 时退化为目录遍历，只过滤 .git / node_modules 这类明确不该进的目录。
const WORKSPACE_TREE_LIMIT = 20_000;
const WORKSPACE_WALK_LIMIT = 5_000;
const WORKSPACE_WALK_DEPTH = 16;
const FILE_PREVIEW_MAX_BYTES = 256 * 1024;

interface WorkspaceTreeResult {
  readonly entries: readonly string[];
  readonly truncated: boolean;
  readonly isRepo: boolean;
}

interface FilePreviewResult {
  readonly path: string;
  readonly size: number;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly text: string;
}

function splitNullList(output: string): string[] {
  return output.split("\0").filter((item) => item !== "");
}

async function workspaceTree(workspace: string): Promise<WorkspaceTreeResult> {
  const root = resolve(workspace);
  let stat: Stats;
  try {
    stat = statSync(root);
  } catch {
    throw new Error("工作区目录不存在");
  }
  if (!stat.isDirectory()) throw new Error("工作区不是目录");

  const info = await workspaceGitInfo(root);
  if (info.isRepo) {
    try {
      const [listed, deleted] = await Promise.all([
        gitRun(root, ["-c", "core.fsmonitor=false", "ls-files", "-c", "-o", "--exclude-standard", "-z"], 8_000),
        gitRun(root, ["-c", "core.fsmonitor=false", "ls-files", "--deleted", "-z"], 8_000).catch(() => ""),
      ]);
      const gone = new Set(splitNullList(deleted));
      const seen = new Set<string>();
      const entries: string[] = [];
      for (const path of splitNullList(listed)) {
        if (gone.has(path) || seen.has(path)) continue;
        seen.add(path);
        entries.push(path);
      }
      entries.sort();
      return { entries: entries.slice(0, WORKSPACE_TREE_LIMIT), truncated: entries.length > WORKSPACE_TREE_LIMIT, isRepo: true };
    } catch {
      // git 不可用（超大仓库、损坏索引）时退化为目录遍历，别让面板直接空掉
    }
  }

  const entries: string[] = [];
  let truncated = false;
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (truncated || depth > WORKSPACE_WALK_DEPTH) return;
    let items: Dirent[];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (entries.length >= WORKSPACE_WALK_LIMIT) {
        truncated = true;
        return;
      }
      const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
      if (item.isFile()) {
        entries.push(rel);
      } else if (item.isDirectory() && item.name !== ".git" && item.name !== "node_modules") {
        walk(join(dir, item.name), rel, depth + 1);
      }
    }
  };
  walk(root, "", 0);
  return { entries, truncated, isRepo: false };
}

async function workspaceReadFile(workspace: string, inputPath: string): Promise<FilePreviewResult> {
  const root = resolve(workspace);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new Error("工作区目录不存在");
  }
  const target = resolve(root, inputPath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("文件路径必须位于当前工作区内");
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error("文件不存在或无法读取");
  }
  // 符号链接可能指向工作区之外：只读预览也按真实路径再校验一次
  const relReal = relative(rootReal, real);
  if (relReal.startsWith("..") || isAbsolute(relReal)) throw new Error("文件路径必须位于当前工作区内");

  let stat: Stats;
  try {
    stat = statSync(real);
  } catch {
    throw new Error("文件不存在或无法读取");
  }
  if (!stat.isFile()) throw new Error("只能预览普通文件");

  const fd = openSync(real, "r");
  try {
    const length = Math.min(stat.size, FILE_PREVIEW_MAX_BYTES + 1);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    const slice = buffer.subarray(0, read);
    const previewPath = rel.replace(/\\/g, "/");
    if (slice.includes(0)) return { path: previewPath, size: stat.size, binary: true, truncated: false, text: "" };
    const truncated = stat.size > FILE_PREVIEW_MAX_BYTES;
    const text = new TextDecoder().decode(truncated ? slice.subarray(0, FILE_PREVIEW_MAX_BYTES) : slice);
    return { path: previewPath, size: stat.size, binary: false, truncated, text };
  } finally {
    closeSync(fd);
  }
}

ipcMain.handle("lcode:workspace.tree", async (_e: IpcMainInvokeEvent, workspace: unknown) => {
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  return await workspaceTree(workspace);
});

ipcMain.handle("lcode:workspace.readFile", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const workspace = record["workspace"];
  const path = record["path"];
  if (typeof workspace !== "string" || workspace === "") throw new Error("workspace 必填");
  if (typeof path !== "string" || path === "") throw new Error("path 必填");
  return await workspaceReadFile(workspace, path);
});

// ─────────────── 活动任务（P3-04） ───────────────
//
// jobs / terminals 是本桌面主进程的内存资源，不是会话日志的一部分。渲染进程只能按
// session 取当前活体 agent，主进程据此注入 owner，绝不采信 renderer 声称的 agent id。
function taskInput(input: unknown, idField?: "job_id" | "terminal_id"): {
  readonly sessionId: string;
  readonly resourceId?: string;
  readonly sinceOffset?: number;
} {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  const resourceId = idField === undefined ? undefined : record[idField];
  if (idField !== undefined && (typeof resourceId !== "string" || resourceId === "")) {
    throw new Error(`${idField} 必填`);
  }
  const sinceOffset = record["since_offset"];
  if (sinceOffset !== undefined && (typeof sinceOffset !== "number" || !Number.isInteger(sinceOffset) || sinceOffset < 0)) {
    throw new Error("since_offset 必须是非负整数");
  }
  return {
    sessionId,
    ...(typeof resourceId === "string" ? { resourceId } : {}),
    ...(typeof sinceOffset === "number" ? { sinceOffset } : {}),
  };
}

async function ownerForTaskSession(rt: AgentRuntime, sessionId: string): Promise<string | null> {
  const found = await rt.agents.get({ session_id: sessionId });
  return found?.agent_id ?? null;
}

ipcMain.handle("lcode:tasks.list", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const { sessionId } = taskInput(input);
  const rt = await agentRuntime();
  const ownerAgentId = await ownerForTaskSession(rt, sessionId);
  if (ownerAgentId === null) {
    // 主进程重启后没有活体 agent，也就没有可以恢复的内存作业。显式回传该事实给 UI。
    return { jobs: [], terminals: [], recoverable: false };
  }
  return {
    jobs: rt.ctx.get("jobs").list({ ownerAgentId }),
    terminals: rt.ctx.get("terminals").list({ ownerAgentId }),
    recoverable: false,
  };
});

ipcMain.handle("lcode:tasks.job.read", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const { sessionId, resourceId, sinceOffset } = taskInput(input, "job_id");
  const rt = await agentRuntime();
  const ownerAgentId = await ownerForTaskSession(rt, sessionId);
  if (ownerAgentId === null) throw new Error("当前会话没有可附着的后台作业");
  return rt.ctx.get("jobs").read({
    jobId: resourceId!,
    ownerAgentId,
    ...(sinceOffset === undefined ? {} : { sinceOffset }),
  });
});

ipcMain.handle("lcode:tasks.job.kill", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const { sessionId, resourceId } = taskInput(input, "job_id");
  const rt = await agentRuntime();
  const ownerAgentId = await ownerForTaskSession(rt, sessionId);
  if (ownerAgentId === null) throw new Error("当前会话没有可附着的后台作业");
  return rt.ctx.get("jobs").kill({ jobId: resourceId!, ownerAgentId });
});

ipcMain.handle("lcode:tasks.terminal.read", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const { sessionId, resourceId, sinceOffset } = taskInput(input, "terminal_id");
  const rt = await agentRuntime();
  const ownerAgentId = await ownerForTaskSession(rt, sessionId);
  if (ownerAgentId === null) throw new Error("当前会话没有可附着的终端");
  return rt.ctx.get("terminals").read({
    terminalId: resourceId!,
    ownerAgentId,
    ...(sinceOffset === undefined ? {} : { sinceOffset }),
  });
});

ipcMain.handle("lcode:tasks.terminal.close", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const { sessionId, resourceId } = taskInput(input, "terminal_id");
  const rt = await agentRuntime();
  const ownerAgentId = await ownerForTaskSession(rt, sessionId);
  if (ownerAgentId === null) throw new Error("当前会话没有可附着的终端");
  return rt.ctx.get("terminals").close({ terminalId: resourceId!, ownerAgentId });
});

/**
 * `agents.send`：提交一句话。
 *
 * **只返回入队回执**（21 §2.2）——本轮结果走事件流。
 * 额外把 `agent_id` 一起回给渲染层，省得它再查一次 `agents.get`。
 */
/**
 * 让渲染层知道**这一轮失败了**（以及失败原因）。
 *
 * ## 为什么需要它
 *
 * `agents.followup` 只返回入队回执（21 §2.2），本轮结果走事件流。而当轮内抛错时，
 * 引擎的收尾是 `turn/end {reason:'error'}` —— **一个不带任何原因的终态**。
 * 拒绝的 Promise 落在 `enqueue` 的 settle 空实现上（那是刻意的：`enqueue` 是同步入队，
 * 没有等待者）。于是界面上看到的是：用户消息在、回复空白、没有报错、也没有 spinner。
 *
 * 实测踩过：配了一个没有密钥的云端供应商，模型名与地址都对，但整轮就是静静失败。
 * 从"点了发送"到"什么都没发生"之间没有任何线索指向"缺 API Key"。
 *
 * 这里在**主进程侧**兜住它并把原因推给界面——渲染层拿不到那个被吞掉的 Promise。
 */
function watchTurnFailure(sessionId: string): void {
  if (turnFailureWatch.has(sessionId)) return;
  void (async () => {
    const rt = await agentRuntime();
    const found = await rt.agents.get({ session_id: sessionId });
    if (found === null) return;
    const session = rt.sessions.sessionServiceFor(sessionId);
    const stop = rt.agents
      .watch({ agent_id: found.agent_id })
      .subscribe((state) => {
        if (state.status !== "idle") return;
        // 本轮是否为失败：看日志里**最后一条** turn/end
        const last = [...session.events()]
          .reverse()
          .find((e) => e.type === "turn/end");
        if (last?.type !== "turn/end" || last.data.reason !== "error") return;
        // 同一个失败轮不重复推（idle 可能因为别的输入再次触发）
        if (reportedTurnErrors.get(sessionId) === last.seq) return;
        reportedTurnErrors.set(sessionId, last.seq);
        // **只推事实，不推文案**：用户可读的话由渲染层的 i18n 词典给
        //（主进程里写死中文会让英文界面弹出中文提示）
        pushToRenderer("lcode:session.turnFailed", { session_id: sessionId });
      });
    turnFailureWatch.set(sessionId, stop);
  })();
}

ipcMain.handle("lcode:skills.list", async () => {
  const rt = await agentRuntime();
  return await rt.skills.catalog();
});

ipcMain.handle("lcode:skills.import", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const path = (input as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || path.trim() === "") throw new Error("技能文件 path 必填");
  const rt = await agentRuntime();
  return { imported: importSkill({ home: rt.services.home, path }) };
});

ipcMain.handle("lcode:skills.remove", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const id = (input as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.trim() === "") throw new Error("技能 id 必填");
  const rt = await agentRuntime();
  const found = (await rt.skills.catalog()).find((entry) => entry.id === id);
  if (found?.source !== "user") throw new Error("只能删除用户技能");
  removeUserSkill({ home: rt.services.home, id });
  return { removed: true, id };
});

ipcMain.handle(
  "lcode:agent.send",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const text = typeof record["text"] === "string" ? record["text"] : "";
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    if (text.trim() === "" && !Array.isArray(record["images"]))
      throw new Error("text 必填");

    const rt = await agentRuntime();
    /*
     * `agents.resume`，**不是 `agents.create`**。
     *
     * 按 D17，agent id 就是 session id，所以同一个会话第二次说话时 `create` 会撞上
     * `EC-CONFLICT`（"agent 已存在"）——第一句能发、第二句就报错，正是这个原因。
     * `resume` 才是幂等的那个：已存在就返回同一个句柄（连引擎也复用，见 `attach`）。
     *
     * 这里踩过：我原来按"create 按 session_id 幂等复用"的误解写了 `create`，
     * 而那句话是错的——幂等的是 `resume`。
     */
    const { agent_id } = await rt.agents.resume({ session_id: sessionId });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);
    let receipt: Awaited<ReturnType<typeof rt.agents.followup>>;
    try {
      receipt = await rt.agents.followup({
        agent_id,
        content: await buildUserContent({ text, skills: record["skills"], images: record["images"], attachments: record["attachments"], skillsService: rt.skills, attachmentStore: attachmentWriter(rt.services.home) }),
      });
    } catch (err) {
      /*
       * **入队前**的拒绝（`EL-NO_MODEL_CONFIGURED` 这一类）。
       *
       * 它和"轮内失败"是两条不同的路：这里是同步拒绝，`invoke` 会把错误原样抛回渲染层
       * （所以那边本来就有反馈）；而轮内失败是被吞掉的（见 `watchTurnFailure`）。
       * 两条路都补上，才不会有"某些失败有提示、某些没有"这种最难复现的形态。
       */
      pushToRenderer("lcode:session.turnFailed", { session_id: sessionId });
      throw err;
    }
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return { ...receipt, agent_id };
  },
);

ipcMain.handle(
  "lcode:session.rewindSend",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const toSeq = record["to_seq"];
    const text = typeof record["text"] === "string" ? record["text"] : "";
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    if (typeof toSeq !== "number" || !Number.isInteger(toSeq) || toSeq < 0)
      throw new Error("to_seq 非法");
    if (text.trim() === "" && !Array.isArray(record["images"]))
      throw new Error("text 必填");

    const rt = await agentRuntime();
    const events = rt.sessions.sessionServiceFor(sessionId).events();

    /*
     * 只允许撤回**最后一条**用户消息。更早的轮次后面还压着别的记录，
     * 删掉它们不是"重新编辑这句话"，而是静默丢弃后续对话。
     */
    const lastUser = [...events].reverse().find((event) => event.type === "user/message");
    if (lastUser?.seq !== toSeq) throw new Error("只能重新编辑最新一条提问");
    if (events[toSeq]?.type !== "user/message") throw new Error("回退目标不是用户消息");

    const boundary = [...events]
      .reverse()
      .find((event) => event.type === "turn/start" || event.type === "turn/end");
    if (boundary?.type === "turn/start") throw new Error("这一轮还在执行，先暂停再编辑");

    // 这一轮改过哪些文件（没有检查点可回退时，用来告诉用户/模型哪些改动没撤销）
    const changedPaths = new Set<string>();
    for (const event of events.slice(toSeq)) {
      if (event.type !== "tool/result") continue;
      const meta = event.data.meta as unknown as { changes?: unknown } | undefined;
      const changes = meta?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const path = (change as { path?: unknown }).path;
        if (typeof path === "string" && path !== "") changedPaths.add(path);
      }
    }

    /*
     * ① 先截断权威日志，再回退文件。
     *
     * 顺序反过来（先回退文件）的问题是：回退会追加 `checkpoint/restored`，而截断失败时
     * 工作区已经被改写、日志却还留着那一轮——用户看到"记录还在，文件却变了"。
     * 先截断则最坏情况是"记录已撤回、文件没退成"，后者仍可继续（下面会告诉模型/用户）。
     */
    const rewound = await rt.sessions.rewind({ session_id: sessionId, to_seq: toSeq });

    /*
     * ② 文件回退：退到"这一轮开始之前"= 上一个已闭合轮的检查点。
     *
     * 只有 `endSeq < toSeq` 的检查点才可能早于本轮；它可能不完整（二进制/超大/
     * 符号链接文件从来没备份），此时 `allowPartial` 让能回退的照常回退，
     * 碰不得的原样留在磁盘上并如实报出来——绝不为了"删干净"去做无备份删除。
     */
    const workspaceRoot = rt.sessions.workspaceOf(sessionId);
    const prior = [...(await rt.checkpoints.list(sessionId))]
      .reverse()
      .find((entry) => entry.endSeq < toSeq);
    let restoredPaths: string[] = [];
    let removedPaths: string[] = [];
    let unrestoredPaths: string[] = [];
    if (workspaceRoot !== undefined && prior !== undefined) {
      try {
        const restored = await rt.checkpoints.restore({
          sessionId,
          workspaceRoot,
          session: rt.sessions.sessionServiceFor(sessionId),
          checkpointId: prior.checkpointId,
          allowPartial: true,
        });
        restoredPaths = [...restored.restoredPaths];
        removedPaths = [...restored.removedPaths];
        unrestoredPaths = [...restored.unrestoredPaths];
      } catch {
        // 备份本身坏了/读不出来：文件一个都没动，全部算"无法回退"
        unrestoredPaths = [...changedPaths].sort();
      }
    } else if (workspaceRoot !== undefined && changedPaths.size > 0) {
      // 第一轮就没有"修改前"的快照：没有依据把文件写回去，只能交给模型重新生成
      unrestoredPaths = [...changedPaths].sort();
    }
    // 被撤回那一轮的检查点不能再参与"最新状态"计算，否则下一次 capture 会继承已撤回的改动
    await rt.checkpoints.discardFrom(sessionId, toSeq);

    rt.sessions.sessionServiceFor(sessionId).append({
      type: "session/rewound",
      data: {
        toSeq,
        discarded: rewound.discarded,
        restoredPaths,
        removedPaths,
        unrestoredPaths,
      },
    });

    /*
     * ③ 订阅换到新的内存镜像上。
     *
     * `rewind` 换掉了整只 store，而 `ensureSessionWatch` 的撤销器绑的是**旧 store**；
     * 不重订的话，新轮的事件一条也到不了界面（表现为"点了重发，界面纹丝不动"）。
     */
    sessionWatch.get(sessionId)?.();
    sessionWatch.delete(sessionId);
    turnFailureWatch.get(sessionId)?.();
    turnFailureWatch.delete(sessionId);
    reportedTurnErrors.delete(sessionId);

    const { agent_id } = await rt.agents.resume({ session_id: sessionId });
    // 旧轮遗留的待发送消息属于被撤回的那一轮，清掉再重发
    await rt.agents.clearQueued({ agent_id });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);

    /*
     * 无法回退的文件交给模型处理：注入一段**只进本轮上下文**的宿主提示
     * （经 systemPrompt 的 injected_* 变量进入请求），让它在回复里说清楚
     * 哪些改动没撤销、并把需要的内容重新生成出来。
     */
    if (unrestoredPaths.length > 0) {
      await rt.agents.inject({
        agent_id,
        content: [{ type: "text", text: rewindNotice(unrestoredPaths) }],
      });
    }

    const receipt = await rt.agents.followup({
      agent_id,
      content: await buildUserContent({ text, skills: record["skills"], images: record["images"], attachments: record["attachments"], skillsService: rt.skills, attachmentStore: attachmentWriter(rt.services.home) }),
    });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return {
      ...receipt,
      agent_id,
      rewind: { ...rewound, restored: restoredPaths, removed: removedPaths, unrestored: unrestoredPaths },
    };
  },
);

/**
 * 重试最后一轮：只在“这一轮没有调用过工具”时允许。
 *
 * 没有工具调用 = 没有文件副作用，可以直接把日志截回本轮之前再用原提问重发，
 * 不必回退文件。这能清掉模型刚才那次错误/拒绝的回答，而不是让它在下一轮继续参考。
 */
ipcMain.handle(
  "lcode:session.retryTurn",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");

    const rt = await agentRuntime();
    const session = rt.sessions.sessionServiceFor(sessionId);
    const events = session.events();

    let end = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "turn/end") {
        end = index;
        break;
      }
    }
    if (end < 0) throw new Error("没有可重试的已完成回合");
    let start = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "turn/start") {
        start = index;
        break;
      }
    }
    if (start < 0) throw new Error("找不到这一轮的起点");
    const turnEvents = events.slice(start, end + 1);
    if (turnEvents.some((event) => event.type === "tool/call")) {
      throw new Error("这一轮执行过工具，不能直接重试；请用编辑重发");
    }
    const user = turnEvents.find((event) => event.type === "user/message");
    if (user === undefined) throw new Error("这一轮没有用户消息");
    if (turnEvents.filter((event) => event.type === "user/message").length > 1) {
      throw new Error("这一轮有中途插话，暂不支持直接重试");
    }
    const content = user.data.content;

    const rewound = await rt.sessions.rewind({ session_id: sessionId, to_seq: user.seq });
    await rt.checkpoints.discardFrom(sessionId, user.seq);
    rt.sessions.sessionServiceFor(sessionId).append({
      type: "session/rewound",
      data: { toSeq: user.seq, discarded: rewound.discarded, restoredPaths: [], removedPaths: [], unrestoredPaths: [] },
    });

    // rewind 换了 store：旧订阅绑定旧 store，必须重新订阅（与编辑重发同一处理）
    sessionWatch.get(sessionId)?.();
    sessionWatch.delete(sessionId);
    turnFailureWatch.get(sessionId)?.();
    turnFailureWatch.delete(sessionId);
    reportedTurnErrors.delete(sessionId);

    const { agent_id } = await rt.agents.resume({ session_id: sessionId });
    await rt.agents.clearQueued({ agent_id });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);

    const blocks: readonly ContentBlock[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    const receipt = await rt.agents.followup({ agent_id, content: blocks });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return { ...receipt, agent_id, retry: { discarded: rewound.discarded } };
  },
);

/** 回退失败时给模型的宿主提示（不进用户可见消息，只进本轮系统上下文）。 */
function rewindNotice(paths: readonly string[]): string {
  return [
    "宿主提示（不是用户的新消息）：用户撤回了上一轮任务并重写了提问，相关记录已删除。",
    "上一轮修改过、但无法自动回退的文件：",
    ...paths.map((path) => `- ${path}`),
    "如果本次任务涉及这些文件，请重新生成它们；并在最终回复里明确告知用户哪些改动没能回退。",
  ].join("\n");
}

ipcMain.handle(
  "lcode:agent.cancel",
  async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    const found = await rt.agents.get({ session_id: sessionId });
    if (found === null) return { cancelled: false };
    return rt.agents.cancel({ agent_id: found.agent_id, cause: "user" });
  },
);

ipcMain.handle(
  "lcode:agent.steer",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const text = record["text"];
    const mode = record["mode"] === "interrupt" ? "interrupt" : "soft";
    if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
    if (typeof text !== "string" || text.trim() === "") throw new Error("text 必填");

    const rt = await agentRuntime();
    const { agent_id } = await rt.agents.resume({ session_id: sessionId });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);
    try {
      await rt.agents.steer({ agent_id, content: [{ type: "text", text }], mode });
      pushToRenderer("lcode:session.changed", { session_id: sessionId });
      return { accepted: true as const, mode: mode === "interrupt" ? ("interrupted" as const) : ("steered" as const) };
    } catch (err) {
      // 用户点击时当前轮可能恰好已收尾。此时不报“插话失败”，而是按产品承诺
      // 自动降级为下一轮队首消息，保证引导不会丢失。
      if (errorCodeOf(err) !== "EC-NOT_RUNNING") throw err;
      await rt.agents.followup({ agent_id, content: [{ type: "text", text }] });
      pushToRenderer("lcode:session.changed", { session_id: sessionId });
      return { accepted: true as const, mode: "queued" as const };
    }
  },
);

ipcMain.handle("lcode:agent.queue.list", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const sessionId = (input as { session_id?: unknown } | null)?.session_id;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  const rt = await agentRuntime();
  const { agent_id } = await rt.agents.resume({ session_id: sessionId });
  return rt.agents.queued({ agent_id });
});

ipcMain.handle("lcode:agent.queue.edit", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const queueId = record["queue_id"];
  const text = record["text"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof queueId !== "string" || queueId === "") throw new Error("queue_id 必填");
  if (typeof text !== "string" || text.trim() === "") throw new Error("text 必填");
  const rt = await agentRuntime();
  const { agent_id } = await rt.agents.resume({ session_id: sessionId });
  return rt.agents.editQueued({ agent_id, queue_id: queueId, content: [{ type: "text", text }] });
});

ipcMain.handle("lcode:agent.queue.remove", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const queueId = record["queue_id"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof queueId !== "string" || queueId === "") throw new Error("queue_id 必填");
  const rt = await agentRuntime();
  const { agent_id } = await rt.agents.resume({ session_id: sessionId });
  return rt.agents.removeQueued({ agent_id, queue_id: queueId });
});

ipcMain.handle("lcode:agent.queue.clear", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const sessionId = (input as { session_id?: unknown } | null)?.session_id;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  const rt = await agentRuntime();
  const { agent_id } = await rt.agents.resume({ session_id: sessionId });
  return rt.agents.clearQueued({ agent_id });
});

ipcMain.handle("lcode:agent.queue.guide", async (_e: IpcMainInvokeEvent, input: unknown) => {
  const record = (input ?? {}) as Record<string, unknown>;
  const sessionId = record["session_id"];
  const queueId = record["queue_id"];
  const mode = record["mode"] === "interrupt" ? "interrupt" : "soft";
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof queueId !== "string" || queueId === "") throw new Error("queue_id 必填");
  const rt = await agentRuntime();
  const { agent_id } = await rt.agents.resume({ session_id: sessionId });
  const result = await rt.agents.guideQueued({ agent_id, queue_id: queueId, mode });
  if (result.guided) pushToRenderer("lcode:session.changed", { session_id: sessionId });
  return result;
});

ipcMain.handle(
  "lcode:agent.resume",
  async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    const found = await rt.agents.get({ session_id: sessionId });
    if (found === null) return { resumed: false };
    return rt.agents.resumeTurn({ agent_id: found.agent_id });
  },
);

// ─────────────── 计划模式（P4-01；会话级事件，renderer 不可自行声明状态） ───────────────

ipcMain.handle(
  "lcode:plan.enter",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const sessionId = (input as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    rt.ctx.get("planMode").enter(sessionId);
    return { active: true };
  },
);

ipcMain.handle(
  "lcode:plan.cancel",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const sessionId = (input as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    rt.ctx.get("planMode").cancel(sessionId);
    return { active: false };
  },
);

ipcMain.handle(
  "lcode:plan.confirm",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const sessionId = (input as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    const rt = await agentRuntime();
    const approved = rt.ctx.get("planMode").confirm(sessionId);
    const { agent_id } = await rt.agents.resume({ session_id: sessionId });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);
    const receipt = await rt.agents.followup({
      agent_id,
      content: [{ type: "text", text: approved.executionPrompt }],
    });
    pushToRenderer("lcode:session.changed", { session_id: sessionId });
    return { active: false, proposed_seq: approved.proposedSeq, ...receipt };
  },
);

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// ─────────────── 审批（12 §5；21 §2.4） ───────────────

/**
 * 用户对审批卡的回答。
 *
 * **二次应答同一个 callId 报错**（21 §2.4 的 `EC-CONFLICT`）：一次审批只管一次
 * （12 §5.1）。允许它改答案会让"用户在看到后果之后改口"变成可能，而那时
 * 副作用可能已经发生了。
 */
ipcMain.handle(
  "lcode:approval.answer",
  (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const callId = record["callId"];
    const result = record["result"];
    if (typeof callId !== "string" || callId === "")
      throw new Error("callId 必填");
    if (!isApprovalResult(result))
      throw new Error("result 必须是 allowed-once / rejected / cancelled 之一");

    const pending = pendingApprovals.get(callId);
    if (pending === undefined) {
      // 已经答过（或那一轮早已结束）。显式报错好过静默吞掉——静默会让"点了没反应"
      // 变得无法排查，而这条路径本就该只有一次。
      throw new Error(`这个审批问题已经结束了：${callId}`);
    }
    pendingApprovals.delete(callId);
    pending.resolve(result);
    return { accepted: true };
  },
);

/** 当前挂着的审批问题（幂等；窗口刷新后据此恢复弹窗） */
ipcMain.handle("lcode:approval.pending", () => [...pendingApprovals.values()].map(({ request }) => request));

function isApprovalResult(value: unknown): value is ApprovalResult {
  return (
    value === "allowed-once" || value === "rejected" || value === "cancelled"
  );
}

interface SaveInput {
  readonly label: string;
  /** 真正发给服务端的模型 id（可缺省 → 回落到 label） */
  readonly model: string;
  readonly base_url: string;
  readonly api_key: string;
  readonly protocol?: "openai" | "anthropic";
  readonly billing_type?: "token-plan" | "coding-plan" | "pay-as-you-go";
  readonly provider_preset?: string;
  readonly context_window_in?: number;
  readonly context_window_max?: number;
  readonly context_window_out?: number;
}

/** 收窄渲染层传来的形状（**渲染进程是不受信的**，21 §1.1 边界②） */
function parseSaveInput(input: unknown): SaveInput {
  if (typeof input !== "object" || input === null)
    throw new Error("输入必须是对象");
  const record = input as Record<string, unknown>;
  const label = record["label"];
  const model = record["model"];
  const baseUrl = record["base_url"] ?? record["baseUrl"];
  const apiKey = record["api_key"] ?? record["apiKey"] ?? "";
  if (typeof label !== "string" || label.trim() === "")
    throw new Error("label 必填");
  if (typeof baseUrl !== "string" || baseUrl.trim() === "")
    throw new Error("base_url 必填");
  if (typeof apiKey !== "string") throw new Error("api_key 必须是字符串");
  // model 可缺省（老 UI / "显示名就是模型 id"的情形）→ 回落 label。
  // **非空校验不在这里**：权威那一处是 CustomModelStore.validate，
  // 这里再写一遍会出现两套规则互相追不上的情况。
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  const windowIn = parsePositiveInteger(record["context_window_in"]);
  const windowMax = parsePositiveInteger(record["context_window_max"]);
  const windowOut = parsePositiveInteger(record["context_window_out"]);
  const protocol = record["protocol"] === "anthropic" ? "anthropic" : "openai";
  const billing = record["billing_type"];
  const providerPreset = record["provider_preset"];
  return {
    label: label.trim(),
    model: trimmedModel === "" ? label.trim() : trimmedModel,
    base_url: baseUrl.trim(),
    api_key: apiKey,
    protocol,
    ...(billing === "token-plan" || billing === "coding-plan" || billing === "pay-as-you-go" ? { billing_type: billing } : {}),
    ...(typeof providerPreset === "string" && providerPreset.trim() !== "" ? { provider_preset: providerPreset.trim() } : {}),
    ...(windowIn === undefined ? {} : { context_window_in: windowIn }),
    ...(windowMax === undefined ? {} : { context_window_max: windowMax }),
    ...(windowOut === undefined ? {} : { context_window_out: windowOut }),
  };
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function parseProbeInput(input: unknown): { provider: string; model?: string } {
  if (typeof input !== "object" || input === null)
    throw new Error("输入必须是对象");
  const record = input as Record<string, unknown>;
  const provider = record["provider"];
  if (typeof provider !== "string" || provider === "")
    throw new Error("provider 必填");
  const model = record["model"];
  return {
    provider,
    ...(typeof model === "string" && model !== "" ? { model } : {}),
  };
}

/**
 * `setDefault` 专用收窄。
 *
 * **不复用 `parseProbeInput`**：那个是给 probe 用的，`model` 是**可选**的（不带就是
 * "探测这个供应商"）；而默认模型选择里 `model` 是**必填**的（空串意味着"选了但没选模型"，
 * 是 bug 不是缺省）。两者共用会把"空 model"静默丢掉，于是 `setDefault` 带着 `''` 走到
 * `assertSelection` 才报错——甚至更糟，被上层当成"没传"而回落。
 */
function parseSetDefaultInput(input: unknown): {
  provider: string;
  model: string;
} {
  if (typeof input !== "object" || input === null)
    throw new Error("输入必须是对象");
  const record = input as Record<string, unknown>;
  const provider = record["provider"];
  const model = record["model"];
  if (typeof provider !== "string" || provider === "")
    throw new Error("provider 必填");
  if (typeof model !== "string" || model === "") throw new Error("model 必填");
  return { provider, model };
}

app.whenReady().then(() => {
  createMainWindow();
  startTrashPruner();
  // 装配失败不该让窗口起不来：模型页会显示不可用，而不是整个应用打不开
  void models().catch((err: unknown) => {
    console.error("[lcode] 模型装配失败：", err);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  /*
   * 没有窗口了 → **没人能回答审批问题**。
   *
   * 必须在这里把它们清掉：内核那一轮正等在 promise 上，不清理的话它会
   * **永久挂着**（连取消都做不到，因为取消要经过同一轮的事件循环）。
   * 清成 `cancelled` 让那一轮得到一个明确的结论。
   */
  abortPendingApprovals();
  if (process.platform !== "darwin") app.quit();
});

let runtimeDisposing = false;

/**
 * 回收站后台清理：到期（7 天）的文件由主进程定时移除。
 *
 * 只在主进程里跑，不依赖用户打开设置页。间隔可用环境变量覆盖，
 * 便于验收脚本把周期压到秒级（正常运行时不需要配）。
 */
const TRASH_PRUNE_FIRST_MS = Number(process.env.LCODE_TRASH_PRUNE_FIRST_MS ?? 10_000);
const TRASH_PRUNE_INTERVAL_MS = Number(
  process.env.LCODE_TRASH_PRUNE_INTERVAL_MS ?? 60 * 60 * 1000,
);
let trashPruneFirst: NodeJS.Timeout | null = null;
let trashPruneTimer: NodeJS.Timeout | null = null;

function startTrashPruner(): void {
  const sweep = (): void => {
    if (quitting) return;
    void agentRuntime()
      .then(async (rt) => {
        const result = await rt.sessions.prune({ trash: true, cache: false });
        if (result.trash.removed > 0) {
          console.log(
            `[lcode] 回收站清理：移除 ${result.trash.removed} 项，释放 ${result.trash.freedBytes} 字节`,
          );
          // 过期回收站条目可能独占某些附件；删完再按剩余引用清理一次
          setTimeout(() => gcSessionAttachments(rt.services.home), 0);
        }
      })
      .catch((error: unknown) => {
        // 清理失败不能影响应用使用；下次周期还会再试
        console.error("[lcode] 回收站清理失败：", error);
      });
  };
  trashPruneFirst = setTimeout(sweep, TRASH_PRUNE_FIRST_MS);
  trashPruneTimer = setInterval(sweep, TRASH_PRUNE_INTERVAL_MS);
}

app.on('before-quit', (event) => {
  quitting = true;
  if (trashPruneFirst !== null) {
    clearTimeout(trashPruneFirst);
    trashPruneFirst = null;
  }
  if (trashPruneTimer !== null) {
    clearInterval(trashPruneTimer);
    trashPruneTimer = null;
  }
  if (runtime === null || runtimeDisposing) return;
  // Electron 不会等待 async 监听器。阻止这一次退出，等宿主反向释放 utility
  // process，再以无回调的 exit 收尾，避免 Windows 上留下插件 Node 子进程。
  event.preventDefault();
  runtimeDisposing = true;
  void runtime.dispose().catch((error: unknown) => {
    console.error('[lcode] 退出时释放 runtime 失败：', error);
  }).finally(() => {
    runtime = null;
    app.exit(0);
  });
});
