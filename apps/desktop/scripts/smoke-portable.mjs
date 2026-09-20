import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

/**
 * 在一个全新的 userData + LCODE_HOME 下验收 portable：
 *
 * - 首启必须暴露完整 preload 桥，且首页渲染文本不含内部术语；
 * - 通过真实 IPC 写入一个不联网的测试模型和会话；
 * - 重启后两项记录仍存在，证明 Electron ABI SQLite、JSONL 和配置落盘随包可用。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const executable = join(root, 'out', 'lcode-win32-x64', 'Lcode.exe')
const userData = mkdtempSync(join(tmpdir(), 'lcode-portable-user-data-'))
const lcodeHome = mkdtempSync(join(tmpdir(), 'lcode-portable-home-'))
const forbiddenUiTerms = [
  'tool/result', 'turn/end', 'session/event', 'presentationMeta', 'surfaceOp',
  'EpochHeader', 'ModelSelection', 'ABORTED_BEFORE_DISPATCH',
  'CREDENTIAL_REJECTED', 'TOOL_TIMEOUT', '不变量 I1', 'ADR-0022', 'seq ',
  'surface replace', 'fail-closed', '单调守卫', '水滴/洋葱', '插件降级',
  '派发模式', '回放态', '请求快照', 'todo_write',
]
const jsonOutput = process.argv.includes('--json')

async function main() {
try {
  const first = await launchPortable()
  let sessionId
  try {
    const cdp = await connect(first.port)
    try {
      const initial = await waitForRenderer(cdp)
      if (!initial.bridge.session || !initial.bridge.model) throw new Error('portable preload 桥不完整')
      const hits = forbiddenUiTerms.filter((term) => initial.text.includes(term))
      if (hits.length > 0) throw new Error(`portable 首页出现内部术语：${hits.join(', ')}`)
      const rendererFrames = await measureRendererFrames(cdp)

      await cdp.eval(`(async () => window.lcode.model.save({
        label: 'portable-smoke',
        model: 'portable-smoke-model',
        base_url: 'http://127.0.0.1:11434',
        api_key: 'portable-smoke-key',
      }))()`)
      sessionId = await cdp.eval(`(async () => {
        const created = await window.lcode.session.create({
          cwd: ${JSON.stringify(lcodeHome)},
          title: 'Portable 空环境验收',
        })
        return created.session_id
      })()`)
      first.rendererFrames = rendererFrames
      report(`portable 首启通过：${first.elapsedMs} ms；renderer ${rendererFrames.fps} fps（P95 ${rendererFrames.p95Ms} ms）；已写入模型和会话`)
    } finally {
      cdp.close()
    }
  } finally {
    await stopPortable(first)
  }

  const second = await launchPortable()
  try {
    const cdp = await connect(second.port)
    try {
      const persisted = await cdp.eval(`(async () => ({
        models: await window.lcode.model.list(),
        defaultModel: await window.lcode.model.getDefault(),
        sessions: await window.lcode.session.list(),
      }))()`)
      const savedModel = persisted.models.custom.some((item) => item.label === 'portable-smoke' && item.model === 'portable-smoke-model')
      const savedSession = persisted.sessions.items.some((item) => item.session_id === sessionId && item.title === 'Portable 空环境验收')
      if (!savedModel || persisted.defaultModel === null || !savedSession) {
        throw new Error(`portable 重启后落盘记录不完整：${JSON.stringify({ savedModel, defaultModel: persisted.defaultModel, savedSession })}`)
      }
      report(`portable 重启持久化通过：${second.elapsedMs} ms`)
      return { firstStartMs: first.elapsedMs, restartStartMs: second.elapsedMs, rendererFrames: first.rendererFrames }
    } finally {
      cdp.close()
    }
  } finally {
    await stopPortable(second)
  }
} finally {
  // Windows 上 Electron 退出后网络服务会短暂持有 Chromium 缓存文件。
  // 清理失败只留下诊断，不能覆盖前面真正的验收失败。
  await removeTemporary(userData)
  await removeTemporary(lcodeHome)
}

function report(message) {
  if (!jsonOutput) console.log(message)
}
}

async function launchPortable() {
  const port = 19000 + Math.floor(Math.random() * 1000)
  const startedAt = performance.now()
  const child = spawn(executable, ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: dirname(executable),
    env: { ...process.env, LCODE_HOME: lcodeHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const running = { child, closed: false, port }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.once('close', () => { running.closed = true })
  const ready = await waitForDevTools(port, child, 10000)
  if (!ready) {
    await stopPortable(running)
    throw new Error(`portable 应用未在 10s 内出现可交互端点\n${output}`)
  }
  return { ...running, elapsedMs: Math.round(performance.now() - startedAt) }
}

async function stopPortable(running) {
  if (!running.child.killed && running.child.exitCode === null) running.child.kill()
  if (!running.closed) await new Promise((resolveDone) => running.child.once('close', resolveDone))
}

async function removeTemporary(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      if (attempt === 7) {
        console.error(`portable 临时目录清理失败（不影响验收结果）：${path}`, error)
        return
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
  }
}

async function waitForDevTools(portNumber, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) return false
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/json/version`)
      if (response.ok) {
        const body = await response.json()
        if (typeof body.webSocketDebuggerUrl === 'string') return true
      }
    } catch {
      // Electron 启动期间端口尚未监听，继续轮询。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return false
}

async function connect(port) {
  const deadline = Date.now() + 10000
  let lastTargets = []
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      lastTargets = targets.map((target) => ({ type: target.type, url: target.url }))
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith('file://'))
      if (page?.webSocketDebuggerUrl !== undefined) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolveOpen, rejectOpen) => {
          ws.addEventListener('open', resolveOpen, { once: true })
          ws.addEventListener('error', rejectOpen, { once: true })
        })
        return new Cdp(ws)
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      // 渲染器尚未创建，或调试 WebSocket 正在初始化，继续等待。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`portable 应用未创建可调试的渲染页面：${JSON.stringify(lastTargets)}；最后错误：${lastError}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const complete = this.pending.get(message.id)
      if (complete !== undefined) {
        this.pending.delete(message.id)
        complete(message)
      }
    })
  }

  eval(expression) {
    const id = ++this.id
    return new Promise((resolveEval, rejectEval) => {
      this.pending.set(id, (message) => {
        if (message.error !== undefined || message.result?.exceptionDetails !== undefined) {
          rejectEval(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
          return
        }
        resolveEval(message.result?.result?.value)
      })
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
    })
  }

  close() {
    this.ws.close()
  }
}

async function waitForRenderer(cdp) {
  const deadline = Date.now() + 10000
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const state = await cdp.eval(`(() => ({
        bodyReady: document.body !== null,
        bridge: {
          session: typeof window.lcode?.session?.create === 'function',
          model: typeof window.lcode?.model?.save === 'function',
        },
        text: document.body?.innerText ?? '',
      }))()`)
      if (state.bodyReady && state.bridge.session && state.bridge.model && state.text.trim() !== '') return state
    } catch (error) {
      // 首帧重载会短暂销毁执行上下文；下一次 evaluate 会进入新上下文。
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`portable 渲染器或 preload 桥未在 10s 内就绪：${lastError}`)
}

/** 用 rAF 在真实 Electron 渲染器采样空闲帧间隔，不把估算值当成帧率。 */
async function measureRendererFrames(cdp) {
  const deadline = Date.now() + 15000
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      return await cdp.eval(`new Promise((resolve) => {
        const intervals = []
        let previous = null
        const collect = (time) => {
          if (previous !== null) intervals.push(time - previous)
          previous = time
          if (intervals.length < 120) {
            requestAnimationFrame(collect)
            return
          }
          const sorted = [...intervals].sort((a, b) => a - b)
          const median = sorted[Math.floor(sorted.length / 2)]
          const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
          resolve({ fps: Math.round(1000 / median), medianMs: Math.round(median * 100) / 100, p95Ms: Math.round(p95 * 100) / 100 })
        }
        requestAnimationFrame(collect)
      })`)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error(`portable renderer 帧率采样超时：${lastError}`)
}

const result = await main()
if (jsonOutput) console.log(JSON.stringify(result))
