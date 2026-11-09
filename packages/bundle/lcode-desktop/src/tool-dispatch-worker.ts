import type { Context } from '@lcode/context'
import type { ToolDefinition } from '@lcode/tools'

/**
 * `dispatch_worker`：Router 派发一个跨会话 worker（26 §3）。
 *
 * ## 为什么它只出现在 Router 会话里
 *
 * 工具本身不做可见性判断——那是 `sessionRoles` 的职责（普通会话与 worker 都看不到
 * 这个工具）。工具这里只负责拒绝真正的越权调用，作为第二道防线。
 *
 * ## 为什么它是**同步回执**而不是等结果
 *
 * Router 派发完就该继续做别的判断。等结果会让 Router 退化成串行执行器，
 * 正是 super-agent 要消除的东西（26 §5.1）。结果通过 `worker/completed` 异步回来。
 */

export interface DispatchWorkerInput {
  readonly task: string
  /** Router 的判断依据：为什么派这个、为什么拆（落事件供回放） */
  readonly reason?: string
}

export interface DispatchWorkerResult {
  readonly state: 'dispatched' | 'observed' | 'rejected' | 'queued'
  readonly taskId?: string
  readonly workerSessionId?: string
  readonly message: string
}

export function createDispatchWorkerTool(ctx: Context): ToolDefinition<DispatchWorkerInput, DispatchWorkerResult> {
  return {
    name: 'dispatch_worker',
    description:
      '把一个独立任务派发给 worker（独立会话，异步执行，结果稍后回传）。只传任务与理由，不要自己去执行它。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要派给 worker 的完整任务描述（worker 看不到当前对话，必须自包含）' },
        reason: { type: 'string', description: '为什么派这个任务、为什么需要拆分（会落事件供回放）' },
      },
      required: ['task'],
    },
    async execute(call, opts) {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('dispatch_worker 缺少会话 scope')
      /*
       * 第二道防线：`sessionRoles` 不会把本工具暴露给 worker（工具表里没有），
       * 但工具被直接调用时仍要拒绝。**worker 不能派发 worker**——一旦允许，
       * 取消语义、审计归属、成本预估全部失效（docs/26 §7.5.2）。
       */
      if (ctx.get('sessionRoles').roleOf(sessionId) === 'worker') {
        return { state: 'rejected', message: 'worker 不能派发 worker：跨会话编排最多两层。' }
      }
      const orchestration = ctx.get('orchestration')
      if (orchestration.mode() === 'off') {
        return { state: 'rejected', message: '跨会话编排当前是 off 档，无法派发。' }
      }
      const receipt = await orchestration.dispatch({
        routerSessionId: sessionId,
        task: call.parsed.task,
        ...(call.parsed.reason === undefined ? {} : { reason: call.parsed.reason }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      })
      if (!receipt.materialized) {
        return {
          state: 'observed',
          taskId: receipt.taskId,
          message: '当前是 observe 档：已记录这次派发意向，但没有真正创建 worker。用户切到 auto 后才会执行。',
        }
      }
      return {
        state: 'dispatched',
        taskId: receipt.taskId,
        workerSessionId: receipt.workerSessionId,
        message: '已派发。worker 完成后结果会自动回到这里，不需要你等待。',
      }
    },
  }
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}
