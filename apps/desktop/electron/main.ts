import { app, BrowserWindow, Menu, ipcMain, dialog } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentRuntime,
  createDesktopModelFeature,
} from "@lcode/lcode-desktop";
import type { AgentRuntime, DesktopModelFeature } from "@lcode/lcode-desktop";
import { createApprovalService } from "@lcode/approval";
import type { ApprovalChannel, ApprovalRequest } from "@lcode/approval";
import type { ApprovalResult } from "@lcode/session";

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

function askCloseDecision(win: BrowserWindow): Promise<"cancel" | CloseDecision> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: "cancel" | CloseDecision): void => {
      if (settled) return;
      settled = true;
      closeAnswer = null;
      resolve(decision);
    };
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      settle("cancel");
      return;
    }
    closeAnswer = (decision, remember) => {
      if (remember && decision !== "cancel") saveCloseDecision(decision);
      settle(decision);
    };
    // 从任务栏关闭时窗口可能是最小化的：先还原，否则弹窗看得见但窗口没了
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("lcode:app.close-request");
    // 渲染层无响应时不能把窗口变成“关不掉”：4 秒后回落原生对话框
    setTimeout(() => {
      if (settled) return;
      closeAnswer = null;
      settled = true;
      void nativeCloseDecision(win).then(resolve);
    }, 4000);
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
// 导入会话（P8-01）：只收导出格式，单选
ipcMain.handle(
  "dialog:choose-session-file",
  (_e: IpcMainInvokeEvent, title?: string) =>
    pickPath({
      title: title || "选择要导入的会话文件",
      properties: ["openFile"],
      filters: [{ name: "JSONL 会话", extensions: ["jsonl"] }],
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
      ...(parsed.api_key === "" ? {} : { api_key: parsed.api_key }),
      api_key_ref: refNameFor(provider),
    });
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
    if ((await feature.api.getDefault()) === undefined) {
      await feature.api.setDefault({
        selection: { provider, model: parsed.model },
      });
    }
    return saved;
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

async function agentRuntime(): Promise<AgentRuntime> {
  if (runtime !== null) return runtime;
  if (runtimeInit === null) {
    runtimeInit = (async () => {
      const feature = await models();
      return createAgentRuntime({
        services: feature.services,
        approval: createApprovalService({ channel: approvalChannel }),
      });
    })();
  }
  runtime = await runtimeInit;
  return runtime;
}

// ─────────────── 权限预设（P4-05：主进程持状态，renderer 只显示） ───────────────

const PERMISSION_PRESETS = new Set(['只读', '标准', '自动', '完全访问', '无人值守']);

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
ipcMain.handle('lcode:runtime.composition', async () => (await agentRuntime()).composition);
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
    // 结构与表面事件**即时**推：它们是 UI 的骨架，攒批会让"正在做什么"看起来卡住
    pushToRenderer("lcode:session.event", { session_id: sessionId, event });
  });
  sessionWatch.set(sessionId, dispose);
}

ipcMain.handle(
  "lcode:session.list",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const rt = await agentRuntime();
    const workspace = (input as { workspace?: unknown } | null)?.workspace;
    return rt.sessions.list(typeof workspace === "string" ? { workspace } : {});
  },
);

ipcMain.handle(
  "lcode:session.create",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const cwd =
      typeof record["cwd"] === "string" && record["cwd"] !== ""
        ? record["cwd"]
        : process.cwd();
    const title =
      typeof record["title"] === "string" ? record["title"] : undefined;
    const rt = await agentRuntime();
    const result = await rt.sessions.create({
      cwd,
      ...(title === undefined ? {} : { title }),
    });
    const workspace = rt.sessions.workspaceOf(result.session_id) ?? cwd;
    const trusted = rt.ctx.get("workspaceTrust").isTrusted(workspace);
    rt.sessions.sessionServiceFor(result.session_id).append({
      type: "workspace/trust",
      data: { workspace, trusted },
    });
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
      meta,
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
  "lcode:session.export",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const format = record["format"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    if (format !== "jsonl" && format !== "md")
      throw new Error("format 必须是 jsonl 或 md");
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

ipcMain.handle(
  "lcode:agent.send",
  async (_e: IpcMainInvokeEvent, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>;
    const sessionId = record["session_id"];
    const text = record["text"];
    if (typeof sessionId !== "string" || sessionId === "")
      throw new Error("session_id 必填");
    if (typeof text !== "string" || text.trim() === "")
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
        content: [{ type: "text", text }],
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
    if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
    if (typeof text !== "string" || text.trim() === "") throw new Error("text 必填");

    const rt = await agentRuntime();
    const { agent_id } = await rt.agents.resume({ session_id: sessionId });
    await ensureSessionWatch(sessionId);
    watchTurnFailure(sessionId);
    try {
      await rt.agents.steer({ agent_id, content: [{ type: "text", text }] });
      pushToRenderer("lcode:session.changed", { session_id: sessionId });
      return { accepted: true as const, mode: "steered" as const };
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
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session_id 必填");
  if (typeof queueId !== "string" || queueId === "") throw new Error("queue_id 必填");
  const rt = await agentRuntime();
  const { agent_id } = await rt.agents.resume({ session_id: sessionId });
  const result = await rt.agents.guideQueued({ agent_id, queue_id: queueId });
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
  return {
    label: label.trim(),
    model: trimmedModel === "" ? label.trim() : trimmedModel,
    base_url: baseUrl.trim(),
    api_key: apiKey,
  };
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
app.on('before-quit', (event) => {
  quitting = true;
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
