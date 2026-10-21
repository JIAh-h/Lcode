import { randomUUID } from 'node:crypto'
import type { Context } from '@lcode/context'
import type {} from '@lcode/system-prompt'
import type { AgentLoopRuntime } from '@lcode/agent-loop'
import type { RuntimeSessionsService } from '@lcode/session-api'
import type { RuntimeCompositionSnapshot } from '@lcode/runtime-composition'
import type { Disposer } from '@lcode/util'
import { asAgentId, asSessionId } from '@lcode/util'
import type { SubagentRunInput, SubagentRunResult, SubagentService } from '@lcode/subagent'
import type { ToolActionIntent, ToolCall } from '@lcode/tools'

const MAX_DEPTH = 2
const DEFAULT_READONLY_TOOLS = new Set(['read', 'glob', 'grep'])

export interface InprocessSubagentService extends SubagentService { readonly maxDepth: number }

/** 进程内 provider；每个子代理仍有独立会话、独立 Agent 和只读工具 scope。 */
export function registerInprocessSubagents(input: {
  readonly ctx: Context
  readonly sessions: RuntimeSessionsService
  readonly workspaceOf: (sessionId: string) => string | undefined
  readonly profile: () => RuntimeCompositionSnapshot
}): { readonly service: InprocessSubagentService; readonly dispose: Disposer } {
  const scopes = new Map<string, { readonly delegationId: string; readonly allowedToolIds: ReadonlySet<string> }>()
  const service: InprocessSubagentService = {
    maxDepth: MAX_DEPTH,
    async run(runInput) { return await runSubagent({ ...input, scopes }, runInput) },
  }
  const unregisterService = input.ctx.set('subagents', service)
  const unregisterPrompt = input.ctx.get('systemPrompt').tools((all, promptCtx) => {
    const scope = promptCtx.sessionId === undefined ? undefined : scopes.get(promptCtx.sessionId)
    return scope === undefined ? all : all.filter((tool) => scope.allowedToolIds.has(tool.name))
  })
  // 必须先于 policy hook：子代理的副作用不能进入人工审批队列。
  const guard = async (payload: { call: ToolCall; intent?: ToolActionIntent; scope?: unknown; deny?: string }, next: () => Promise<unknown>) => {
    const sessionId = sessionIdOf(payload.scope)
    const child = sessionId === undefined ? undefined : scopes.get(sessionId)
    if (child !== undefined) {
      if (!child.allowedToolIds.has(payload.call.name)) payload.deny = `子代理 ${child.delegationId} 无权使用工具 ${payload.call.name}`
      else if (!isReadonlyIntent(payload.intent)) payload.deny = '子代理不能执行可能请求人工审批的副作用操作；请由父代理在当前会话中处理。'
    }
    return next()
  }
  const unregisterGuard = input.ctx.on('tools/pre-execute', guard as never)
  return {
    service,
    dispose: () => {
      unregisterGuard()
      unregisterPrompt()
      unregisterService()
      scopes.clear()
    },
  }
}

async function runSubagent(
  deps: {
    readonly ctx: Context
    readonly sessions: RuntimeSessionsService
    readonly workspaceOf: (sessionId: string) => string | undefined
    readonly profile: () => RuntimeCompositionSnapshot
    readonly scopes: Map<string, { readonly delegationId: string; readonly allowedToolIds: ReadonlySet<string> }>
  },
  input: SubagentRunInput,
): Promise<SubagentRunResult> {
  const task = input.task.trim()
  const depth = input.depth ?? 0
  const delegationId = randomUUID()
  if (task === '' || !Number.isInteger(depth) || depth < 0 || depth >= MAX_DEPTH) {
    recordFailure(deps.sessions, input.parentSessionId, delegationId, depth, task, 'depth-denied', '子代理深度或任务无效')
    return { delegationId, depth, outcome: 'depth-denied', error: '子代理最大深度为 2，且任务不能为空。' }
  }
  const workspace = deps.workspaceOf(input.parentSessionId)
  if (workspace === undefined) {
    recordFailure(deps.sessions, input.parentSessionId, delegationId, depth, task, 'failed', '父会话没有可用工作区')
    return { delegationId, depth, outcome: 'failed', error: '父会话没有可用工作区，无法创建子代理。' }
  }
  const allowedToolIds = narrowTools(input.allowedToolIds)
  const child = await deps.sessions.create({ cwd: workspace, title: `子任务：${task.slice(0, 80)}` })
  deps.scopes.set(child.session_id, { delegationId, allowedToolIds })
  const parent = deps.sessions.sessionServiceFor(input.parentSessionId)
  parent.append({ type: 'subagent/delegated', data: { delegationId, childSessionId: child.session_id, task, depth: depth + 1, allowedToolIds: [...allowedToolIds], profileId: deps.profile().profile } })
  let handle: Awaited<ReturnType<AgentLoopRuntime['create']>> | undefined
  try {
    const loop = deps.ctx.get('agentLoop') as AgentLoopRuntime
    handle = await deps.ctx.get('agents').withInitiator({ sessionId: asSessionId(input.parentSessionId), agentId: asAgentId(input.parentAgentId ?? input.parentSessionId) }, async () => await loop.create({ sessionId: asSessionId(child.session_id), name: `subagent:${delegationId}` }))
    await handle.followup({ kind: 'text', text: task })
    const result = lastAssistantText(deps.sessions.sessionServiceFor(child.session_id))
    parent.append({ type: 'subagent/completed', data: { delegationId, childSessionId: child.session_id, outcome: 'completed', result } })
    return { delegationId, childSessionId: child.session_id, depth: depth + 1, outcome: 'completed', result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    parent.append({ type: 'subagent/completed', data: { delegationId, childSessionId: child.session_id, outcome: 'failed', error: message } })
    return { delegationId, childSessionId: child.session_id, depth: depth + 1, outcome: 'failed', error: message }
  } finally {
    deps.scopes.delete(child.session_id)
    await handle?.dispose()
  }
}

function narrowTools(requested: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((requested ?? [...DEFAULT_READONLY_TOOLS]).filter((id) => DEFAULT_READONLY_TOOLS.has(id)))
}

function isReadonlyIntent(intent: ToolActionIntent | undefined): boolean {
  return intent === undefined || ((intent.argv === undefined || intent.argv.length === 0) && (intent.domains === undefined || intent.domains.length === 0) && (intent.env === undefined || intent.env.length === 0) && (intent.paths === undefined || intent.paths.every((path) => path.mode === 'read')))
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function lastAssistantText(session: { deriveMessages(): readonly unknown[] }): string {
  const messages = session.deriveMessages() as readonly { readonly role?: string; readonly content?: unknown }[]
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (last === undefined) return ''
  if (typeof last.content === 'string') return last.content
  if (!Array.isArray(last.content)) return ''
  return last.content.filter((block): block is { readonly type: 'text'; readonly text: string } => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string').map((block) => block.text).join('\n')
}

function recordFailure(sessions: RuntimeSessionsService, parentSessionId: string, delegationId: string, depth: number, task: string, outcome: 'failed' | 'depth-denied', error: string): void {
  try {
    sessions.sessionServiceFor(parentSessionId).append({ type: 'subagent/completed', data: { delegationId, childSessionId: '', outcome, error, depth, task } })
  } catch {
    // 父会话不可用时只返回确定失败；不能因此创建脱离父链的子会话。
  }
}
