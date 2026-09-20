import type { PtySpawnOpts, SpawnOpts, SpawnedProcess, SpawnedPty, SubprocessService } from '@lcode/subprocess'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { spawn as nodePtySpawn } from 'node-pty'

/**
 * 本机子进程 Provider。
 *
 * `shell-local`、后台作业和未来的 PTY/LSP 只能消费 `SubprocessService`，不能再各自
 * 调用 `child_process`。原生沙箱 Provider 随后只需替换此处的启动策略，即可让所有
 * 消费者进入相同的执行世界。
 */
export function createLocalSubprocess(): SubprocessService {
  return {
    async spawn(opts: SpawnOpts): Promise<SpawnedProcess> {
      const [command, ...args] = opts.argv
      if (command === undefined || command.trim() === '') throw new Error('argv 不能为空')

      const child = spawn(command, args, {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.env === undefined ? {} : { env: opts.env }),
        windowsHide: true,
        // POSIX 用进程组杀掉整棵子树；Windows 在 killTree 中使用 taskkill /T。
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'] as const,
      }) as ChildProcess
      if (child.stdin === null || child.stdout === null || child.stderr === null) throw new Error('子进程未提供完整 stdio 管道')
      const stdin = child.stdin
      const exited = awaitExit(child)
      const spawned: SpawnedProcess = {
        // `spawn` 的 ENOENT 走 error 事件，仍交由 exited 给调用方稳定的失败事实。
        pid: child.pid ?? -1,
        stdout: child.stdout,
        stderr: child.stderr,
        writeStdin: (data) => stdin.write(data),
        killTree: async () => await killTree(child),
        exited,
      }
      if (opts.signal !== undefined) {
        const onAbort = (): void => { void spawned.killTree() }
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
        void exited.finally(() => opts.signal?.removeEventListener('abort', onAbort))
      }
      return spawned
    },
    async spawnPty(opts: PtySpawnOpts): Promise<SpawnedPty> {
      const pty = nodePtySpawn(opts.shell, [...(opts.args ?? [])], {
        name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env,
        ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : { encoding: 'utf8' }),
      })
      return {
        pid: pty.pid,
        write: (data) => pty.write(data),
        kill: (signal) => pty.kill(signal),
        onData: (listener) => { pty.onData(listener) },
        onExit: (listener) => { pty.onExit(({ exitCode }) => listener({ exitCode })) },
      }
    },
  }
}

function awaitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: null, signal: null }))
  })
}

/** 整体终止进程树；这里是唯一允许直接使用系统进程 API 的本机 Provider。 */
async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return

  await new Promise<void>((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // 进程可能已退出；下方仍会清理输出句柄。
      }
      resolve()
      return
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('close', () => resolve())
    killer.once('error', () => resolve())
  })

  child.stdout?.destroy()
  child.stderr?.destroy()
  try {
    child.kill()
  } catch {
    // close 竞态是幂等清理的一部分。
  }
}
