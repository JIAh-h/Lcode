import type { CodeRunResult, CodeRuntime } from '@lcode/code-runtime'
import type { SandboxService } from '@lcode/sandbox'
import type { SubprocessService } from '@lcode/subprocess'
import { isJsonValue } from '@lcode/util'

const MAX_PROGRAM_CHARS = 80_000
const MAX_LOG_LINES = 200
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 子进程 provider 只在 `sandbox.wrap()` 确认真正强制时运行。
 * 模型程序被放进只读、无网络的子进程；所有有副作用的能力只能经 `invoke()` 回到宿主。
 */
export function createSubprocessCodeRuntime(input: {
  readonly subprocess: SubprocessService
  readonly sandbox: SandboxService
  readonly workspaceRoot: string
}): CodeRuntime {
  return {
    languages: ['javascript'],
    async run(request) {
      if (request.language !== 'javascript') return failure('CODE_LANGUAGE_UNSUPPORTED', `不支持的代码语言：${request.language}`)
      if (request.program.length > MAX_PROGRAM_CHARS) return failure('CODE_PROGRAM_TOO_LARGE', `代码超过 ${MAX_PROGRAM_CHARS} 字符限制`)
      if (request.signal?.aborted) return failure('CODE_ABORTED', '代码执行已取消')

      const wrapped = await input.sandbox.wrap([process.execPath, '--input-type=module', '--eval', RUNNER_SOURCE], {
        mode: 'read-only', workspaceRoot: input.workspaceRoot, allowNetwork: false,
      })
      if (!wrapped.enforced) return failure('CODE_SANDBOX_UNAVAILABLE', wrapped.degradationReason ?? '代码模式需要真实的只读沙箱')
      const child = await input.subprocess.spawn({
        argv: wrapped.wrappedArgv,
        cwd: input.workspaceRoot,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (child.writeStdin === undefined) {
        await child.killTree()
        return failure('CODE_STDIO_UNAVAILABLE', '代码运行器没有受控标准输入通道')
      }

      const allowed = new Set(request.bindings.flatMap((namespace) => namespace.functions.map((name) => `${namespace.global}.${name}`)))
      const logs: string[] = []
      let settled = false
      let result: CodeRunResult | undefined
      let pending: Promise<void> = (async (): Promise<void> => {})()
      let buffer = ''
      const finish = (value: CodeRunResult): void => {
        if (!settled) {
          settled = true
          result = value
          // runner 的 stdio 循环会继续等下一条命令；结果已写出后立即收敛进程树。
          void child.killTree()
        }
      }
      const onLine = (line: string): void => {
        let message: unknown
        try { message = JSON.parse(line) } catch { return }
        if (!isRecord(message) || typeof message.type !== 'string') return
        if (message.type === 'log' && typeof message.text === 'string') {
          if (logs.length < MAX_LOG_LINES) logs.push(message.text.slice(0, 4_000))
          return
        }
        if (message.type === 'invoke' && typeof message.id === 'number' && typeof message.binding === 'string') {
          const id = message.id
          const binding = message.binding
          const args = message.args
          pending = pending.then(async (): Promise<void> => {
            if (!allowed.has(binding) || !isJsonValue(args)) {
              child.writeStdin?.(`${JSON.stringify({ type: 'invoke-result', id, ok: false, error: { code: 'CODE_BINDING_DENIED', message: '未声明或参数非法的 binding' } })}\n`)
              return
            }
            try {
              const value = await request.invoke(binding, args)
              child.writeStdin?.(`${JSON.stringify({ type: 'invoke-result', id, ok: true, value })}\n`)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              child.writeStdin?.(`${JSON.stringify({ type: 'invoke-result', id, ok: false, error: { code: 'CODE_BINDING_FAILED', message } })}\n`)
            }
          })
          return
        }
        if (message.type === 'result') {
          if (message.ok === true && isJsonValue(message.value)) finish({ value: message.value, logs })
          else finish({ logs, error: { code: typeof message.code === 'string' ? message.code : 'CODE_RUNTIME_ERROR', message: typeof message.message === 'string' ? message.message : '代码运行失败' } })
        }
      }
      child.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString()
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          onLine(line)
        }
      })
      const stderr: string[] = []
      child.stderr.on('data', (chunk: Buffer | string) => { if (stderr.join('').length < 4_000) stderr.push(chunk.toString()) })
      child.writeStdin(`${JSON.stringify({ type: 'run', program: request.program })}\n`)
      const timeoutMs = Math.max(1, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const timeout = setTimeout(() => { if (!settled) void child.killTree() }, timeoutMs)
      const aborted = (): void => { if (!settled) void child.killTree() }
      request.signal?.addEventListener('abort', aborted, { once: true })
      const exit = await child.exited
      await pending
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', aborted)
      if (result !== undefined) return result
      if (request.signal?.aborted) return failure('CODE_ABORTED', '代码执行已取消', logs)
      if (exit.code === null) return failure('CODE_TIMEOUT_OR_KILLED', '代码运行器被终止', logs)
      return failure('CODE_RUNTIME_EXITED', stderr.join('').trim() || `代码运行器以 ${exit.code} 退出`, logs)
    },
  }
}

function failure(code: string, message: string, logs: readonly string[] = []): CodeRunResult {
  return { logs, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 不导入 Node 内建模块、不提供 process/require/fetch binding。安全性来自父进程的真实只读沙箱，
// 而非 `new Function` 本身；未强制 sandbox 时父端在启动前已拒绝。
const RUNNER_SOURCE = String.raw`
import readline from 'node:readline';
const pending = new Map(); let nextId = 1;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const tools = new Proxy(Object.create(null), { get(_target, property) {
  if (typeof property !== 'string') return undefined;
  return async (args = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); send({ type: 'invoke', id, binding: 'tools.' + property, args });
  });
}});
const consoleProxy = Object.freeze({ log: (...args) => send({ type: 'log', text: args.map(String).join(' ') }), error: (...args) => send({ type: 'log', text: args.map(String).join(' ') }) });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const run = async (program) => {
  try { const fn = new Function('tools', 'console', '"use strict"; return (async () => {\n' + String(program) + '\n})()'); const value = await fn(tools, consoleProxy); send({ type: 'result', ok: true, value: value === undefined ? null : value }); }
  catch (error) { send({ type: 'result', ok: false, code: typeof error?.code === 'string' ? error.code : 'CODE_PROGRAM_ERROR', message: error instanceof Error ? error.message : String(error) }); }
};
rl.on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'invoke-result') { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); message.ok ? item.resolve(message.value) : item.reject(Object.assign(new Error(message.error?.message || 'binding failed'), { code: message.error?.code || 'CODE_BINDING_FAILED' })); return; }
  if (message.type === 'run') void run(message.program);
});
`
