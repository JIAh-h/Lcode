import type {} from '@lcode/agent'
import type {} from '@lcode/agent-loop'
import type {} from '@lcode/context-budget'
import type {} from '@lcode/system-prompt'
import type { CompactionResult } from '@lcode/compaction'
import type { Context } from '@lcode/context'
import type { SessionService } from '@lcode/session'
import { ERROR_CODES, asAgentId, isLcodeError } from '@lcode/util'
import type { Disposer } from '@lcode/util'
import {
  chooseCompactionRange,
  createModelCompactionSummarizer,
  type CompactionRangeOptions,
  type CompactionSummarizer,
} from './compaction-summarizer.ts'

/** 上下文用量达到窗口的 90% 时，在下一个步边界自动压缩。 */
export const AUTO_COMPACTION_RATIO = 0.9

export interface ContextRecoveryOptions {
  readonly ctx: Context
  readonly sessionOf: (sessionId: string) => SessionService
  readonly contextWindowOf: () => number | undefined
  /** 宿主注入的摘要器（测试/离线用）；缺省走默认模型 */
  readonly summarize?: CompactionSummarizer | undefined
}

/**
 * 两条恢复链都只挂在**步边界**或**请求失败点**（09 §5.1），不在流式或工具执行中途动手：
 * - `agent/pre-step`：用量 ≥ 90% 时压一次，每轮最多一次，避免同一轮反复付费；
 * - `agent/request-error`：只认 `EL-CONTEXT_OVERFLOW`，压缩真的推进了表面才让引擎重试。
 *
 * 自动压缩失败不阻断请求：摘要请求本身也可能超窗/断网，此时保留原历史，
 * 交给溢出恢复或把原始错误交给用户。
 */
export function registerContextRecovery(input: ContextRecoveryOptions): Disposer {
  const attemptedTurn = new Map<string, number>()

  const attempt = async (
    sessionId: string,
    session: SessionService,
    range: CompactionRangeOptions,
    trigger: 'threshold' | 'overflow',
  ): Promise<CompactionResult | undefined> => {
    const plan = chooseCompactionRange(session, range)
    if (plan === undefined) return undefined
    const summarize = input.summarize ?? createModelCompactionSummarizer({
      ctx: input.ctx,
      ...(range.keepRecentTurns === undefined
        ? { keepRecentChars: range.keepRecentChars }
        : { keepRecentTurns: range.keepRecentTurns }),
    })
    const summary = await summarize({
      sessionId,
      session,
      ...(range.keepRecentTurns === undefined ? {} : { keepRecentTurns: range.keepRecentTurns }),
    })
    if (summary.trim() === '') return undefined
    return input.ctx.get('compaction').compact({
      session,
      summary,
      start: plan.start,
      end: plan.end,
      trigger,
    })
  }

  const unregisterStep = input.ctx.on('agent/pre-step', async ({ agentId, turn }) => {
    const window = input.contextWindowOf()
    if (window === undefined || window <= 0) return
    /*
     * 服务可能已经注销：装配层收尾时会先停循环、再拆服务，而在途回合的
     * `agent/pre-step` 仍可能在这之后跑到一次。此时 `ctx.get` 直接抛
     * "service not found"，会把一个本来正常的收尾回合记成执行失败。
     *
     * 压缩是**优化**而不是正确性的一部分：拿不到服务就跳过这一步，零损失。
     */
    let agents: ReturnType<typeof input.ctx.get<'agents'>>
    try {
      agents = input.ctx.get('agents')
    } catch {
      return
    }
    const agent = agents.get(asAgentId(agentId))
    if (agent === undefined) return
    if (attemptedTurn.get(agent.sessionId) === turn) return

    const session = input.sessionOf(agent.sessionId)
    const assembled = await input.ctx.get('systemPrompt').assemble({ sessionId: agent.sessionId })
    const measurement = input.ctx.get('contextBudget').measure({
      session,
      system: assembled.system,
      tools: assembled.tools,
    })
    const used = measurement.providerTotal ?? measurement.total
    if (used < window * AUTO_COMPACTION_RATIO) return

    attemptedTurn.set(agent.sessionId, turn)
    try {
      await attempt(agent.sessionId, session, {
        // 保留最近内容的预算随窗口缩放：小窗口也要留得下"最近几轮"，大窗口不必留 30 万字符
        keepRecentChars: Math.min(12_000, Math.max(2_000, Math.floor(window * 0.3))),
      }, 'threshold')
    } catch {
      // 自动压缩失败不阻断本次请求；硬溢出还有 request-error 恢复链
    }
  })

  const recover = async (
    payload: { readonly sessionId: string; readonly session: SessionService; readonly error: unknown },
    next: () => Promise<{ readonly retry: boolean }>,
  ): Promise<{ readonly retry: boolean }> => {
    if (!isContextOverflow(payload.error)) return next()
    try {
      // 溢出恢复更激进：只留最近一轮，尽量把请求压进窗口
      const result = await attempt(payload.sessionId, payload.session, { keepRecentTurns: 1 }, 'overflow')
      if (result?.status === 'compacted') return { retry: true }
    } catch {
      // 恢复失败保留原始错误（引擎会把它抛给调用方）
    }
    return next()
  }
  const unregisterError = input.ctx.on('agent/request-error', recover as never)

  return () => {
    unregisterStep()
    unregisterError()
    attemptedTurn.clear()
  }
}

function isContextOverflow(error: unknown): boolean {
  return isLcodeError(error) && error.code === ERROR_CODES.EL_CONTEXT_OVERFLOW
}
