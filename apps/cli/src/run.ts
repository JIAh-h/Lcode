import { createInterface } from 'node:readline/promises'
import { createAgentRuntime, createDesktopModelFeature } from '@lcode/lcode-desktop'
import { createApprovalService } from '@lcode/approval'
import type { ApprovalChannel, ApprovalRequest } from '@lcode/approval'
import type { SessionEvent } from '@lcode/session'
import { resolveLcodeHome } from '@lcode/util'

interface ParsedRun {
  readonly prompt: string
  readonly cwd?: string | undefined
  readonly session?: string | undefined
  /** 显式授予本次目标工作区写入与命令权限；不接受隐式继承。 */
  readonly trustWorkspace: boolean
}

/** 无 GUI 的完整任务入口：复用桌面端同一套 runtime、工具、审批和事件协议。 */
export async function runTaskCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(argv)
  if (parsed.prompt === '' && parsed.session === undefined) {
    console.error('run 需要任务描述，或使用 --session <id> 继续已有会话')
    return 1
  }

  const approval = createCliApprovalChannel()
  const home = resolveLcodeHome()
  const modelFeature = await createDesktopModelFeature({ home })
  try {
    const runtime = await createAgentRuntime({
      home,
      services: modelFeature.services,
      approval: createApprovalService({ channel: approval }),
      profile: 'cli-default',
    })
    let sessionId = parsed.session
    let agentId: string | undefined
    let stopEvents: (() => void) | undefined

    try {
      if (sessionId === undefined) {
        const created = await runtime.sessions.create({
          cwd: parsed.cwd ?? process.cwd(),
          ...(parsed.prompt === '' ? {} : { title: parsed.prompt.slice(0, 80) }),
        })
        sessionId = created.session_id
        console.error(`会话：${sessionId}`)
      } else {
        await runtime.sessions.resume({ session_id: sessionId })
      }

      const activeSessionId = sessionId
      if (activeSessionId === undefined) throw new Error('会话创建失败：缺少 session_id')
      if (parsed.trustWorkspace) {
        const workspace = runtime.sessions.workspaceOf(activeSessionId)
        if (workspace === undefined) throw new Error('无法确定会话工作区，拒绝授予信任')
        runtime.ctx.get('workspaceTrust').setTrusted(workspace, true)
        console.error(`已信任工作区：${workspace}`)
      }
      agentId = (await runtime.agents.resume({ session_id: activeSessionId })).agent_id
      const activeAgentId = agentId
      const finished = waitForTurn(runtime, activeSessionId)
      stopEvents = finished.stop
      const onSigint = (): void => {
        if (agentId !== undefined) void runtime.agents.cancel({ agent_id: agentId, cause: 'user' })
      }
      process.once('SIGINT', onSigint)
      try {
        await runtime.agents.followup({
          agent_id: activeAgentId,
          content: [{ type: 'text', text: parsed.prompt === '' ? '继续完成尚未完成的任务。' : parsed.prompt }],
        })
        const reason = await finished.done
        return reason === 'completed' ? 0 : 130
      } finally {
        process.off('SIGINT', onSigint)
      }
    } finally {
      stopEvents?.()
      await runtime.dispose()
    }
  } catch (err) {
    const code = (err as { code?: string }).code
    const userMessage = (err as { userMessage?: string }).userMessage
    console.error(code === undefined ? String(err) : `${code} — ${userMessage ?? String(err)}`)
    return 1
  } finally {
    approval.close?.()
    modelFeature.dispose()
  }
}

export function parseRunArgs(argv: readonly string[]): ParsedRun {
  const prompt: string[] = []
  let cwd: string | undefined
  let session: string | undefined
  let trustWorkspace = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cwd') {
      cwd = argv[i + 1]
      i += 1
      continue
    }
    if (arg === '--session') {
      session = argv[i + 1]
      i += 1
      continue
    }
    if (arg === '--trust-workspace') {
      trustWorkspace = true
      continue
    }
    if (arg !== undefined) prompt.push(arg)
  }
  return { prompt: prompt.join(' ').trim(), cwd, session, trustWorkspace }
}

function waitForTurn(runtime: Awaited<ReturnType<typeof createAgentRuntime>>, sessionId: string): {
  readonly done: Promise<'completed' | 'cancelled' | 'interrupted' | 'error'>
  readonly stop: () => void
} {
  let turn: number | undefined
  let resolveDone: ((reason: 'completed' | 'cancelled' | 'interrupted' | 'error') => void) | undefined
  const done = new Promise<'completed' | 'cancelled' | 'interrupted' | 'error'>((resolve) => {
    resolveDone = resolve
  })
  const stop = runtime.watchSession(sessionId, (event: SessionEvent) => {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      return
    }
    if (event.type === 'assistant/chunk') {
      if (event.data.chunk.type === 'text-delta') process.stdout.write(event.data.chunk.text)
      return
    }
    if (event.type === 'tool/call') {
      process.stderr.write(`\n[${event.data.name}] 工具执行中\n`)
      return
    }
    if (event.type === 'tool/result' && event.data.error !== undefined) {
      process.stderr.write(`[tool error] ${event.data.error.code}\n`)
      return
    }
    if (event.type === 'turn/end' && turn === event.data.turn) {
      process.stdout.write('\n')
      resolveDone?.(event.data.reason)
    }
  })
  return { done, stop }
}

function createCliApprovalChannel(): ApprovalChannel & { close?: () => void } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // CI / 管道没有人可以回答：让审批服务走 unavailable，严格拒绝副作用。
    return { ask: async () => undefined }
  }
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  return {
    async ask(request: ApprovalRequest) {
      process.stderr.write(`\n需要确认：${request.action.summary}\n`)
      const answer = await readline.question('允许这一次？[y/N] ')
      return /^y(?:es)?$/i.test(answer.trim()) ? 'allowed-once' : 'rejected'
    },
    close: () => readline.close(),
  }
}
