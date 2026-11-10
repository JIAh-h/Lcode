import type { Context } from '@lcode/context'
import type { ToolDefinition } from '@lcode/tools'

/**
 * `list_workers`：Router 主动巡检自己派出去的任务（26 §5.6）。
 *
 * ## 为什么 Router 需要"主动看"
 *
 * 现在 Router 只能**被动等汇报**：worker 完成才有一条消息。它看不到
 *
 * - 谁还在跑、跑了多久
 * - 谁卡住了在等人回答
 * - 谁失败了但没被注意
 *
 * 官方的 Router 工具表里有 `status` / `retry` 这类工具，正是为了让调度者能
 * 自己决定"要不要问一句 / 要不要取消"，而不是把判断全压在事件推送上。
 *
 * ## 与状态条的关系
 *
 * 两者读的是**同一份** `orchestration.list()`。不各算一份：否则界面上显示
 * "2 个在跑"而模型说"1 个"，用户没法判断该信谁。
 */

export interface ListWorkersInput {
  /** 只看在跑的；缺省给全部 */
  readonly onlyRunning?: boolean
}

export interface ListWorkersResult {
  readonly workers: readonly {
    readonly taskId: string
    readonly state: string
    readonly task: string
    readonly needsInput: boolean
    readonly question?: string | undefined
    readonly outcome?: string | undefined
    /** 已运行时长（秒）；已结束的不给 */
    readonly runningSeconds?: number | undefined
  }[]
  readonly message: string
}

export function createListWorkersTool(ctx: Context): ToolDefinition<ListWorkersInput, ListWorkersResult> {
  return {
    name: 'list_workers',
    description:
      '查看本会话派出去的所有 worker：谁在跑、跑了多久、谁卡住了在等你回答、谁失败了。用它主动巡检，而不是等汇报。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        onlyRunning: { type: 'boolean', description: '只看还在跑的（缺省给出全部）' },
      },
    },
    async execute(call, opts) {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('list_workers 缺少会话 scope')
      if (ctx.get('sessionRoles').roleOf(sessionId) === 'worker') {
        return { workers: [], message: 'worker 看不到其他 worker。' }
      }
      const all = ctx.get('orchestration').list({ routerSessionId: sessionId })
      const filtered = call.parsed.onlyRunning === true ? all.filter((w) => w.state === 'running') : all
      if (filtered.length === 0) {
        return { workers: [], message: call.parsed.onlyRunning === true ? '当前没有在跑的 worker。' : '还没有派过任何 worker。' }
      }
      const now = Date.now()
      const workers = filtered.map((w) => ({
        taskId: w.taskId,
        state: w.needsInput === true ? 'needs-input' : w.state,
        task: w.task,
        needsInput: w.needsInput === true,
        ...(w.question === undefined ? {} : { question: w.question }),
        ...(w.outcome === undefined ? {} : { outcome: w.outcome }),
        ...(w.state === 'running' ? { runningSeconds: Math.round((now - w.dispatchedAt) / 1000) } : {}),
      }))
      const waiting = workers.filter((w) => w.needsInput).length
      return {
        workers,
        message:
          waiting > 0
            ? `共 ${workers.length} 个，其中 ${waiting} 个在等你回答——先处理它们。`
            : `共 ${workers.length} 个。`,
      }
    },
  }
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}
