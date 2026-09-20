import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 端到端冒烟：**真启动 Electron**，在渲染进程里走完整条对话链路。
 *
 * 为什么不能只靠单测：`A. 对话闭环` 那个测试证明了「引擎 → JSONL → 索引」是通的，
 * 但它绕过了三样东西——preload 桥、IPC 通道、以及**渲染层到底渲不渲染**。
 * 这三样恰恰是最容易断（而且断了在终端里毫无提示）的地方。
 *
 * 做法：Electron 开 `--remote-debugging-port`，用 CDP（Node 内置 WebSocket）在**真实页面**里：
 * ① 调 preload 桥建会话并发送一句话
 * ② 切到工作台路由
 * ③ 断言 DOM 里出现了流式回复
 *
 * 假服务端见 `fake-model-server.mjs`（**自带**，不复用外部进程——踩过"端口上残留着旧服务端、
 * 测的是旧逻辑"这种极难排查的坑）。纯文本模式：这个冒烟只验对话链路，不卷进工具链。
 */

const HOME = process.env.LCODE_HOME;
if (HOME === undefined || HOME === "") throw new Error("需要 LCODE_HOME");

// 绝对路径：下面 spawn 的 cwd 是 apps/desktop，相对路径会 ENOENT
const FAKE_SERVER = fileURLToPath(
  new URL("./fake-model-server.mjs", import.meta.url),
);
const PORT_FAKE = 8895;

const fakeServer = spawn(process.execPath, [FAKE_SERVER], {
  env: {
    ...process.env,
    FAKE_PORT: String(PORT_FAKE),
    FAKE_MODE: "text",
    FAKE_DELAY_MS: "30",
  },
  stdio: "ignore",
});

const ELECTRON = fileURLToPath(
  new URL(
    "../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe",
    import.meta.url,
  ),
);
const PORT = 9222;

