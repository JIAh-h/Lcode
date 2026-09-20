import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 端到端冒烟：**模型配置 → 默认模型 → 发消息** 这条链路。
 *
 * 为什么需要它：单测证明了每一层各自正确，但"设置页保存模型"这件事在真实应用里
 * 要穿过渲染层 → preload → IPC → 装配层四道缝，而**这些缝恰恰是最容易断的地方**——
 * 断了在终端里毫无提示（`model.setDefault` 从来没被调用过就是这么漏掉的）。
 *
 * 假服务端见 `fake-model-server.mjs`（**自带**，纯文本模式）。
 */

const HOME = process.env.LCODE_HOME;
if (HOME === undefined || HOME === "") throw new Error("需要 LCODE_HOME");

const FAKE_SERVER = fileURLToPath(
  new URL("./fake-model-server.mjs", import.meta.url),
);
const PORT_FAKE = 8894;

const fakeServer = spawn(process.execPath, [FAKE_SERVER], {
  env: { ...process.env, FAKE_PORT: String(PORT_FAKE), FAKE_MODE: "text" },
  stdio: "ignore",
});

const ELECTRON = fileURLToPath(
  new URL(
    "../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe",
    import.meta.url,
  ),
);
const PORT = 9223;

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

function fail(step, err) {
  console.error(`\n❌ ${step}：${err.message ?? err}`);
  console.log("\n--- electron 日志 ---");
  console.log(logs.join("").split("\n").slice(-40).join("\n"));
  fakeServer.kill();
  child.kill();
  process.exit(1);
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

  await cdp.eval(
    `(() => { const l = window.lcode; return !!l?.model && !!l?.agent })()`,
  );

  // ── ① 保存一个模型：显示名 ≠ 服务端模型 id ──
  // 用假 key（假服务端不看鉴权）。**必须给 key**：`api_key_ref` 非空却没值时，
  // 适配器会以 EL-CREDENTIAL_MISSING 中止——那条路径本身是对的，只是不该在这里触发。
  const saved = await cdp.eval(`(async () => {
    return await window.lcode.model.save({
      label: 'local-flash',
      model: 'deepseek-flash',
      base_url: 'http://127.0.0.1:8894',
      api_key: 'sk-smoke-test',
    })
  })()`);
  console.log("① 已保存模型:", JSON.stringify(saved));

  // ── ② 默认模型必须**自动**被设上（这是那个 bug 的核心）──
  const def = await cdp.eval(
    `(async () => await window.lcode.model.getDefault())()`,
  );
  console.log("② getDefault:", JSON.stringify(def));
  if (def === null || def.provider === undefined) {
    fail(
      "② 默认模型没有被自动设置",
      new Error(
        "getDefault 返回空——用户保存后再发消息仍会报 EL-NO_MODEL_CONFIGURED",
      ),
    );
  }

  // 清单里必须带出 model 字段（渲染层据此填默认模型）
  const list = await cdp.eval(
    `(async () => await window.lcode.model.list())()`,
  );
  const entry = (list.custom ?? [])[0];
  console.log("③ listCustom[0]:", JSON.stringify(entry));
  if (entry?.model !== "deepseek-flash") {
    fail("③ 清单里缺 model 字段", new Error(`拿到 ${JSON.stringify(entry)}`));
  }

  // ── ④ 建会话并发送：这一步以前必抛 EL-NO_MODEL_CONFIGURED ──
  const result = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e', title: '模型链路冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '你好' })
    return created.session_id
  })()`);
  console.log("④ 已建会话并发送:", result);

  await delay(4000);
  await cdp.eval(`(() => { window.location.hash = '#/sessions/${result}' })()`);
  await delay(2500);

  const dom = await cdp.eval(`(() => {
    const el = document.querySelector('.sessionstream')
    return { exists: !!el, text: el ? el.innerText : '' }
  })()`);
  console.log("⑤ 会话流渲染:", JSON.stringify(dom.text).slice(0, 220));

  const ok = dom.exists && dom.text.includes("真实的流式回复");
  console.log(
    ok ? "\n✅ 模型配置 → 默认模型 → 流式回复 全链路通过" : "\n❌ 未渲染出回复",
  );
  if (!ok) {
    console.log("\n--- electron 日志 ---");
    console.log(logs.join("").split("\n").slice(-30).join("\n"));
  }
  fakeServer.kill();
  child.kill();
  process.exit(ok ? 0 : 1);
} catch (err) {
  fail("冒烟异常", err);
}
