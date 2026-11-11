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

/**
 * 同一个状态快照在这个窗口内重复查询，就判定为空转（docs/26 §5.6）。
 *
 * 5 秒的取法：worker 一次工具调用通常就在秒级，状态 5 秒没变基本意味着"还得再等"，
 * 而模型连续两次调用之间的间隔通常远小于这个值。
 */
const REPEAT_WINDOW_MS = 5_000

export function createListWorkersTool(ctx: Context): ToolDefinition<ListWorkersInput, ListWorkersResult> {
  /** 每个 Router 会话上一次查询的快照与时刻（防连续轮询） */
  const lastSnapshot = new Map<string, { snapshot: string; at: number }>()
  return {
    name: 'list_workers',
    description:
      '查看本会话派出去的所有 worker：谁在跑、跑了多久、谁卡住了在等你回答、谁失败了。**用于一次确认，不要连续轮询**——worker 完成会自动汇报给你，反复查询不会更快，只会白烧 token。',
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
      /*
       * 防连续轮询（压测发现）。
       *
       * 真实模型会在一轮里把 `list_workers` 调二三十次：每次返回"还在跑"，
       * 它就以为什么都没发生、再问一遍。这不是模型笨，是工具没告诉它**等待不是免费**——
       * 而 worker 完成本来就会自动汇报。
       *
       * 判据用"状态快照与上次相同且间隔很短"，而不是按轮计数：状态真变了就照常返回，
       * 状态没变才拦。这样既不误伤正常巡检，也堵住了空转。
       */
      const snapshot = filtered.map((w) => `${w.taskId}:${w.state}:${w.needsInput === true ? 'q' : ''}`).join('|')
      const previous = lastSnapshot.get(sessionId)
      const nowMs = Date.now()
      if (previous !== undefined && previous.snapshot === snapshot && nowMs - previous.at < REPEAT_WINDOW_MS) {
        return {
          workers: [],
          message:
            '状态与上一次查询完全相同，没有新进展。不要重复轮询——worker 完成或求助时会自动汇报给你，' +
            '先去做别的判断，或直接结束本轮等汇报。',
        }
      }
      lastSnapshot.set(sessionId, { snapshot, at: nowMs })
      if (filtered.length === 0) {
        return { workers: [], message: call.parsed.onlyRunning === true ? '当前没有在跑的 worker。' : '还没有派过任何 worker。' }
      }
      const now = nowMs
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
