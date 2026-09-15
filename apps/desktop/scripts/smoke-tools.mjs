import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 端到端冒烟：**真实模型用真实工具读真实文件**。
 *
 * 为什么必须真启动：工具链要穿过「模型决定调哪个工具 → 参数解析 → 策略判定 →
 * （可能审批）→ 工具体 → 结果回到模型」这一整圈。单元测试证明了每一段，
 * 但**接缝**只有真跑一次才看得见。
 *
 * 假服务端见 `fake-model-server.mjs`（自带、不复用外部进程——踩过"端口上残留着
 * 旧服务端、测的是旧逻辑"这种极难排查的坑）。
 */

const HOME = process.env.LCODE_HOME
if (HOME === undefined || HOME === '') throw new Error('需要 LCODE_HOME')

const FAKE_SERVER = fileURLToPath(new URL('./fake-model-server.mjs', import.meta.url))

const ELECTRON = fileURLToPath(
  new URL('../../../node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron.exe', import.meta.url),
)
const PORT = 9227
const PORT_FAKE = 8898
/** 工作区：冒烟期间建一个真文件让模型读 */
const WORKSPACE = join(HOME, 'ws')

rmSync(WORKSPACE, { recursive: true, force: true })
mkdirSync(WORKSPACE, { recursive: true })
writeFileSync(join(WORKSPACE, 'hello.txt'), 'SECRET_MARKER_12345\n第二行\n', 'utf8')

const fakeServer = spawn(process.execPath, [FAKE_SERVER], {
  env: { ...process.env, FAKE_PORT: String(PORT_FAKE) },
  stdio: 'ignore',
})

const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: 'apps/desktop',
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
child.stdout.on('data', (b) => logs.push(String(b)))
child.stderr.on('data', (b) => logs.push(String(b)))

function cleanup() {
  fakeServer.kill()
  child.kill()
}

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
      this.pending.set(id, (r) =>
        r?.exceptionDetails === undefined ? resolve(r) : reject(new Error(JSON.stringify(r.exceptionDetails))),
      )
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

  const bridge = await cdp.eval(`(() => {
    const l = window.lcode
    return { session: !!l?.session, agent: !!l?.agent, model: !!l?.model, approval: !!l?.approval }
  })()`)
  console.log('① preload 桥:', JSON.stringify(bridge))
  if (!bridge.approval) throw new Error('审批桥没暴露')

  await cdp.eval(`(async () => {
    await window.lcode.model.save({
      label: 'tools-e2e',
      model: 'deepseek-flash',
      base_url: 'http://127.0.0.1:${PORT_FAKE}',
      api_key: 'sk-smoke',
    })
  })()`)

  // 建会话（cwd 指向冒烟工作区，含那个真文件）
  const sessionId = await cdp.eval(`(async () => {
    const created = await window.lcode.session.create({ cwd: ${JSON.stringify(WORKSPACE)}, title: '工具冒烟' })
    await window.lcode.agent.send({ session_id: created.session_id, text: '读一下 hello.txt' })
    return created.session_id
  })()`)
  console.log('② 已建会话并发送:', sessionId)

  // 等"调工具 → 拿结果 → 再回答"这整圈跑完
  await delay(9000)
  await cdp.eval(`(() => { window.location.hash = '#/sessions/${sessionId}' })()`)
  await delay(2000)

  const dom = await cdp.eval(`(() => {
    const el = document.querySelector('.sessionstream')
    return { exists: !!el, text: el ? el.innerText : '' }
  })()`)
  console.log('③ 界面文本:', JSON.stringify(dom.text).slice(0, 400))

  // 关键断言：要看得到**文件内容**（证明工具真的执行了、结果回到了模型）
  const sawFileContent = dom.text.includes('SECRET_MARKER_12345')
  const sawError = dom.text.includes('没能跑起来')
  const ok = sawFileContent && !sawError
  console.log(
    ok
      ? '\n✅ 工具链通过：模型调 read → 读到真实文件 → 内容回到模型'
      : sawError
        ? '\n❌ 这一轮失败了'
        : '\n❌ 没看到工具读到的文件内容',
  )
  if (!ok) {
    console.log('\n--- electron 日志 ---')
    console.log(logs.join('').split('\n').slice(-30).join('\n'))
  }
  cleanup()
  process.exit(ok ? 0 : 1)
} catch (err) {
  console.error('冒烟失败：', err.message ?? err)
  console.log('\n--- electron 日志 ---')
  console.log(logs.join('').split('\n').slice(-30).join('\n'))
  cleanup()
  process.exit(1)
}
