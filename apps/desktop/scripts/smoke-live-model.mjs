import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 端到端冒烟：**真实模型**（不放假服务端）。
 *
 * 为什么单独留一个：假服务端太好了——它永远返回格式完美的 SSE。真实供应商会带
 * `"usage": null`、会 400、会缺字段，而这些恰恰是"测试连接成功但对话失败"的来源。
 * 这个脚本直接打用户配置里的那个端点，报出真正的错误。
 *
 * 需要 LCODE_E2E_LIVE=1 才跑（默认不跑：它会产生真实的 API 调用与费用）。
 */

const HOME = process.env.LCODE_HOME;
if (HOME === undefined || HOME === "") throw new Error("需要 LCODE_HOME");
if (process.env.LCODE_E2E_LIVE !== "1") {
  console.log("跳过：这是真实模型冒烟，需要显式设 LCODE_E2E_LIVE=1");
  process.exit(0);
}

const ELECTRON = fileURLToPath(
  new URL(
    "../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe",
    import.meta.url,
  ),
);
// 固定端口会附着到上一次异常退出的 Electron，导致验收读到错误进程。
// 每次运行使用独占随机端口；重开实例使用相邻的第二个端口。
const PORT = 21000 + Math.floor(Math.random() * 3000);
const REOPEN_PORT = PORT + 3000;
const providedUserData = process.env.LCODE_ELECTRON_USER_DATA_DIR;
const electronUserData = providedUserData ?? mkdtempSync(join(tmpdir(), "lcode-live-e2e-"));
const ownsElectronUserData = providedUserData === undefined;