const child = spawn(
  ELECTRON,
  [
    "--no-sandbox",
    "--in-process-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu",
    ".",
    `--remote-debugging-port=${PORT}`,
    ...(process.env.LCODE_ELECTRON_USER_DATA_DIR
      ? [`--user-data-dir=${process.env.LCODE_ELECTRON_USER_DATA_DIR}`]
      : []),
  ],
  {
    cwd: "apps/desktop",
    // **产物模式**：不设 VITE_DEV_SERVER_URL，主进程 loadFile(dist/renderer/index.html)。
    // 依赖 dev server 会让这个冒烟变脆（vite 一挂就全红），而它验的是打包后的真实产物。
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const logs = [];
child.stdout.on("data", (b) => logs.push(String(b)));
child.stderr.on("data", (b) => logs.push(String(b)));

/** 等一个能满足条件的 CDP 页面目标 */
async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) =>
          t.type === "page" &&
          (t.url.startsWith("file://") || t.url.includes("localhost:5173")),
      );
      if (page !== undefined) return page;
    } catch {
      // 还没起来
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
  /** 在页面里求值并取回 JSON 结果 */
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

let cdp;
try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  cdp = new Cdp(ws);

  // ── ① 等渲染层挂好、桥到位 ──
  const bridge = await cdp.eval(`(() => {
    const l = window.lcode
    return {
      session: !!l?.session,
      agent: !!l?.agent,
      model: !!l?.model,
      history: typeof l?.session?.history === 'function',
      body: typeof l?.session?.body === 'function',
      why: typeof l?.session?.why === 'function',
    }
  })()`);
  console.log("① preload 桥:", JSON.stringify(bridge));
  if (!bridge.session || !bridge.agent || !bridge.history || !bridge.body || !bridge.why)
    throw new Error("preload 桥不完整");

  // ── ② 先配好模型（**自包含**：不依赖跑之前恰好配过什么）──
  // 以前这一步是隐含的：脚本假设 LCODE_HOME 里已经有一个配好的模型。
  // 拿一个干净 home 跑就必然 EL-NO_MODEL_CONFIGURED——冒烟脚本不该有这种隐含前提。
  await cdp.eval(`(async () => {
    await window.lcode.model.save({
      label: 'e2e',
      model: 'deepseek-flash',
      base_url: 'http://127.0.0.1:8895',
      api_key: 'sk-smoke-test',
    })
  })()`);
  const def = await cdp.eval(
    `(async () => await window.lcode.model.getDefault())()`,
  );
  console.log("② 默认模型:", JSON.stringify(def));
  if (def === null)
    throw new Error("默认模型没配上，后续必然报 EL-NO_MODEL_CONFIGURED");

  // ── ③ 建会话并发送（走真实 IPC → 引擎 → 真实适配器 → 假服务端）──
  const sent = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e', title: '端到端冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '你好，介绍一下你自己' })
    return created.session_id
  })()`);
  console.log("③ 已建会话并发送:", sent);

  // 给引擎一点时间跑完（真实流式 + 落盘）
  await delay(4000);

  /*
   * ── ③b **同一个会话再说一句** ──
   *
   * 这一步以前没有，于是漏掉了一个真 bug：`agent.send` 用了 `agents.create`，
   * 而按 D17 agent id 就是 session id，第二次说话必然撞 `EC-CONFLICT`（"agent 已存在"）。
   * 表现是"第一句能发、第二句就报错"——只发一条消息的冒烟永远看不见。
   *
   * 多轮是最普通的用法，所以这里必须覆盖：幂等的是 `agents.resume`，不是 `create`。
   */
  const second = await cdp.eval(`(async () => {
    try {
      await window.lcode.agent.send({ session_id: ${JSON.stringify(sent)}, text: '再问一句' })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) }
    }
  })()`);
  console.log(
    "③b 同一会话再发一句:",
    second.ok ? "接受" : `❌ 被拒：${second.message}`,
  );
  if (!second.ok) throw new Error(`多轮发言被拒：${second.message}`);

  await delay(4000);

  // ── ③c 历史投影走主进程 IPC，不让 renderer 重新拼模型请求 ──
  const history = await cdp.eval(`(async () => {
    const snapshot = await window.lcode.session.history({ session_id: ${JSON.stringify(sent)}, up_to_seq: 999999 })
    const body = await window.lcode.session.body({ session_id: ${JSON.stringify(sent)}, seq: 0 })
    return { hasHeader: !!snapshot.header, messages: snapshot.messages.length, bodyBytes: body.bytes, ref: body.ref }
  })()`);
  console.log("③c 历史 IPC:", JSON.stringify(history));
  if (!history.hasHeader || history.messages < 1 || history.bodyBytes < 1 || !String(history.ref).startsWith("event:"))
    throw new Error("历史 IPC 返回不完整");

  // ── ③d 在真实页面点击“暂停 → 继续”──
  const pausedSession = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e', title: '暂停续跑冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '请完成一段会被暂停的任务' })
    window.location.hash = '#/sessions/' + created.session_id
    return created.session_id
  })()`);
  await delay(180);
  const pauseButton = await cdp.eval(`(() => {
    const button = document.querySelector('.send')
    return { label: button?.getAttribute('aria-label'), text: button?.textContent }
  })()`);
  if (pauseButton.label !== '暂停' || pauseButton.text !== '■')
    throw new Error(`暂停按钮状态不正确：${JSON.stringify(pauseButton)}`);
  await cdp.eval(`(() => document.querySelector('.send')?.click())()`);
  await delay(250);
  const resumeButton = await cdp.eval(`(() => {
    const button = document.querySelector('.send')
    return { label: button?.getAttribute('aria-label'), text: button?.textContent }
  })()`);
  if (resumeButton.label !== '继续' || resumeButton.text !== '▶')
    throw new Error(`继续按钮状态不正确：${JSON.stringify(resumeButton)}`);
  await cdp.eval(`(() => document.querySelector('.send')?.click())()`);
  await delay(1800);
  const pausedHistory = await cdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(pausedSession)})
    const events = opened.events
    return {
      users: events.filter((event) => event.type === 'user/message').length,
      reasons: events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason),
      resumedSystem: events.filter((event) => event.type === 'request/header').at(-1)?.data?.header?.system ?? '',
    }
  })()`);
  console.log("③d 暂停/续跑:", JSON.stringify(pausedHistory));
  if (
    pausedHistory.users !== 1 ||
    JSON.stringify(pausedHistory.reasons) !== JSON.stringify(['cancelled', 'completed']) ||
    !String(pausedHistory.resumedSystem).includes('继续未完成的任务')
  ) {
    throw new Error(`暂停/续跑日志不符合预期：${JSON.stringify(pausedHistory)}`);
  }

  // ── ④ 切到工作台并断言 DOM 里出现了回复 ──
  await cdp.eval(`(() => { window.location.hash = '#/sessions/${sent}' })()`);
  await delay(2500);
  const dom = await cdp.eval(`(() => {
    const el = document.querySelector('.sessionstream')
    return { exists: !!el, text: el ? el.innerText : '' }
  })()`);
  console.log("④ 会话流 DOM:", dom.exists ? "存在" : "❌ 不存在");
  console.log("   渲染文本:", JSON.stringify(dom.text).slice(0, 220));

  // 断言"两轮用户输入都进了界面"且"助手给出了回复"——具体回什么由假服务端决定，
  // 所以不去钉死文案（钉死的话，换一次假服务端的返回就得改测试，而它要验的是**链路**）
  const assistantText = dom.text.split("Lcode").slice(1).join("Lcode").trim();
  const ok =
    dom.exists &&
    dom.text.includes("你好，介绍一下你自己") &&
    dom.text.includes("再问一句") &&
    assistantText !== "";
  console.log(
    ok
      ? "\n✅ 端到端通过：多轮输入 → 流式回复 → 渲染到界面"
      : "\n❌ 端到端失败",
  );
  if (!ok) {
    console.log("\n--- electron 日志 ---");
    console.log(logs.join("").split("\n").slice(-30).join("\n"));
  }
  fakeServer.kill();
  child.kill();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error("冒烟失败：", err.message);
  console.log("\n--- electron 日志 ---");
  console.log(logs.join("").split("\n").slice(-30).join("\n"));
  fakeServer.kill();
  child.kill();
  process.exit(1);
}
