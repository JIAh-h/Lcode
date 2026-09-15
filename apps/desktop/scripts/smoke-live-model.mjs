import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 端到端冒烟：**真实模型**（不放假服务端）。
 *
 * 为什么单独留一个：假服务端太好了——它永远返回格式完美的 SSE。真实供应商会带
 * `"usage": null`、会 400、会缺字段，而这些恰恰是"测试连接成功但对话失败"的来源。
 * 这个脚本直接打用户配置里的那个端点，报出真正的错误。
 *
 * 需要 LCODE_E2E_LIVE=1 才跑（默认不跑：它会产生真实的 API 调用与费用）。
 */

const HOME = process.env.LCODE_HOME
if (HOME === undefined || HOME === '') throw new Error('需要 LCODE_HOME')
if (process.env.LCODE_E2E_LIVE !== '1') {
  console.log('跳过：这是真实模型冒烟，需要显式设 LCODE_E2E_LIVE=1')
  process.exit(0)
}

const ELECTRON = fileURLToPath(
  new URL('../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe', import.meta.url),
)
const PORT = 9226

const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: 'apps/desktop',
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
child.stdout.on('data', (b) => logs.push(String(b)))
child.stderr.on('data', (b) => logs.push(String(b)))

async function findPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file://'))
      if (page !== undefined) return page
    } catch {
      /* 还没起来 */
    }
    await delay(500)
  }
  throw new Error('等不到可调试的页面目标')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const resolve = this.pending.get(msg.id)
      if (resolve !== undefined) {
        this.pending.delete(msg.id)
        resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r?.exceptionDetails === undefined ? resolve(r) : reject(new Error(JSON.stringify(r.exceptionDetails)))))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页面内报错：${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`)
    }
    return r.result?.value
  }
}

let cdp
try {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  cdp = new Cdp(ws)

  const def = await cdp.eval(`(async () => await window.lcode.model.getDefault())()`)
  console.log('① 默认模型:', JSON.stringify(def))
  if (def === null) throw new Error('没有默认模型，先去设置页配一个')

  const sessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: '/repo/e2e-live', title: '真实模型冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '只回答四个字：你好世界' })
    return created.session_id
  })()`)
  console.log('② 已发送:', sessionId)

  await cdp.eval(`(() => { window.location.hash = '#/sessions/${sessionId}' })()`)
  await delay(20000)

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
  })()`)
  console.log('③ 同一会话再发一句:', second.ok ? '接受' : `❌ 被拒：${second.message}`)
  if (!second.ok) throw new Error(`多轮发言被拒：${second.message}`)
  await delay(20000)

  const dom = await cdp.eval(`(() => {
    const el = document.querySelector('.sessionstream')
    return { exists: !!el, text: el ? el.innerText : '' }
  })()`)
  console.log('④ 界面文本:', JSON.stringify(dom.text).slice(0, 400))

  const errored = dom.text.includes('没能跑起来')
  const turns = (dom.text.match(/Lcode/g) ?? []).length
  const replied = turns >= 2 && !errored
  console.log(
    replied
      ? `\n✅ 真实模型多轮对话通过（${turns} 条助手回复）`
      : errored
        ? '\n❌ 真实模型对话失败（界面报错）'
        : `\n❌ 只拿到 ${turns} 条助手回复（期望 2）`,
  )
  if (!replied) {
    console.log('\n--- electron 日志 ---')
    console.log(logs.join('').split('\n').slice(-40).join('\n'))
  }
  child.kill()
  process.exit(replied ? 0 : 1)
} catch (err) {
  console.error('冒烟失败：', err.message ?? err)
  console.log('\n--- electron 日志 ---')
  console.log(logs.join('').split('\n').slice(-40).join('\n'))
  child.kill()
  process.exit(1)
}
