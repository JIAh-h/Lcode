import type { Context } from '@lcode/context'
import type {} from '@lcode/agent'
import type {} from '@lcode/agent-loop'
import type { SessionService } from '@lcode/session'
import type { SystemPromptService } from '@lcode/system-prompt'
import type { ToolSchema } from '@lcode/tools'
import type { Disposer } from '@lcode/util'
import { asAgentId } from '@lcode/util'

export interface TokenMeasurement {
  /** 取样时的日志长度；日志变更后该快照即过期。 */
  readonly revision: number
  readonly surfaceTokens: number
  readonly systemTokens: number
  readonly toolSchemaTokens: number
  readonly total: number
  /** provider 已返回的真实用量，只用于校准和审计，绝不再重复相加到 total。 */
  readonly observedInputTokens: number
  readonly observedOutputTokens: number
}

export interface ContextBudgetDecision {
  readonly status: 'below-threshold' | 'summary-candidate' | 'no-context-window'
  readonly measurement: TokenMeasurement
  readonly thresholdTokens?: number | undefined
  readonly requiredSavingsTokens?: number | undefined
}

export interface ContextBudgetService {
  measure(input: { readonly session: SessionService; readonly system: string; readonly tools: readonly ToolSchema[] }): TokenMeasurement
  assess(input: { readonly measurement: TokenMeasurement; readonly contextWindowTokens?: number | undefined; readonly reserveOutputTokens?: number | undefined }): ContextBudgetDecision
  inspect(sessionId: string): ContextBudgetDecision | undefined
}

declare module '@lcode/context' {
  interface Services { contextBudget: ContextBudgetService }
}

/**
 * 上下文预算 provider。它只记录步前测量和收益候选，绝不自行摘要或重试请求。
 * 估算按 2 字符/token 保守折算，避免把中文和混合代码上下文系统性低估。
 */
export function registerContextBudget(input: {
  readonly ctx: Context
  readonly systemPrompt: SystemPromptService
  readonly sessionOf: (sessionId: string) => SessionService
  readonly contextWindowOf: () => number | undefined
  readonly reserveOutputTokens?: number | undefined
}): Disposer {
  const snapshots = new Map<string, ContextBudgetDecision>()
  const service: ContextBudgetService = {
    measure,
    assess,
    inspect: (sessionId) => snapshots.get(sessionId),
  }
  const unregisterService = input.ctx.set('contextBudget', service)
  const unregisterStep = input.ctx.on('agent/pre-step', async ({ agentId }) => {
    const agent = input.ctx.get('agents').get(asAgentId(agentId))
    if (agent === undefined) return
    const system = await input.systemPrompt.assemble({ sessionId: agent.sessionId })
    const measurement = service.measure({ session: input.sessionOf(agent.sessionId), system: system.system, tools: system.tools })
    snapshots.set(agent.sessionId, service.assess({
      measurement,
      contextWindowTokens: input.contextWindowOf(),
      ...(input.reserveOutputTokens === undefined ? {} : { reserveOutputTokens: input.reserveOutputTokens }),
    }))
  })
  return () => {
    unregisterStep()
    unregisterService()
    snapshots.clear()
  }
}

export function measure(input: { readonly session: SessionService; readonly system: string; readonly tools: readonly ToolSchema[] }): TokenMeasurement {
  const surface = input.session.deriveMessages().map((message) => JSON.stringify(message)).join('\n')
  const schemas = JSON.stringify(input.tools)
  let observedInputTokens = 0
  let observedOutputTokens = 0
  for (const event of input.session.events()) {
    if (event.type !== 'assistant/message') continue
    observedInputTokens += event.data.usage?.input ?? 0
    observedOutputTokens += event.data.usage?.output ?? 0
  }
  const systemTokens = estimateTokens(input.system)
  const toolSchemaTokens = estimateTokens(schemas)
  const surfaceTokens = estimateTokens(surface)
  return Object.freeze({
    revision: input.session.length,
    surfaceTokens,
    systemTokens,
    toolSchemaTokens,
    total: surfaceTokens + systemTokens + toolSchemaTokens,
    observedInputTokens,
    observedOutputTokens,
  })
}

export function assess(input: { readonly measurement: TokenMeasurement; readonly contextWindowTokens?: number | undefined; readonly reserveOutputTokens?: number | undefined }): ContextBudgetDecision {
  if (input.contextWindowTokens === undefined || input.contextWindowTokens <= 0) return { status: 'no-context-window', measurement: input.measurement }
  const reserve = Math.max(1_024, input.reserveOutputTokens ?? Math.floor(input.contextWindowTokens * 0.2))
  const thresholdTokens = Math.max(0, input.contextWindowTokens - reserve)
  if (input.measurement.total <= thresholdTokens) return { status: 'below-threshold', measurement: input.measurement, thresholdTokens }
  return {
    status: 'summary-candidate',
    measurement: input.measurement,
    thresholdTokens,
    requiredSavingsTokens: input.measurement.total - thresholdTokens + 1,
  }
}

function estimateTokens(text: string): number {
  return text === '' ? 0 : Math.ceil(text.length / 2)
}
