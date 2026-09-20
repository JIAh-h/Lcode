import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/*
 * 真实桌面恢复验收：模型已请求一个长时间 shell 工具时强制终止 Electron。
 * 重启后必须补记未派发工具的结果与结构闭合，并能继续同一会话。
 */
const HOME = process.env.LCODE_HOME;
if (HOME === undefined || HOME === "") throw new Error("需要 LCODE_HOME");
if (process.env.LCODE_E2E_LIVE !== "1") {
  console.log("跳过：这是真实模型恢复验收，需要 LCODE_E2E_LIVE=1");
  process.exit(0);
}

const ELECTRON = fileURLToPath(
  new URL(
    "../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe",
    import.meta.url,
  ),
);
const FIRST_PORT = 9231;
const SECOND_PORT = 9232;
const THIRD_PORT = 9233;
const WORKSPACE = join(HOME, "p1-recovery-workspace");
mkdirSync(WORKSPACE, { recursive: true });

function launch(port, logs) {
  const child = spawn(
    ELECTRON,
    [
      "--no-sandbox",
      "--in-process-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu",
      ".",
      `--remote-debugging-port=${port}`,
      ...(process.env.LCODE_ELECTRON_USER_DATA_DIR
        ? [`--user-data-dir=${process.env.LCODE_ELECTRON_USER_DATA_DIR}`]
        : []),
    ],
    { cwd: "apps/desktop", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => logs.push(String(b)));
  child.stderr.on("data", (b) => logs.push(String(b)));
  return child;
}

function logFileOf(sessionId) {
  const buckets = readdirSync(join(HOME, "sessions"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const bucket of buckets) {
    const candidate = join(HOME, "sessions", bucket.name, `${sessionId}.jsonl`);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // 不是这个 bucket。
    }
  }
  throw new Error(`找不到会话日志：${sessionId}`);
}

async function pageFor(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("file://"));
      if (page !== undefined) return page;
    } catch {
      // Electron 尚未开启调试端口。
    }
    await delay(250);
  }
  throw new Error("等待 Electron 页面超时");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const resolve = this.pending.get(message.id);
      if (resolve !== undefined) {
        this.pending.delete(message.id);
        resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? "页面求值失败");
    }
    return result.result?.value;
  }
}

async function connect(port) {
  const page = await pageFor(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return new Cdp(ws);
}

async function waitFor(cdp, sessionId, predicate, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await cdp.eval(`(async () => (await window.lcode.session.open(${JSON.stringify(sessionId)})).events)()`);
    if (predicate(events)) return events;
    await delay(250);
  }
  throw new Error(`等待会话 ${sessionId} 达到预期状态超时`);
}

