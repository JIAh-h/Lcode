import type {} from '@lcode/agent'
import type {} from '@lcode/agent-loop'
import type { CompactionResult } from '@lcode/compaction'
import type { Context } from '@lcode/context'
import type { ContextBudgetDecision } from '@lcode/context-budget'
import type { SessionService } from '@lcode/session'
import type { Disposer } from '@lcode/util'
import { asAgentId } from '@lcode/util'

export interface CompactionSummaryInput {
  readonly sessionId: string
  readonly session: SessionService
  readonly decision: ContextBudgetDecision
}

/** 成本归属由调用方决定；策略绝不自行向当前模型或任何备用模型发请求。 */
export type CompactionSummarizer = (input: CompactionSummaryInput) => Promise<string> | string

export interface AutoCompactionStatus {
  readonly decision: ContextBudgetDecision
  readonly state: 'below-threshold' | 'deferred-no-summarizer' | 'attempted'
  readonly result?: CompactionResult | undefined
}

export interface AutoCompactionService {
  inspect(sessionId: string): AutoCompactionStatus | undefined
}

declare module '@lcode/context' {
  interface Services { autoCompaction: AutoCompactionService }
}

/**
 * 在 `context-budget` 已完成本步测量后执行。相同日志 revision 最多尝试一次，避免
 * 摘要无收益或工具边界拒绝时下一步无限重试。没有摘要器时只记录 deferred 状态。
 */
export function registerAutoCompactionPolicy(input: {
  readonly ctx: Context
  readonly sessionOf: (sessionId: string) => SessionService
  readonly summarize?: CompactionSummarizer | undefined
}): Disposer {
  const statuses = new Map<string, AutoCompactionStatus>()
  const attemptedRevision = new Map<string, number>()
  const service: AutoCompactionService = { inspect: (sessionId) => statuses.get(sessionId) }
  const unregisterService = input.ctx.set('autoCompaction', service)
  const unregisterStep = input.ctx.on('agent/pre-step', async ({ agentId }) => {
    const agent = input.ctx.get('agents').get(asAgentId(agentId))
    if (agent === undefined) return
    const decision = input.ctx.get('contextBudget').inspect(agent.sessionId)
    if (decision === undefined) return
    if (decision.status !== 'summary-candidate') {
      statuses.set(agent.sessionId, { decision, state: 'below-threshold' })
      return
    }
    if (input.summarize === undefined) {
      statuses.set(agent.sessionId, { decision, state: 'deferred-no-summarizer' })
      return
    }
    if (attemptedRevision.get(agent.sessionId) === decision.measurement.revision) return
    attemptedRevision.set(agent.sessionId, decision.measurement.revision)
    const session = input.sessionOf(agent.sessionId)
    const summary = await input.summarize({ sessionId: agent.sessionId, session, decision })
    const result = input.ctx.get('compaction').compact({ session, summary, trigger: 'threshold' })
    statuses.set(agent.sessionId, { decision, state: 'attempted', result })
  })
  return () => {
    unregisterStep()
    unregisterService()
    attemptedRevision.clear()
    statuses.clear()
  }
}
