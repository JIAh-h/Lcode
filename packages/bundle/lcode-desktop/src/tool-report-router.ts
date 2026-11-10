import type { Context } from '@lcode/context'
import type { ToolDefinition } from '@lcode/tools'

/**
 * `report_to_router`：worker 主动回传（26 §5.6）。
 *
 * ## 为什么需要它，而不是继续"从日志猜"
 *
 * 现在 worker 的汇报是**事后从它会话日志里投影**出来的（取最后一条 assistant 文本）。
 * 这种方式拿不到三件关键信息：
 *
 * - **意图**：它是干完了，还是卡住了要人决定？
 * - **问题**：它想问什么，需要什么才能继续？
 * - **时机**：有的事必须现在说，不能等它整个跑完
 *
 * ## 为什么保留日志投影作为兜底
 *
 * 模型不该被假定会守规矩：它可能压根不调这个工具。所以"没调用"时仍按原路径
 * 从日志取摘要——**工具让汇报更准，但不让汇报依赖它**。
 *
 * ## `kind: 'question'` 的特殊性
 *
 * 求助**绕过批处理窗口**立刻唤醒 Router（26 §5.6）。批处理的存在是为了
 * "别让密集完成刷屏"，而求助是等不起的——窗口里多等 200ms，worker 就白站着。
 */

export interface ReportToRouterInput {
  readonly kind: 'progress' | 'question' | 'done'
  readonly summary: string
  /** `kind: 'question'` 时必填：具体要问什么 */
  readonly question?: string
  /** 需要什么才能继续（自由文本；schema 不支持数组嵌套，用顿号分隔即可） */
  readonly needs?: string
}

export interface ReportToRouterResult {
  readonly state: 'reported' | 'not-a-worker'
  readonly message: string
}

export function createReportToRouterTool(ctx: Context): ToolDefinition<ReportToRouterInput, ReportToRouterResult> {
  return {
    name: 'report_to_router',
    description:
      '向派发你的 Router 回传。做完了用 done，有阶段性结论用 progress，卡在只有人能决定的事上用 question（它会立刻叫醒 Router；问完先停下，等指示）。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['progress', 'question', 'done'],
          description: 'progress=阶段结论（不打扰）、question=求助（立刻上报并等你停）、done=做完了',
        },
        summary: { type: 'string', description: '结论摘要（一两句话，说清做了什么/发现了什么）' },
        question: { type: 'string', description: 'kind=question 时必填：具体要问什么' },
        needs: {
          type: 'string',
          description: '需要什么才能继续（用顿号分隔，如：要删还是要留、要不要改测试）',
        },
      },
      required: ['kind', 'summary'],
    },
    async execute(call, opts) {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('report_to_router 缺少会话 scope')
      // 第二道防线：只有 worker 需要汇报；普通人会话没有"上级"
      if (ctx.get('sessionRoles').roleOf(sessionId) !== 'worker') {
        return { state: 'not-a-worker', message: '只有被派发的 worker 需要向 Router 汇报。' }
      }
      const orchestration = ctx.get('orchestration')
      if (orchestration.taskIdOf(sessionId) === undefined) {
        return { state: 'not-a-worker', message: '找不到对应的任务记录（可能已被清理）。' }
      }
      const ok = await orchestration.report({
        workerSessionId: sessionId,
        kind: call.parsed.kind,
        summary: call.parsed.summary,
        ...(call.parsed.question === undefined ? {} : { question: call.parsed.question }),
        ...(call.parsed.needs === undefined || call.parsed.needs.trim() === ''
          ? {}
          : { needs: [call.parsed.needs] }),
      })
      if (!ok) return { state: 'not-a-worker', message: '汇报没有送达（任务记录已不存在）。' }
      return {
        state: 'reported',
        message:
          call.parsed.kind === 'question'
            ? '已上报。停下等你上级的决定——不要再继续猜测性地改下去。'
            : '已上报。',
      }
    },
  }
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}
