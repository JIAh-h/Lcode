import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 端到端冒烟：**越界写会弹审批，且拒绝之后文件真的没被写**（M-SEC-02 / M-PERM-02）。
 *
 * 这是整个权限链最该被真实验证的一条：
 * 「策略判定 → 弹窗 → 用户拒绝 → **副作用没有发生**」。
 * 单测里都验过了，但接缝（IPC 通道、弹窗、拒绝传回内核）只有真启动才看得见。
 *
 * 两条路径都跑：
 *   ① 拒绝 → 文件不存在
 *   ② 允许 → 文件存在（证明"允许"这条路也是通的，不是恒拒）
 */

const HOME = process.env.LCODE_HOME;
if (HOME === undefined || HOME === "") throw new Error("需要 LCODE_HOME");

const FAKE_SERVER = fileURLToPath(
  new URL("./fake-model-server.mjs", import.meta.url),
);

const ELECTRON = fileURLToPath(
  new URL(
    "../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe",
    import.meta.url,
  ),
);
const PORT = 9228;
const WORKSPACE = join(HOME, "ws");
/** 目标：**工作区之外**（`ws` 的兄弟目录） */
const OUTSIDE = join(HOME, "OUTSIDE");

rmSync(WORKSPACE, { recursive: true, force: true });
rmSync(OUTSIDE, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });
const target = join(OUTSIDE, "escaped.txt");

/**
 * **自带假服务端**，不复用外面的进程。
 *
 * 踩过：复用 8897 上残留的旧进程，测的是旧逻辑，结果"看起来没弹审批"——
 * 排查了半天才发现打的是另一个服务端。冒烟脚本自己拉服务，端口与行为都归它管。
 */
const PORT_FAKE = 8896;
const fakeServer = spawn(process.execPath, [FAKE_SERVER], {
  env: {
    ...process.env,
    FAKE_PORT: String(PORT_FAKE),
    // 让它写一个**工作区之外**的绝对路径 —— 这才会触发审批。
    // 相对路径会按会话工作区解析、落在里面，那时候放行是对的（那正是它该做的）
    FAKE_TOOL: "write",
    FAKE_TOOL_ARGS: JSON.stringify({ path: target, content: "LEAKED" }),
    FAKE_FINAL: "走完了",
  },
  stdio: "ignore",
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
    ...(process.env.LCODE_ELECTRON_USER_DATA_DIR
      ? [`--user-data-dir=${process.env.LCODE_ELECTRON_USER_DATA_DIR}`]
      : []),
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

async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
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
    this.events = [];
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
      } else if (msg.method === "Runtime.consoleAPICalled") {
        this.events.push(msg.params);
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

let cdp;
try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  cdp = new Cdp(ws);

  // 在**页面里**挂一个审批拦截：拿到问题就按给定答案回答
  await cdp.eval(`(() => {
    window.__seenApprovals = []
    window.lcode.approval.onAsked((req) => { window.__seenApprovals.push(req) })
    return 'hooked'
  })()`);

  await cdp.eval(`(async () => {
    await window.lcode.model.save({ label: 'ap', model: 'm', base_url: 'http://127.0.0.1:8896', api_key: 'sk-x' })
  })()`);

  const runTurn = async (answer) => {
    // 让页面自己回答：监听 → 立刻用给定答案回
    await cdp.eval(`(() => {
      window.__answer = ${JSON.stringify(answer)}
      if (!window.__autoAnswer) {
        window.__autoAnswer = true
        window.lcode.approval.onAsked((req) => {
          void window.lcode.approval.answer({ callId: req.callId, result: window.__answer })
        })
      }
      return 'ok'
    })()`);
    const sessionId = await cdp.eval(`(async () => {
      const created = await window.lcode.session.create({ cwd: ${JSON.stringify(WORKSPACE)}, title: '审批冒烟' })
      await window.lcode.agent.send({ session_id: created.session_id, text: '写到外面去' })
      return created.session_id
    })()`);
    await delay(9000);
    return sessionId;
  };

  // ── ① 拒绝 ──
  const s1 = await runTurn("rejected");
  const seen1 = await cdp.eval("window.__seenApprovals.length");
  console.log(
    `① 拒绝路径：收到 ${seen1} 个审批请求；文件存在 = ${existsSync(target)}`,
  );
  const dom1 = await cdp.eval(`(() => {
    const el = document.querySelector('.sessionstream')
    return el ? el.innerText : ''
  })()`);
  console.log("   界面:", JSON.stringify(dom1).slice(0, 200));
  if (existsSync(target)) {
    console.log("\n❌ 拒绝之后文件**仍然被写了** —— 拦截失效");
    fakeServer.kill();
    child.kill();
    process.exit(1);
  }
  if (seen1 < 1) {
    console.log("\n❌ 越界写没有弹审批（策略没命中）");
    console.log(logs.join("").split("\n").slice(-30).join("\n"));
    fakeServer.kill();
    child.kill();
    process.exit(1);
  }
  console.log("   ✅ 拒绝之后文件不存在");

  // 审批事实必须能从权威日志经 IPC 读回，而不是只存在于当时的弹窗状态。
  const trace = await cdp.eval(`(async () => {
    const opened = await window.lcode.session.open(${JSON.stringify(s1)})
    const call = opened.events.find((event) => event.type === 'tool/call')
    if (!call) return null
    return window.lcode.session.why({ session_id: ${JSON.stringify(s1)}, call_seq: call.seq })
  })()`);
  console.log("   历史解释:", JSON.stringify(trace));
  if (trace?.approval?.status !== "rejected" || trace?.policy?.status !== "recorded") {
    console.log("\n❌ 历史解释没有还原审批拒绝");
    fakeServer.kill();
    child.kill();
    process.exit(1);
  }

  void s1;

  // ── ② 允许（证明"允许"这条路通，不是恒拒）──
  const s2 = await runTurn("allowed-once");
  console.log(`② 允许路径：文件存在 = ${existsSync(target)}`);
  if (!existsSync(target)) {
    console.log('\n❌ 允许之后文件仍然不存在 —— "允许"这条路没通');
    fakeServer.kill();
    child.kill();
    process.exit(1);
  }
  console.log("   ✅ 允许之后文件被写了");
  void s2;

  console.log("\n✅ 审批闭环通过：越界 → 弹窗 → 拒绝拦住 / 允许放行");
  fakeServer.kill();
  child.kill();
  process.exit(0);
} catch (err) {
  console.error("冒烟失败：", err.message ?? err);
  console.log("\n--- electron 日志 ---");
  console.log(logs.join("").split("\n").slice(-40).join("\n"));
  fakeServer.kill();
  child.kill();
  process.exit(1);
}
