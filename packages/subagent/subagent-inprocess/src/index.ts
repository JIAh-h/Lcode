import { randomUUID } from 'node:crypto'
import type { Context } from '@lcode/context'
import type {} from '@lcode/system-prompt'
import type { AgentLoopRuntime } from '@lcode/agent-loop'
import type { RuntimeSessionsService } from '@lcode/session-api'
import type { RuntimeCompositionSnapshot } from '@lcode/runtime-composition'
import type { Disposer } from '@lcode/util'
import { asAgentId, asSessionId } from '@lcode/util'
import type {
  SubagentArtifacts,
  SubagentRunInput,
  SubagentRunResult,
  SubagentService,
  SubagentStartOutcome,
  SubagentTaskStatus,
} from '@lcode/subagent'
import type { ToolActionIntent, ToolCall } from '@lcode/tools'

const MAX_DEPTH = 2
const DEFAULT_READONLY_TOOLS = new Set(['read', 'glob', 'grep'])
/** 子代理可写工具：当前**不开放**。保留常量是为了让收窄逻辑的意图显式可见。 */
const WRITABLE_TOOLS: ReadonlySet<string> = new Set()

export interface InprocessSubagentService extends SubagentService { readonly maxDepth: number }

interface RunDeps {
  readonly ctx: Context
  readonly sessions: RuntimeSessionsService
  readonly workspaceOf: (sessionId: string) => string | undefined
  readonly profile: () => RuntimeCompositionSnapshot
  readonly scopes: Map<string, { readonly delegationId: string; readonly allowedToolIds: ReadonlySet<string> }>
}

/** 一次已派发事务的在途状态；同步与异步共用同一套收尾逻辑。 */
interface Inflight {
  readonly delegationId: string
  readonly childSessionId: string
  readonly depth: number
  readonly task: string
  readonly done: Promise<SubagentRunResult>
}

/** 进程内 provider；每个子代理仍有独立会话、独立 Agent 和只读工具 scope。 */
export function registerInprocessSubagents(input: {
  readonly ctx: Context
  readonly sessions: RuntimeSessionsService
  readonly workspaceOf: (sessionId: string) => string | undefined
  readonly profile: () => RuntimeCompositionSnapshot
}): { readonly service: InprocessSubagentService; readonly dispose: Disposer } {
  const scopes = new Map<string, { readonly delegationId: string; readonly allowedToolIds: ReadonlySet<string> }>()
  /** 在途与已结算的派发；已结算的保留结果供 `wait` 重复取用，dispose 时整体清空。 */
  const inflight = new Map<string, Inflight | { readonly settled: SubagentRunResult }>()

  const service: InprocessSubagentService = {
    maxDepth: MAX_DEPTH,
    async run(runInput) {
      const outcome = await startSubagent({ ...input, scopes, inflight }, runInput)
      if (outcome.kind === 'rejected') return outcome.result
      return await outcome.inflight.done
    },
    async start(runInput): Promise<SubagentStartOutcome> {
      const outcome = await startSubagent({ ...input, scopes, inflight }, runInput)
      if (outcome.kind === 'rejected') return outcome
      return {
        kind: 'started',
        receipt: {
          delegationId: outcome.inflight.delegationId,
          childSessionId: outcome.inflight.childSessionId,
          depth: outcome.inflight.depth,
        },
      }
    },
    async wait(delegationId) {
      const record = inflight.get(delegationId)
      if (record === undefined) return undefined
      return 'settled' in record ? record.settled : await record.done
    },
    status(delegationId): SubagentTaskStatus | undefined {
      const record = inflight.get(delegationId)
      if (record === undefined) return undefined
      if ('settled' in record) {
        return {
          delegationId,
          childSessionId: record.settled.childSessionId ?? '',
          depth: record.settled.depth,
          task: '',
          state: 'settled',
          result: record.settled,
        }
      }
      return { delegationId, childSessionId: record.childSessionId, depth: record.depth, task: record.task, state: 'running' }
    },
    pending() {
      return [...inflight.entries()].filter(([, record]) => !('settled' in record)).map(([delegationId]) => delegationId)
    },
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
      inflight.clear()
    },
  }
}

/**
 * 派发阶段：校验 → 建子会话 → 落 `subagent/delegated` → **立刻**启动后台执行。
 *
 * 返回的 `inflight.done` 就是终态 Promise：同步 `run` 直接 await 它，
 * 异步 `start` 只把回执交出去。两条路径因此共享同一份收尾与审计。
 */