process.once("exit", () => {
  if (!ownsElectronUserData) return;
  try {
    rmSync(electronUserData, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // 进程已退出时 Chromium 偶尔仍释放文件；临时目录不会影响验收结论。
  }
});

const child = spawn(
  ELECTRON,
  [
    "--no-sandbox",
    "--in-process-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu",
    ".",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${electronUserData}`,
  ],
  {
    cwd: "apps/desktop",
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const logs = [];
child.stdout.on("data", (b) => logs.push(String(b)));
child.stderr.on("data", (b) => logs.push(String(b)));

/** Windows 上普通 child.kill() 只终止主进程，Chromium renderer/GPU 子进程会残留。 */
async function stopElectron(processHandle) {
  if (processHandle === undefined || processHandle.exitCode !== null) return;
  if (process.platform === "win32" && processHandle.pid !== undefined) {
    const killer = spawn("taskkill.exe", ["/pid", String(processHandle.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(killer, "close");
    return;
  }
  processHandle.kill();
}

async function findPage(port = PORT, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && t.url.startsWith("file://"),
      );
      if (page !== undefined) return page;
    } catch {
      /* 还没起来 */
    }
    await delay(500);
  }
  throw new Error("等不到可调试的页面目标");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const resolve = this.pending.get(msg.id);
      if (resolve !== undefined) {
        this.pending.delete(msg.id);
        resolve(
          msg.error === undefined
            ? msg.result
            : {
                exceptionDetails: {
                  exception: { description: JSON.stringify(msg.error) },
                },
              },
        );
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) =>
        r?.exceptionDetails === undefined
          ? resolve(r)
          : reject(new Error(JSON.stringify(r.exceptionDetails))),
      );
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails !== undefined) {
      throw new Error(
        `页面内报错：${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`,
      );
    }
    return r.result?.value;
  }
}

/** 以日志终态为准，避免机器快慢或真实模型思考时间让固定 sleep 产生假阴性。 */
async function waitForTurns(cdp, sessionId, count, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.eval(`(async () => {
      const opened = await window.lcode.session.open(${JSON.stringify(sessionId)})
      const ends = opened.events.filter((event) => event.type === 'turn/end')
      return { count: ends.length, reasons: ends.map((event) => event.data.reason) }
    })()`);
    if (state.count >= count) return state;
    await delay(300);
  }
  throw new Error(`等待会话 ${sessionId} 的第 ${count} 个回合超时`);
}

async function waitForEvents(cdp, sessionId, predicate, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const opened = await cdp.eval(`(async () => await window.lcode.session.open(${JSON.stringify(sessionId)}))()`);
      if (predicate(opened.events)) return opened;
    } catch {
      // 页面正在重载时，桥接暂时不可用；下一次轮询继续检查。
    }
    await delay(300);
  }
  throw new Error(`等待会话 ${sessionId} 达到事件条件超时`);
}

/** Electron 首帧可能在 DevTools 页面已出现后仍触发一次重载，等待 preload 桥稳定。 */
async function waitForDefaultModel(cdp) {
  const deadline = Date.now() + 30000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const model = await cdp.eval(`(async () => {
        if (typeof window.lcode?.model?.getDefault !== 'function') return undefined
        return window.lcode.model.getDefault()
      })()`);
      if (model !== undefined) return model;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`等待模型桥就绪超时：${lastError}`);
}

/**
 * 用真实默认模型测“提交任务 → renderer 收到首个文本 chunk”的端到端耗时。
 * 这是 live 指标，不进入离线 CI；完成后立即取消并软删专用会话，避免污染普通列表。
 */
async function measureFirstToken(cdp) {
  return cdp.eval(`(async () => {
    const created = await window.lcode.session.create({
      cwd: ${JSON.stringify(HOME)},
      title: '性能探针（自动清理）',
    })
    const sessionId = created.session_id
    let stopChunks = () => {}
    let stopEvents = () => {}
    let stopFailed = () => {}
    let timeout
    try {
      window.location.hash = '#/sessions/' + sessionId
      const mountDeadline = Date.now() + 10000
      while (document.querySelector('.sessionstream') === null) {
        if (Date.now() >= mountDeadline) throw new Error('等待会话视图挂载超时')
        await new Promise((resolve) => window.setTimeout(resolve, 50))
      }
      // DOM 节点出现不等于 React effect 已完成订阅；真人只能在视图稳定后点击发送。
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const startedAt = performance.now()
      const firstTextChunk = new Promise((resolve, reject) => {
        timeout = window.setTimeout(() => reject(new Error('等待首个文本片段超时')), 90000)
        stopChunks = window.lcode.session.onChunks((payload) => {
          const record = payload ?? {}
          if (record.session_id !== sessionId || !Array.isArray(record.chunks)) return
          const chunk = record.chunks.find((item) => item?.type === 'text-delta' && String(item.text ?? '').trim() !== '')
          if (chunk !== undefined) {
            const text = String(chunk.text)
            const bridgeToReceiveMs = typeof record.sent_at === 'number' ? Math.max(0, Date.now() - record.sent_at) : null
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const visible = document.querySelector('.sessionstream')?.innerText.includes(text) === true
              if (!visible) {
                reject(new Error('首个文本 chunk 已到达，但未在下一帧绘制到会话视图'))
                return
              }
              resolve({
                firstTokenMs: Math.round(performance.now() - startedAt),
                bridgeToReceiveMs,
                bridgeToPaintMs: typeof record.sent_at === 'number' ? Math.max(0, Date.now() - record.sent_at) : null,
              })
            }))
          }
        })
        stopFailed = window.lcode.session.onTurnFailed(() => {
          reject(new Error('模型回合失败，未收到首个文本片段'))
        })
        stopEvents = window.lcode.session.onEvent((payload) => {
          if (payload?.session_id !== sessionId || payload?.event?.type !== 'turn/end') return
          if (payload.event.data?.reason === 'error') reject(new Error('模型回合以错误结束，未收到首个文本片段'))
        })
      })
      await window.lcode.agent.send({ session_id: sessionId, text: '只回复：OK' })
      return await firstTextChunk
    } finally {
      window.clearTimeout(timeout)
      stopChunks()
      stopEvents()
      stopFailed()
      await window.lcode.agent.cancel(sessionId).catch(() => undefined)
      await window.lcode.session.delete({ session_id: sessionId }).catch(() => undefined)
    }
  })()`)
}

/** P4-02 专用真机验收：不让 P1 的审批恢复链路掩盖写后 diff 的结果。 */
async function verifyLiveDiffReplay(cdp) {
  const workspace = join(HOME, "p1-live-workspace");
  mkdirSync(workspace, { recursive: true });
  const outputName = `p4-diff-output-${Date.now()}.txt`;
  const expected = "P4_LIVE_DIFF_REPLAY_OK";
  const outputPath = join(workspace, outputName);
  const wasTrusted = await cdp.eval(`(async () => {
    const entries = await window.lcode.workspaceTrust.list()
    return entries.some((entry) => entry.path === ${JSON.stringify(workspace)})
  })()`);
  let restoredTrust = wasTrusted;

  await cdp.eval(`(() => {
    window.lcode.approval.onAsked((request) => {
      void window.lcode.approval.answer({ callId: request.callId, result: 'allowed-once' })
    })
  })()`);
  await cdp.eval(`(async () => await window.lcode.workspaceTrust.set({ workspace: ${JSON.stringify(workspace)}, trusted: true }))()`);
  try {
    const sessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({
      cwd: ${JSON.stringify(workspace)},
      title: 'P4 写后 diff 真实验收',
    })
    await window.lcode.agent.send({
      session_id: created.session_id,
      text: ${JSON.stringify(`必须且只能调用 write 工具，在当前工作区创建 ${outputName}，文件内容必须恰好为 ${expected}。不要调用其他工具，也不要只解释。`)},
    })
    return created.session_id
    })()`);
    await waitForTurns(cdp, sessionId, 1);

    const liveEvidence = await cdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(sessionId)})
    const calls = opened.events.filter((event) => event.type === 'tool/call')
    const writeCall = calls.find((event) => event.data.name === 'write')
    const result = writeCall === undefined
      ? undefined
      : opened.events.find((event) => event.type === 'tool/result' && event.data.message?.toolCallId === writeCall.data.callId)
    return {
      writeCalls: calls.filter((event) => event.data.name === 'write').length,
      card: result?.data.meta?.card ?? null,
      hunks: result?.data.meta?.hunks ?? null,
    }
    })()`);
    const fileWritten = existsSync(outputPath) && readFileSync(outputPath, 'utf8') === expected;
    if (
    !fileWritten ||
    liveEvidence.writeCalls !== 1 ||
    liveEvidence.card !== 'diff' ||
    !Array.isArray(liveEvidence.hunks) ||
    !liveEvidence.hunks.some((hunk) => Array.isArray(hunk?.newLines) && hunk.newLines.includes(expected))
    ) {
      throw new Error(`P4 实时写入 diff 不完整：${JSON.stringify({ liveEvidence, fileWritten })}`);
    }
    if (!wasTrusted) {
      await cdp.eval(`(async () => await window.lcode.workspaceTrust.set({ workspace: ${JSON.stringify(workspace)}, trusted: false }))()`);
      restoredTrust = true;
    }

    await stopElectron(child);
    await delay(800);
    reopenedChild = spawn(
    ELECTRON,
    [
      "--no-sandbox",
      "--in-process-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu",
      ".",
      `--remote-debugging-port=${REOPEN_PORT}`,
      `--user-data-dir=${electronUserData}`,
    ],
    { cwd: "apps/desktop", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    reopenedChild.stdout.on("data", (b) => logs.push(String(b)));
    reopenedChild.stderr.on("data", (b) => logs.push(String(b)));
    const reopenedPage = await findPage(REOPEN_PORT);
    const reopenedWs = new WebSocket(reopenedPage.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
    reopenedWs.addEventListener("open", resolve, { once: true });
    reopenedWs.addEventListener("error", reject, { once: true });
    });
    const reopenedCdp = new Cdp(reopenedWs);
    const replayEvidence = await reopenedCdp.eval(`(async () => {
    window.location.hash = '#/sessions/${sessionId}/replay'
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const items = [...document.querySelectorAll('.replay-item')]
      for (const item of items) {
        if (!(item instanceof HTMLElement)) continue
        item.click()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const card = document.querySelector('.replay-cards .toolcard-diff')
        if (!(card instanceof HTMLElement)) continue
        card.querySelector('.toolcard-head')?.click()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return {
          found: true,
          additions: [...card.querySelectorAll('.tool-diff-line.add')].map((line) => line.textContent ?? ''),
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250))
    }
    return { found: false, additions: [] }
    })()`);
    reopenedWs.close();
    await stopElectron(reopenedChild);
    return { sessionId, liveEvidence, replayEvidence };
  } finally {
    rmSync(outputPath, { force: true });
    if (!wasTrusted && !restoredTrust) {
      await cdp.eval(`(async () => await window.lcode.workspaceTrust.set({ workspace: ${JSON.stringify(workspace)}, trusted: false }))()`).catch(() => undefined);
    }
  }
}

let cdp;
let reopenedChild;
live: try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  cdp = new Cdp(ws);

  const def = await waitForDefaultModel(cdp);
  console.log("① 默认模型:", JSON.stringify(def));
  if (def === null) throw new Error("没有默认模型，先去设置页配一个");

  if (process.env.LCODE_E2E_FIRST_TOKEN_ONLY === "1") {
    const metric = await measureFirstToken(cdp);
    await new Promise((resolve) => {
      process.stdout.write(`首 token（真实模型 → renderer 首个文本 chunk）：${JSON.stringify(metric)}\n`, resolve);
    });
    cdp.ws.close();
    await stopElectron(child);
    await delay(500);
    break live;
  }

  if (process.env.LCODE_E2E_P4_DIFF_ONLY === "1") {
    const result = await verifyLiveDiffReplay(cdp);
    console.log("P4 写后 diff 真实验收:", JSON.stringify(result));
    cdp.ws.close();
    await stopElectron(child);
    break live;
  }

  const sessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e-live', title: '真实模型冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '只回答四个字：你好世界' })
    return created.session_id
  })()`);
  console.log("② 已发送:", sessionId);

  await cdp.eval(
    `(() => { window.location.hash = '#/sessions/${sessionId}' })()`,
  );
  await waitForTurns(cdp, sessionId, 1);

  /*
   * ③ 同一会话**再发一句**（多轮）。
   *
   * 只发一条消息的冒烟漏掉过真 bug：`agent.send` 用的 `agents.create` 在第二次
   * 会撞 `EC-CONFLICT`（D17：agent id 就是 session id）。多轮是最普通的用法。
   */
  const second = await cdp.eval(`(async () => {
    try {
      await window.lcode.agent.send({ session_id: ${JSON.stringify(sessionId)}, text: '再回答四个字：再见世界' })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) }
    }
  })()`);
  console.log(
    "③ 同一会话再发一句:",
    second.ok ? "接受" : `❌ 被拒：${second.message}`,
  );
  if (!second.ok) throw new Error(`多轮发言被拒：${second.message}`);
  await waitForTurns(cdp, sessionId, 2);

  // ④ 真实模型上的暂停/续跑：中断的是当前请求，点击继续后基于日志发起新回合。
  const pausedSessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e-live', title: '真实模型暂停续跑' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '简短说明 TypeScript 的优点。' })
    await window.lcode.agent.cancel(created.session_id)
    const resumed = await window.lcode.agent.resume(created.session_id)
    return { sessionId: created.session_id, resumed }
  })()`);
  console.log("④ 暂停后继续:", JSON.stringify(pausedSessionId));
  if (pausedSessionId.resumed?.resumed !== true)
    throw new Error('真实模型暂停后没有可续跑的任务');
  await waitForTurns(cdp, pausedSessionId.sessionId, 2);
  const pauseTimeline = await cdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(pausedSessionId.sessionId)})
    const events = opened.events
    return {
      users: events.filter((event) => event.type === 'user/message').length,
      reasons: events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason),
    }
  })()`);
  console.log("④b 暂停续跑终态:", JSON.stringify(pauseTimeline));
  if (
    pauseTimeline.users !== 1 ||
    JSON.stringify(pauseTimeline.reasons) !== JSON.stringify(['cancelled', 'completed'])
  ) {
    throw new Error(`真实模型暂停续跑事件不符合预期：${JSON.stringify(pauseTimeline)}`);
  }

  // ⑤ Renderer 重载恢复：主进程保留待审批请求，页面重载后应重新显示完整审批卡。
  const workspace = join(HOME, "p1-live-workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "fixture.txt"), "P1_LIVE_READ_OK\n", "utf8");
  const reloadOutside = join(HOME, "p1-live-reload-outside");
  mkdirSync(reloadOutside, { recursive: true });
  const reloadTarget = join(reloadOutside, `approved-${Date.now()}.txt`);
  const reloadApprovalSessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: ${JSON.stringify(workspace)}, title: 'Renderer 重载审批恢复' })
    await window.lcode.agent.send({
      session_id: created.session_id,
      text: ${JSON.stringify(
        `必须且只能调用 write 工具，把文本 P1_LIVE_RELOAD_OK 写入绝对路径 ${reloadTarget}。不要调用 shell，也不要只解释。`,
      )}
    })
    return created.session_id
  })()`);
  await waitForEvents(
    cdp,
    reloadApprovalSessionId,
    (events) =>
      events.some((event) => event.type === 'approval/asked') &&
      !events.some((event) => event.type === 'approval/decided'),
  );
  await cdp.eval(`(() => { window.location.hash = '#/sessions/${reloadApprovalSessionId}' })()`);
  await cdp.send("Page.reload", { ignoreCache: true });
  let pendingAfterReload = [];
  let reloadModal = "";
  const reloadDeadline = Date.now() + 30000;
  while (Date.now() < reloadDeadline) {
    try {
      pendingAfterReload = await cdp.eval(`(async () => await window.lcode.approval.pending())()`);
      reloadModal = await cdp.eval(`(() => document.body?.innerText ?? '')()`);
      if (pendingAfterReload.length > 0 && reloadModal.includes('确认这一步')) break;
    } catch {
      // 页面首帧尚未建立 preload/React 桥。
    }
    await delay(250);
  }
  if (pendingAfterReload.length === 0 || !reloadModal.includes('确认这一步')) {
    throw new Error(`Renderer 重载后没有恢复待审批卡：${JSON.stringify({ pendingAfterReload, reloadModal })}`);
  }
  const pendingCallId = pendingAfterReload[0].callId;
  await cdp.eval(`(async () => await window.lcode.approval.answer({ callId: ${JSON.stringify(pendingCallId)}, result: 'allowed-once' }))()`);
  const reloadTurn = await waitForTurns(cdp, reloadApprovalSessionId, 1);
  const reloadWritten = existsSync(reloadTarget) && readFileSync(reloadTarget, "utf8") === "P1_LIVE_RELOAD_OK";
  console.log("⑤ Renderer 重载恢复:", JSON.stringify({ pending: pendingAfterReload.length, modal: true, reloadTurn, reloadWritten }));
  if (!reloadWritten || reloadTurn.reasons.at(-1) !== "completed") {
    throw new Error(`Renderer 重载后审批恢复失败：${JSON.stringify({ reloadTurn, reloadWritten })}`);
  }

  // ⑥ P1 真实工具旅程：模型必须实际读、写、运行前台命令；审批由本专用验收会话一次性允许。
  await cdp.eval(`(() => {
    if (!window.__p1ApprovalHooked) {
      window.__p1ApprovalHooked = true
      window.lcode.approval.onAsked((req) => {
        void window.lcode.approval.answer({ callId: req.callId, result: 'allowed-once' })
      })
    }
    return 'approval-hooked'
  })()`);
  const toolSessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: ${JSON.stringify(workspace)}, title: 'P1 真实工具验收' })
    await window.lcode.agent.send({
      session_id: created.session_id,
      text: ${JSON.stringify(
        "必须按顺序调用工具，不要只解释：1. 用 read 读取 fixture.txt；2. 用 write 创建 model-output.txt，内容必须恰好为 P1_LIVE_WRITE_OK；3. 用 shell 执行 node -e \\\"console.log('P1_LIVE_SHELL_OK')\\\"；4. 最后简短总结。即使前一步失败也继续下一步。",
      )}
    })
    return created.session_id
  })()`);
  const toolTurn = await waitForTurns(cdp, toolSessionId, 1);
  const toolEvidence = await cdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(toolSessionId)})
    const events = opened.events
    const calls = events.filter((event) => event.type === 'tool/call')
    const writeCallIds = new Set(calls.filter((event) => event.data.name === 'write').map((event) => event.data.callId))
    const writeResult = events.find((event) => event.type === 'tool/result' && writeCallIds.has(event.data.message?.toolCallId))
    const replay = writeResult
      ? await window.lcode.session.history({ session_id: ${JSON.stringify(toolSessionId)}, up_to_seq: writeResult.seq })
      : null
    const exported = await window.lcode.session.export({ session_id: ${JSON.stringify(toolSessionId)}, format: 'jsonl' })
    return {
      tools: calls.map((event) => event.data.name),
      results: events.filter((event) => event.type === 'tool/result').length,
      cards: calls.map((event) => event.data.card ?? null),
      resultCards: events.filter((event) => event.type === 'tool/result').map((event) => event.data.meta?.card ?? null),
      resultCardCount: events.filter((event) => event.type === 'tool/result' && event.data.meta?.card).length,
      writeDiff: writeResult === undefined ? null : {
        card: writeResult.data.meta?.card ?? null,
        hunks: writeResult.data.meta?.hunks ?? null,
      },
      approvals: events.filter((event) => event.type === 'approval/decided').map((event) => event.data.result),
      replay: replay === null ? null : {
        header: replay.header !== null,
        messages: replay.messages.length,
        cards: replay.toolCalls.map((item) => item.call.card ?? null),
        results: replay.toolCalls.filter((item) => item.result !== undefined).length,
        writeDiff: replay.toolCalls.some((item) =>
          item.call.name === 'write' &&
          item.result?.meta?.card === 'diff' &&
          Array.isArray(item.result.meta.hunks) &&
          item.result.meta.hunks.some((hunk) => Array.isArray(hunk?.newLines) && hunk.newLines.includes('P1_LIVE_WRITE_OK')),
        ),
      },
      exportPath: exported.path,
    }
  })()`);
  const wroteExpectedFile =
    existsSync(join(workspace, "model-output.txt")) &&
    readFileSync(join(workspace, "model-output.txt"), "utf8") === "P1_LIVE_WRITE_OK";
  console.log("⑥ P1 真实工具:", JSON.stringify({ toolTurn, toolEvidence, wroteExpectedFile }));
  if (
    !wroteExpectedFile ||
    !toolEvidence.tools.includes("read") ||
    !toolEvidence.tools.includes("write") ||
    !toolEvidence.tools.includes("shell") ||
    toolEvidence.results < 3 ||
    toolEvidence.replay?.header !== true ||
    toolEvidence.replay.messages < 1 ||
    toolEvidence.replay.results < 1 ||
    toolEvidence.cards.some((card) => card === null) ||
    toolEvidence.resultCardCount < 3 ||
    toolEvidence.writeDiff?.card !== 'diff' ||
    !Array.isArray(toolEvidence.writeDiff?.hunks) ||
    !toolEvidence.writeDiff.hunks.some((hunk) => Array.isArray(hunk?.newLines) && hunk.newLines.includes('P1_LIVE_WRITE_OK')) ||
    toolEvidence.replay.cards.some((card) => card === null) ||
    toolEvidence.replay.writeDiff !== true ||
    typeof toolEvidence.exportPath !== "string" ||
    toolEvidence.exportPath === ""
  ) {
    throw new Error(`P1 真实工具旅程不完整：${JSON.stringify({ toolTurn, toolEvidence, wroteExpectedFile })}`);
  }

  // ⑦ 工作区外写必须经过真实审批通道；专用目录避免触及用户项目文件。
  const outsideWorkspace = join(HOME, "p1-live-outside");
  mkdirSync(outsideWorkspace, { recursive: true });
  const outsideTarget = join(outsideWorkspace, `approved-${Date.now()}.txt`);
  const approvalSessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: ${JSON.stringify(workspace)}, title: 'P1 真实审批验收' })
    await window.lcode.agent.send({
      session_id: created.session_id,
      text: ${JSON.stringify(
        `必须且只能调用 write 工具，把文本 P1_LIVE_APPROVAL_OK 写入绝对路径 ${outsideTarget}。不要调用 shell，也不要只解释。`,
      )}
    })
    return created.session_id
  })()`);
  await waitForTurns(cdp, approvalSessionId, 1);
  const approvalEvidence = await cdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(approvalSessionId)})
    const events = opened.events
    return {
      tools: events.filter((event) => event.type === 'tool/call').map((event) => event.data.name),
      asked: events.filter((event) => event.type === 'approval/asked').length,
      decided: events.filter((event) => event.type === 'approval/decided').map((event) => event.data.result),
    }
  })()`);
  const outsideWritten =
    existsSync(outsideTarget) && readFileSync(outsideTarget, "utf8") === "P1_LIVE_APPROVAL_OK";
  console.log("⑦ P1 真实审批:", JSON.stringify({ approvalEvidence, outsideWritten }));
  if (
    !outsideWritten ||
    !approvalEvidence.tools.includes("write") ||
    approvalEvidence.asked < 1 ||
    !approvalEvidence.decided.includes("allowed-once")
  ) {
    throw new Error(`P1 真实审批旅程不完整：${JSON.stringify({ approvalEvidence, outsideWritten })}`);
  }

  // ⑧ 关闭后重开：不依赖存活的 renderer 状态，从持久化会话恢复并再发一轮。
  await stopElectron(child);
  await delay(800);
  reopenedChild = spawn(
    ELECTRON,
    [
      "--no-sandbox",
      "--in-process-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu",
      ".",
      `--remote-debugging-port=${REOPEN_PORT}`,
      `--user-data-dir=${electronUserData}`,
    ],
    {
      cwd: "apps/desktop",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  reopenedChild.stdout.on("data", (b) => logs.push(String(b)));
  reopenedChild.stderr.on("data", (b) => logs.push(String(b)));
  const reopenedPage = await findPage(REOPEN_PORT);
  const reopenedWs = new WebSocket(reopenedPage.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    reopenedWs.addEventListener("open", resolve, { once: true });
    reopenedWs.addEventListener("error", reject, { once: true });
  });
  const reopenedCdp = new Cdp(reopenedWs);
  const recovered = await reopenedCdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(toolSessionId)})
    const exported = await window.lcode.session.export({ session_id: ${JSON.stringify(toolSessionId)}, format: 'md' })
    await window.lcode.agent.send({ session_id: ${JSON.stringify(toolSessionId)}, text: '重开后只回答四个字：恢复成功' })
    return { events: opened.events.length, messages: opened.history.messages.length, exportPath: exported.path }
  })()`);
  const reopenedTurns = await waitForTurns(reopenedCdp, toolSessionId, 2);
  console.log("⑧ P1 关闭重开:", JSON.stringify({ recovered, reopenedTurns }));
  if (
    recovered.events < 1 ||
    recovered.messages < 1 ||
    typeof recovered.exportPath !== "string" ||
    recovered.exportPath === "" ||
    reopenedTurns.reasons.at(-1) !== "completed"
  ) {
    throw new Error(`P1 关闭重开后恢复失败：${JSON.stringify({ recovered, reopenedTurns })}`);
  }

  await reopenedCdp.eval(`(() => { window.location.hash = '#/sessions/${toolSessionId}' })()`);
  let dom = { exists: false, text: '' };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250);
    dom = await reopenedCdp.eval(`(() => {
      const el = document.querySelector('.sessionstream')
      return {
        exists: !!el,
        text: el ? el.innerText : '',
        titles: [...document.querySelectorAll('.sessionstream .toolcard-title')].map((item) => item.innerText),
      }
    })()`);
    if (dom.exists) break;
  }
  console.log("⑨ 界面文本:", JSON.stringify(dom.text).slice(0, 400));

  const actionTitles = dom.titles;
  if (
    !actionTitles.includes('读取文件') ||
    !actionTitles.includes('修改文件') ||
    !actionTitles.includes('运行命令') ||
    actionTitles.some((title) => /·\s*(read|write|edit|shell|glob|grep)\b/i.test(title))
  ) {
    throw new Error(`实时工具卡标题不符合用户化文案要求：${JSON.stringify(actionTitles)}`);
  }

  // 回放页的工具卡复用同一个组件；真实点击 why/body，确认 IPC 不是静态占位。
  await reopenedCdp.eval(`(() => { window.location.hash = '#/sessions/${toolSessionId}/replay' })()`);
  let replayUi = { cards: [], titles: [], why: false, body: false };
  const replayDeadline = Date.now() + 30000;
  while (Date.now() < replayDeadline) {
    try {
      const selectedToolStep = await reopenedCdp.eval(`(() => {
        const items = [...document.querySelectorAll('.replay-item')]
        // 首个模型步骤包含验收要求的 read 调用；最后一步通常只是模型总结。
        const target = items[0]
        if (target instanceof HTMLElement) target.click()
        return items.length > 0
      })()`);
      if (!selectedToolStep) {
        await delay(250);
        continue;
      }
      replayUi = await reopenedCdp.eval(`(() => {
        const cards = [...document.querySelectorAll('.replay-cards .toolcard')]
        return {
          cards: cards.map((card) => card.innerText),
          titles: cards.map((card) => card.querySelector('.toolcard-title')?.innerText ?? ''),
          why: [...document.querySelectorAll('.replay-cards .toolcard-feedback')].some((item) => item.innerText.includes('recorded')),
          body: [...document.querySelectorAll('.replay-cards .toolcard-feedback')].some((item) => item.innerText.includes('P1_LIVE_READ_OK')),
          route: window.location.hash,
          pageText: document.body.innerText.slice(0, 1200),
        }
      })()`);
      if (replayUi.cards.length > 0) break;
    } catch {
      // 回放页正在切换或等待 IPC 数据。
    }
    await delay(250);
  }
  if (replayUi.cards.length > 0) {
    await reopenedCdp.eval(`(() => {
      const card = document.querySelector('.replay-cards .toolcard')
      card?.querySelector('.toolcard-head')?.click()
    })()`);
    const expandedDeadline = Date.now() + 5000;
    while (Date.now() < expandedDeadline) {
      const actionsReady = await reopenedCdp.eval(`(() => document.querySelectorAll('.replay-cards .toolcard-actions button').length >= 2)()`);
      if (actionsReady) break;
      await delay(100);
    }
    await reopenedCdp.eval(`(() => {
      const card = document.querySelector('.replay-cards .toolcard')
      const why = [...(card?.querySelectorAll('button') ?? [])].find((button) => button.innerText.includes('为什么'))
      why?.click()
      const body = [...(card?.querySelectorAll('button') ?? [])].find((button) => button.innerText.includes('查看完整正文'))
      body?.click()
    })()`);
    const interactionDeadline = Date.now() + 10000;
    while (Date.now() < interactionDeadline) {
      replayUi = await reopenedCdp.eval(`(() => ({
        cards: [...document.querySelectorAll('.replay-cards .toolcard')].map((card) => card.innerText),
        titles: [...document.querySelectorAll('.replay-cards .toolcard-title')].map((item) => item.innerText),
        why: [...document.querySelectorAll('.replay-cards .toolcard-feedback')].some((item) => item.innerText.includes('recorded')),
        body: [...document.querySelectorAll('.replay-cards .toolcard-feedback')].some((item) => item.innerText.includes('P1_LIVE_READ_OK')),
        route: window.location.hash,
        pageText: document.body.innerText.slice(0, 1200),
      }))()`);
      if (replayUi.why && replayUi.body) break;
      await delay(250);
    }
  }
  console.log("⑩ 回放工具卡交互:", JSON.stringify({ titles: replayUi.titles, why: replayUi.why, body: replayUi.body }));
  if (
    replayUi.cards.length === 0 ||
    !replayUi.why ||
    !replayUi.body ||
    replayUi.titles.some((title) => /·\s*(read|write|edit|shell|glob|grep)\b/i.test(title))
  ) {
    throw new Error(`回放工具卡交互不完整：${JSON.stringify(replayUi)}`);
  }

  const diffReplay = await reopenedCdp.eval(`(async () => {
    const items = [...document.querySelectorAll('.replay-item')]
    for (const item of items) {
      if (!(item instanceof HTMLElement)) continue
      item.click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const card = document.querySelector('.replay-cards .toolcard-diff')
      if (!(card instanceof HTMLElement)) continue
      card.querySelector('.toolcard-head')?.click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return {
        found: true,
        additions: [...card.querySelectorAll('.tool-diff-line.add')].map((line) => line.textContent ?? ''),
      }
    }
    return { found: false, additions: [] }
  })()`)
  console.log("⑩b 回放写入 diff:", JSON.stringify(diffReplay));
  if (!diffReplay.found || !diffReplay.additions.some((line) => line.includes('P1_LIVE_WRITE_OK'))) {
    throw new Error(`重开后的回放没有呈现 write diff：${JSON.stringify(diffReplay)}`);
  }

  const errored = dom.text.includes("没能跑起来");
  const turns = (dom.text.match(/Lcode/g) ?? []).length;
  const replied = turns >= 2 && !errored;
  console.log(
    replied
      ? `\n✅ 真实模型多轮对话通过（${turns} 条助手回复）`
      : errored
        ? "\n❌ 真实模型对话失败（界面报错）"
        : `\n❌ 只拿到 ${turns} 条助手回复（期望 2）`,
  );
  if (!replied) {
    console.log("\n--- electron 日志 ---");
    console.log(logs.join("").split("\n").slice(-40).join("\n"));
  }
  await stopElectron(reopenedChild);
  process.exit(replied ? 0 : 1);
} catch (err) {
  console.error("冒烟失败：", err.message ?? err);
  console.log("\n--- electron 日志 ---");
  console.log(logs.join("").split("\n").slice(-40).join("\n"));
  await stopElectron(child);
  await stopElectron(reopenedChild);
  process.exit(1);
}