const logs = [];
let first;
let second;
let third;
try {
  first = launch(FIRST_PORT, logs);
  const cdp = await connect(FIRST_PORT);
  await cdp.eval(`(() => {
    window.lcode.approval.onAsked((request) => {
      void window.lcode.approval.answer({ callId: request.callId, result: 'allowed-once' })
    })
    return 'approval-hooked'
  })()`);
  const sessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: ${JSON.stringify(WORKSPACE)}, title: 'P1 强杀恢复验收' })
    await window.lcode.agent.send({
      session_id: created.session_id,
      text: "必须只调用 shell 工具执行 ping -n 31 127.0.0.1 > NUL。不要解释。"
    })
    return created.session_id
  })()`);
  const beforeKill = await waitFor(
    cdp,
    sessionId,
    (events) => events.some((event) => event.type === "tool/call") && !events.some((event) => event.type === "tool/result"),
  );
  console.log("① 强杀前:", JSON.stringify({ sessionId, events: beforeKill.length }));

  // 强制杀掉整个 Electron 进程；不能走应用正常退出路径，否则测不到恢复补记。
  first.kill("SIGKILL");
  await delay(800);
  second = launch(SECOND_PORT, logs);
  const restarted = await connect(SECOND_PORT);
  const recovered = await restarted.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(sessionId)})
    return { repaired: opened.repaired, closers: opened.closers.map((event) => ({ type: event.type, data: event.data })) }
  })()`);
  console.log("② 重启恢复:", JSON.stringify(recovered));
  const closerTypes = recovered.closers.map((event) => event.type);
  if (
    recovered.repaired !== true ||
    // 当前引擎在进入工具执行前已写入 step/end；因此强杀发生在工具体期间时，
    // 恢复只需补未配对的工具结果、轮终态和新世代分界线。
    JSON.stringify(closerTypes) !== JSON.stringify(["tool/result", "turn/end", "session/end-seed"])
  ) {
    throw new Error(`恢复补记不完整：${JSON.stringify(recovered)}`);
  }
  const repairedTool = recovered.closers.find((event) => event.type === "tool/result");
  if (repairedTool?.data?.error?.code !== "ABORTED_BEFORE_DISPATCH") {
    throw new Error(`恢复工具结果没有如实标记未派发：${JSON.stringify(repairedTool)}`);
  }

  await restarted.eval(`(async () => {
    await window.lcode.agent.send({ session_id: ${JSON.stringify(sessionId)}, text: '只回答四个字：恢复成功' })
    return 'sent'
  })()`);
  const afterRecovery = await waitFor(
    restarted,
    sessionId,
    (events) => events.filter((event) => event.type === "turn/end").length >= 2,
  );
  const reasons = afterRecovery.filter((event) => event.type === "turn/end").map((event) => event.data.reason);
  if (JSON.stringify(reasons) !== JSON.stringify(["aborted", "completed"])) {
    throw new Error(`恢复后的继续对话没有完成：${JSON.stringify(reasons)}`);
  }
  console.log("③ 恢复后继续:", JSON.stringify({ reasons }));

  // ④/⑤ 不需要模型的存储故障：创建专用空会话，停止应用后才篡改其日志。
  const corruptionSessions = await restarted.eval(`(async () => {
    const torn = await window.lcode.session.create({ cwd: ${JSON.stringify(WORKSPACE)}, title: 'P1 撕裂尾验收' })
    const future = await window.lcode.session.create({ cwd: ${JSON.stringify(WORKSPACE)}, title: 'P1 未来格式验收' })
    return { torn: torn.session_id, future: future.session_id }
  })()`);
  second.kill("SIGKILL");
  await delay(600);
  appendFileSync(logFileOf(corruptionSessions.torn), '{"type":"turn/start"');
  const futureFile = logFileOf(corruptionSessions.future);
  const futureLines = readFileSync(futureFile, "utf8").split("\n");
  const futureHeader = JSON.parse(futureLines[0]);
  futureHeader.formatVersion = 999;
  futureLines[0] = JSON.stringify(futureHeader);
  writeFileSync(futureFile, futureLines.join("\n"), "utf8");

  third = launch(THIRD_PORT, logs);
  const afterCorruption = await connect(THIRD_PORT);
  // 先让 RecoveryPage 自己调用 open，避免预先 open 消费掉 repaired=true。
  await afterCorruption.eval(`(() => { window.location.hash = '#/sessions/${corruptionSessions.torn}/recovery' })()`);
  let tornUi = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await delay(250);
    tornUi = await afterCorruption.eval(`(() => document.body?.innerText ?? '')()`);
    if (tornUi.includes("上次没有正常退出") || tornUi.includes("恢复事件已写回会话日志")) break;
  }
  if (!tornUi.includes("上次没有正常退出") || !tornUi.includes("恢复事件已写回会话日志")) {
    throw new Error(`撕裂尾没有显示恢复状态：${JSON.stringify(tornUi)}`);
  }
  const futureResult = await afterCorruption.eval(`(async () => {
    try {
      await window.lcode.session.open(${JSON.stringify(corruptionSessions.future)})
      return { opened: true }
    } catch (error) {
      return { opened: false, message: String(error?.message ?? error) }
    }
  })()`);
  if (futureResult.opened || !/formatVersion|更新版本|不支持/.test(futureResult.message ?? "")) {
    throw new Error(`未来格式没有被明确拒绝：${JSON.stringify(futureResult)}`);
  }
  console.log("④ 撕裂尾与未来格式:", JSON.stringify({ tornUi, futureResult }));
  third.kill();
  process.exit(0);
} catch (error) {
  console.error("恢复冒烟失败：", error.message ?? error);
  console.log(logs.join("").split("\n").slice(-40).join("\n"));
  first?.kill("SIGKILL");
  second?.kill("SIGKILL");
  third?.kill("SIGKILL");
  process.exit(1);
}