async function startSubagent(
  deps: RunDeps & { readonly inflight: Map<string, Inflight | { readonly settled: SubagentRunResult }> },
  input: SubagentRunInput,
): Promise<{ readonly kind: 'started'; readonly inflight: Inflight } | { readonly kind: 'rejected'; readonly result: SubagentRunResult }> {
  const task = input.task.trim()
  const depth = input.depth ?? 0
  const delegationId = randomUUID()
  if (task === '' || !Number.isInteger(depth) || depth < 0 || depth >= MAX_DEPTH) {
    const result: SubagentRunResult = { delegationId, depth, outcome: 'depth-denied', error: '子代理最大深度为 2，且任务不能为空。' }
    recordFailure(deps.sessions, input.parentSessionId, delegationId, depth, task, 'depth-denied', result.error ?? '')
    return { kind: 'rejected', result }
  }
  const workspace = deps.workspaceOf(input.parentSessionId)
  if (workspace === undefined) {
    const result: SubagentRunResult = { delegationId, depth, outcome: 'failed', error: '父会话没有可用工作区，无法创建子代理。' }
    recordFailure(deps.sessions, input.parentSessionId, delegationId, depth, task, 'failed', result.error ?? '')
    return { kind: 'rejected', result }
  }

  const allowedToolIds = narrowTools(input.allowedToolIds)
  const child = await deps.sessions.create({ cwd: workspace, title: `子任务：${task.slice(0, 80)}` })
  deps.scopes.set(child.session_id, { delegationId, allowedToolIds })
  const parent = deps.sessions.sessionServiceFor(input.parentSessionId)
  parent.append({
    type: 'subagent/delegated',
    data: { delegationId, childSessionId: child.session_id, task, depth: depth + 1, allowedToolIds: [...allowedToolIds], profileId: deps.profile().profile },
  })

  const done = executeSubagent(deps, {
    delegationId,
    childSessionId: child.session_id,
    parentSession: parent,
    depth: depth + 1,
    task,
    parentAgentId: input.parentAgentId,
    signal: input.signal,
  })
    .then((result) => {
      // 结算后把结果留在表里：`wait` 可以重复取用，`status` 仍能报终态。
      deps.inflight.set(delegationId, { settled: result })
      return result
    })
    /*
     * 兜底：`executeSubagent` 内部已捕获执行期异常，但**收尾写事件**本身也可能失败
     * （父会话被 dispose 后 `append` 会抛 ES-SESSION_NOT_FOUND）。没有这一行，
     * 这条 promise 就成了无人等待的孤儿，会变成进程级 unhandled rejection——
     * 在测试里表现为"用例全绿但报 Errors 1"，在生产里会静默污染日志。
     */
    .catch((error: unknown) => {
      const result: SubagentRunResult = {
        delegationId,
        childSessionId: child.session_id,
        depth: depth + 1,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
      deps.inflight.set(delegationId, { settled: result })
      return result
    })

  const entry: Inflight = { delegationId, childSessionId: child.session_id, depth: depth + 1, task, done }
  deps.inflight.set(delegationId, entry)
  return { kind: 'started', inflight: entry }
}

/**
 * 执行阶段：创建子 Agent → followup → 汇总。
 *
 * ⚠️ 这里**不能**把异常吞成"completed"。旧实现用末条 assistant 文本冒充结果，
 * 子代理中途失败时父会话只看到一句空字符串，判断不出到底是"没找到"还是"崩了"。
 */
async function executeSubagent(
  deps: RunDeps,
  input: {
    readonly delegationId: string
    readonly childSessionId: string
    readonly parentSession: { append(event: never): unknown }
    readonly depth: number
    readonly task: string
    readonly parentAgentId?: string | undefined
    readonly signal?: AbortSignal | undefined
  },
): Promise<SubagentRunResult> {
  const { delegationId, childSessionId, depth, signal } = input
  /*
   * 用函数读取 abort 状态，而不是直接比较 `signal.aborted` 的**静态**类型。
   * abort 恰恰是在这段代码执行期间由外部事件改写的，静态收窄在这里没有意义。
   */
  const aborted = (): boolean => signal !== undefined && signal.aborted
  let handle: Awaited<ReturnType<AgentLoopRuntime['create']>> | undefined
  try {
    // 父级在**派发之前**就已经取消：不启动子代理，直接以 cancelled 收尾。
    if (aborted()) {
      const cancelled: SubagentRunResult = { delegationId, childSessionId, depth, outcome: 'cancelled', error: '父级取消，子代理未启动。' }
      appendCompleted(input.parentSession, cancelled)
      return cancelled
    }
    const loop = deps.ctx.get('agentLoop') as AgentLoopRuntime
    handle = await deps.ctx.get('agents').withInitiator(
      { sessionId: asSessionId(delegationId) as never, agentId: asAgentId(input.parentAgentId ?? delegationId) },
      async () => await loop.create({ sessionId: asSessionId(childSessionId), name: `subagent:${delegationId}` }),
    )
    const active = handle
    /*
     * **可中断等待**（取消传播的关键一段）。
     *
     * `followup` 本身不收 signal，所以直接 `await` 会让父级 abort 传不进来——
     * 用户点了暂停，`runTurn` 仍卡在这里，`cancel()` 的 `waitForIdle()` 就永远等不到。
     * 这里登记一个 listener：父级一 abort 就主动停掉子 agent，让等待立刻返回。
     */
    const onAbort = (): void => {
      void Promise.resolve(active.cancel?.('user')).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await handle.followup({ kind: 'text', text: input.task })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (aborted()) {
      // 跑完了但父级已经不要了：结果仍然记录，但语义是"被取消"而不是"完成"。
      const cancelled: SubagentRunResult = { delegationId, childSessionId, depth, outcome: 'cancelled', error: '父级取消，子代理已中止。' }
      appendCompleted(input.parentSession, cancelled)
      return cancelled
    }
    const childSession = deps.sessions.sessionServiceFor(childSessionId)
    const result: SubagentRunResult = {
      delegationId,
      childSessionId,
      depth,
      outcome: 'completed',
      result: lastAssistantText(childSession),
      artifacts: collectArtifacts(childSession),
    }
    appendCompleted(input.parentSession, { ...result })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 因父级取消而抛出的异常不记成 failed：否则失败统计会把"用户点了暂停"算成故障。
    const outcome = aborted() ? 'cancelled' : 'failed'
    const result: SubagentRunResult = { delegationId, childSessionId, depth, outcome, error: message }
    appendCompleted(input.parentSession, result)
    return result
  } finally {
    deps.scopes.delete(childSessionId)
    await handle?.dispose()
  }
}

function appendCompleted(parentSession: { append(event: never): unknown }, result: SubagentRunResult): void {
  /*
   * 父会话可能已经关闭（用户删了会话 / 关了窗口 / runtime 已 dispose）。
   * 此时子代理仍会跑完并走到收尾，写事件会抛 ES-SESSION_NOT_FOUND。
   * 结果本身已经通过返回值与 `wait` 交付，日志写不进去不该再放大成异常。
   */
  try {
    parentSession.append({
      type: 'subagent/completed',
      data: {
        delegationId: result.delegationId,
        childSessionId: result.childSessionId ?? '',
        outcome: result.outcome,
        ...(result.result === undefined ? {} : { result: result.result }),
        ...(result.error === undefined ? {} : { error: result.error }),
      },
    } as never)
  } catch {
    // 父会话已不在了：审计事实无处可写，但子代理自己的 JSONL 仍保留完整轨迹。
  }
}

function narrowTools(requested: readonly string[] | undefined): ReadonlySet<string> {
  // 可写工具当前为空集：子代理**仍然只读**。保留这一步是为了让"以后要开写"只需改
  // WRITABLE_TOOLS，而不是在权限逻辑里散落条件；同时保证写法上永远只做收窄。
  return new Set((requested ?? [...DEFAULT_READONLY_TOOLS]).filter((id) => DEFAULT_READONLY_TOOLS.has(id) && !WRITABLE_TOOLS.has(id)))
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

/**
 * 从子会话日志投影结构化产物。
 *
 * 只读日志、不读进程内状态：`subagent/completed` 之后父会话重放时，
 * 这些数字仍然能从子会话 JSONL 原样复原（I1）。
 */
function collectArtifacts(session: { events(): readonly unknown[] }): SubagentArtifacts {
  const events = session.events() as readonly Record<string, unknown>[]
  const changed: string[] = []
  let toolCalls = 0
  let failedToolCalls = 0
  let input: number | undefined
  let output: number | undefined

  for (const event of events) {
    const type = event['type']
    const data = (event['data'] ?? {}) as Record<string, unknown>
    if (type === 'tool/call') {
      toolCalls += 1
      const name = data['name']
      if (name !== 'write' && name !== 'edit') continue
      const path = parsedPath(data['arguments'])
      if (path !== undefined && !changed.includes(path)) changed.push(path)
      continue
    }
    if (type === 'tool/result') {
      const message = data['message'] as Record<string, unknown> | undefined
      if (data['error'] !== undefined || message?.['isError'] === true) failedToolCalls += 1
      continue
    }
    if (type === 'assistant/message') {
      const usage = data['usage'] as Record<string, unknown> | undefined
      if (usage === undefined) continue
      if (typeof usage['input'] === 'number') input = (input ?? 0) + usage['input']
      if (typeof usage['output'] === 'number') output = (output ?? 0) + usage['output']
    }
  }

  return {
    changedPaths: changed,
    toolCalls,
    failedToolCalls,
    ...(input === undefined && output === undefined
      ? {}
      : { usage: { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) } }),
    events: events.length,
  }
}

function parsedPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const path = parsed['path']
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}

function recordFailure(sessions: RuntimeSessionsService, parentSessionId: string, delegationId: string, depth: number, task: string, outcome: 'failed' | 'depth-denied', error: string): void {
  try {
    sessions.sessionServiceFor(parentSessionId).append({ type: 'subagent/completed', data: { delegationId, childSessionId: '', outcome, error, depth, task } })
  } catch {
    // 父会话不可用时只返回确定失败；不能因此创建脱离父链的子会话。
  }
}
