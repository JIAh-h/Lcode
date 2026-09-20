import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 端到端冒烟：**失败路径必须给出可读的原因**。
 *
 * 背景（实测踩过）：配一个**没有密钥**的云端供应商，地址与模型名都对，发消息后
 * 引擎静默失败——`turn/end {reason:'error'}` 不带原因，而被拒的 Promise 落在
 * `enqueue` 的空 settle 上。结果是：用户消息在、回复空白、没有报错、没有 spinner，
 * 从"点了发送"到"什么都没发生"之间**没有任何线索**。
 *
 * 这个冒烟就盯这一条：失败要看得见。
 */

const HOME = process.env.LCODE_HOME;
if (HOME === undefined || HOME === "") throw new Error("需要 LCODE_HOME");

const ELECTRON = fileURLToPath(
  new URL(
    "../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe",
    import.meta.url,
  ),
);
const PORT = 9224;

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

let cdp;
let failed = false;
try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  cdp = new Cdp(ws);

  // ① 配一个**没有密钥**的云端供应商：ref 非空但解析不出值 → EL-CREDENTIAL_MISSING
  await cdp.eval(`(async () => {
    return await window.lcode.model.save({
      label: '没密钥的云端',
      model: 'gpt-4o',
      base_url: 'https://api.example.invalid/v1',
      api_key: '',
    })
  })()`);
  console.log("① 已保存一个没有密钥的供应商");

  // ② 发消息
  const sessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e', title: '失败路径冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '你好' })
    return created.session_id
  })()`);
  console.log("② 已发送:", sessionId);

  // ③ 切到工作台，等失败提示出现
  await cdp.eval(
    `(() => { window.location.hash = '#/sessions/${sessionId}' })()`,
  );
  await delay(6000);

  const dom = await cdp.eval(`(() => {
    const el = document.querySelector('.sessionstream')
    return { exists: !!el, text: el ? el.innerText : '' }
  })()`);
  console.log("③ 界面文本:", JSON.stringify(dom.text).slice(0, 300));

  const showsReason =
    dom.text.includes("没能跑起来") || dom.text.includes("模型配置");
  console.log(
    showsReason
      ? "\n✅ 失败可见：界面给出了可读原因"
      : "\n❌ 失败静默：界面上没有任何原因",
  );
  failed = !showsReason;
  if (failed) {
    console.log("\n--- electron 日志 ---");
    console.log(logs.join("").split("\n").slice(-30).join("\n"));
  }
  child.kill();
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error("冒烟失败：", err.message ?? err);
  console.log("\n--- electron 日志 ---");
  console.log(logs.join("").split("\n").slice(-30).join("\n"));
  child.kill();
  process.exit(1);
}
