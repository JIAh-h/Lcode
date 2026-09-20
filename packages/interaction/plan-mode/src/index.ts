import type { Context } from '@lcode/context'
import type { PlanArtifact, SessionService } from '@lcode/session'
import type { SystemPromptService } from '@lcode/system-prompt'
import type { ToolCall, ToolDefinition, ToolRegistry } from '@lcode/tools'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/** 计划态向模型和执行器开放的工具。名单以能力而非工具的描述文案为准。 */
export const PLAN_READONLY_TOOL_IDS = ['read', 'glob', 'grep'] as const
export const PLAN_SUBMIT_TOOL_ID = 'submit_plan'
export const PLAN_CHANGE_TOOL_ID = 'request_plan_change'

export interface ApprovedPlan {
  readonly proposedSeq: number
  readonly plan: PlanArtifact
  /** 作为正常执行回合的用户消息。不能从展示文本反向猜计划。 */
  readonly executionPrompt: string
}

export interface PlanModeService {
  /** 当前会话是否处于只读探索阶段；重启后从事件日志恢复。 */
  isActive(sessionId: string): boolean
  /** 进入只读探索，写入可审计的模式事件。 */
  enter(sessionId: string): void
  /** 用户确认最近一次计划后退出只读探索，并返回要交给执行回合的权威计划。 */
  confirm(sessionId: string): ApprovedPlan
  /** 用户取消计划，退出但不改变任何文件。 */
  cancel(sessionId: string): void
  dispose(): void
}

export interface PlanModeOptions {
  readonly ctx: Context
  readonly getSession: (sessionId: string) => SessionService
  readonly systemPrompt: SystemPromptService
  readonly tools: ToolRegistry
  /** 执行中遇到实质偏离时，复用统一审批通道请求用户确认。 */
  readonly approval?: PlanChangeApprovalPort | undefined
  readonly readonlyToolIds?: readonly string[] | undefined
}

/** 仅依赖“问一次并得到结果”的边界，避免计划包反向依赖具体审批实现。 */
export interface PlanChangeApprovalPort {
  ask(
    request: {
      readonly callId: string
      readonly action: { readonly tool: string; readonly summary: string }
      readonly basis: { readonly source: 'guard'; readonly reason: string }
      readonly impact: { readonly processScope: string }
    },
    options: { readonly signal: AbortSignal; readonly session: SessionService },
  ): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/**
 * 会话级计划模式（10 §5.5）。
 *
 * 不使用 ToolRegistry.restrict：它是进程级收窄，两个并行会话会互相影响。
 * 这里从执行 scope 取 sessionId，同时在请求装配和执行前两处收窄，确保提示词
 * 漏配也不会让写工具真正运行。
 */
export function createPlanModeService(options: PlanModeOptions): PlanModeService {
  const readonlyIds = new Set(options.readonlyToolIds ?? PLAN_READONLY_TOOL_IDS)
  const active = new Map<string, boolean>()

  const modeOf = (sessionId: string): boolean => {
    const cached = active.get(sessionId)
    if (cached !== undefined) return cached
    let enabled = false
    for (const event of options.getSession(sessionId).events()) {
      if (event.type === 'plan/mode') enabled = event.data.active
    }
    active.set(sessionId, enabled)
    return enabled
  }

  const setMode = (sessionId: string, enabled: boolean, reason: 'entered' | 'confirmed' | 'cancelled'): void => {
    if (modeOf(sessionId) === enabled) return
    options.getSession(sessionId).append({ type: 'plan/mode', data: { active: enabled, reason } })
    active.set(sessionId, enabled)
  }

  const planTool: ToolDefinition<{ summary: string; steps: readonly string[]; risks?: readonly string[] }, PlanArtifact> = {
    name: PLAN_SUBMIT_TOOL_ID,
    description: '提交一份供用户确认的结构化实施计划。仅计划模式可用；提交后等待用户点击“开始执行”，不要自行实施。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '计划要解决什么' },
        steps: { type: 'array', description: '按顺序实施的步骤' },
        risks: { type: 'array', description: '需要用户知晓的风险或待确认项' },
      },
      required: ['summary', 'steps'],
    },
    execute: (call, opts) => {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined || !modeOf(sessionId)) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_DENIED,
          message: 'submit_plan 只能在活动计划模式中调用',
          userMessage: '请先进入计划模式，再提交计划。',
          retryable: false,
        })
      }
      const plan = normalizePlan(call.parsed)
      options.getSession(sessionId).append({ type: 'plan/proposed', data: { plan } })
      return plan
    },
  }
  const removePlanTool = options.tools.register(planTool)
  const changeTool: ToolDefinition<{ summary: string; steps: readonly string[]; reason: string }, { accepted: boolean; result: string }> = {
    name: PLAN_CHANGE_TOOL_ID,
    description: '请求用户确认对已批准计划的实质变更。仅正常执行中且已有已批准计划时可用；未经允许不得按新方案继续。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '变更后的目标或方案' },
        steps: { type: 'array', description: '变更后仍要执行的步骤' },
        reason: { type: 'string', description: '为什么不能按原计划继续' },
      },
      required: ['summary', 'steps', 'reason'],
    },
    execute: async (call, opts) => {
      const sessionId = sessionIdOf(opts.scope)
      const current = sessionId === undefined ? undefined : approvedPlan(options.getSession(sessionId))
      if (sessionId === undefined || current === undefined || modeOf(sessionId)) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_DENIED,
          message: 'request_plan_change 仅可用于已有已批准计划的正常执行回合',
          userMessage: '当前没有可以变更的已批准计划。',
          retryable: false,
        })
      }
      const plan = normalizePlan(call.parsed)
      const reason = typeof call.parsed.reason === 'string' ? call.parsed.reason.trim() : ''
      if (reason === '') {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.ET_INVALID_ARGS,
          message: '计划变更必须说明原因',
          userMessage: '请说明为什么需要改变已批准的计划。',
          retryable: false,
        })
      }
      const result = options.approval === undefined
        ? 'unavailable'
        : await options.approval.ask({
            callId: `plan-change:${sessionId}:${call.callId}`,
            action: { tool: PLAN_CHANGE_TOOL_ID, summary: `变更执行计划：${plan.summary}` },
            basis: { source: 'guard', reason: `原计划需调整：${reason}` },
            impact: { processScope: '当前会话的后续执行步骤' },
          }, { signal: opts.signal, session: options.getSession(sessionId) })
      if (result === 'allowed-once') {
        options.getSession(sessionId).append({
          type: 'plan/changed',
          data: { previousProposedSeq: current.proposedSeq, plan, reason },
        })
      }
      return { accepted: result === 'allowed-once', result }
    },
  }
  const removeChangeTool = options.tools.register(changeTool)

  const removePromptContext = options.systemPrompt.context(
    'plan-mode-instructions',
    ({ sessionId }) =>
      sessionId !== undefined && modeOf(sessionId)
        ? [
            '## 当前模式：计划模式',
            '',
            '你现在只能进行只读探索：使用 read、glob、grep 了解项目并给出可执行计划。',
            '不要尝试编辑文件、运行命令或打开终端。完成探索后必须调用 submit_plan 提交 summary、steps、risks，',
            '然后等待用户点击“开始执行”；不要自行实施。',
          ].join('\n')
        : sessionId !== undefined && approvedPlan(options.getSession(sessionId)) !== undefined
          ? '## 已批准的执行计划\n\n若发现必须实质性改变目标、范围或技术方案，必须先调用 request_plan_change 说明原因和新步骤，等待用户批准。未批准时继续按原计划执行；普通实现细节可自行处理。'
          : '',
  )
  const removeToolFilter = options.systemPrompt.tools((all, promptCtx) =>
    promptCtx.sessionId !== undefined && modeOf(promptCtx.sessionId)
      ? all.filter((tool) => readonlyIds.has(tool.name) || tool.name === PLAN_SUBMIT_TOOL_ID)
      : all.filter((tool) =>
          tool.name !== PLAN_SUBMIT_TOOL_ID &&
          (tool.name !== PLAN_CHANGE_TOOL_ID ||
            (promptCtx.sessionId !== undefined && approvedPlan(options.getSession(promptCtx.sessionId)) !== undefined)),
        ),
  )
  const executionGuard = async (
    payload: { call: ToolCall; scope?: unknown; deny?: string },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const sessionId = sessionIdOf(payload.scope)
    if (payload.call.name === PLAN_SUBMIT_TOOL_ID && (sessionId === undefined || !modeOf(sessionId))) {
      payload.deny = 'submit_plan 只能在活动计划模式中使用。'
    } else if (payload.call.name === PLAN_CHANGE_TOOL_ID && (sessionId === undefined || modeOf(sessionId) || approvedPlan(options.getSession(sessionId)) === undefined)) {
      payload.deny = 'request_plan_change 只能在已有已批准计划的正常执行回合中使用。'
    } else if (sessionId !== undefined && modeOf(sessionId) && !readonlyIds.has(payload.call.name) && payload.call.name !== PLAN_SUBMIT_TOOL_ID) {
      payload.deny = `计划模式只允许只读探索；${payload.call.name} 需要用户确认开始执行后才能运行。`
    }
    return next()
  }
  // Context 的公开 on() 类型是普通广播；工具注册表以 waterfall 调用该事件。
  const removeExecutionGuard = options.ctx.on('tools/pre-execute', executionGuard as never)

  return {
    isActive: modeOf,
    enter: (sessionId) => setMode(sessionId, true, 'entered'),
    confirm: (sessionId) => {
      if (!modeOf(sessionId)) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EC_NOT_RUNNING,
          message: '计划模式未激活，不能确认计划',
          userMessage: '当前没有等待确认的计划。',
          retryable: false,
        })
      }
      const pending = pendingPlan(options.getSession(sessionId))
      if (pending === undefined) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EC_INVALID_PARAMS,
          message: '计划模式尚未提交 plan/proposed',
          userMessage: '请先让助手提交一份计划，再开始执行。',
          retryable: false,
        })
      }
      options.getSession(sessionId).append({ type: 'plan/approved', data: { proposedSeq: pending.seq } })
      setMode(sessionId, false, 'confirmed')
      return {
        proposedSeq: pending.seq,
        plan: pending.plan,
        executionPrompt: executionPrompt(pending.plan),
      }
    },
    cancel: (sessionId) => setMode(sessionId, false, 'cancelled'),
    dispose: () => {
      removePlanTool()
      removeChangeTool()
      removeExecutionGuard()
      removeToolFilter()
      removePromptContext()
      active.clear()
    },
  }
}

function normalizePlan(input: { summary: string; steps: readonly string[]; risks?: readonly string[] }): PlanArtifact {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const steps = Array.isArray(input.steps) ? input.steps.filter((step): step is string => typeof step === 'string').map((step) => step.trim()).filter(Boolean) : []
  const risks = Array.isArray(input.risks) ? input.risks.filter((risk): risk is string => typeof risk === 'string').map((risk) => risk.trim()).filter(Boolean) : []
  if (summary === '' || steps.length === 0) {
    throw new LcodeErrorImpl({
      code: ERROR_CODES.ET_INVALID_ARGS,
      message: '计划必须包含非空 summary 和 steps',
      userMessage: '计划需要说明目标并列出至少一个实施步骤。',
      retryable: false,
    })
  }
  return { summary, steps, ...(risks.length === 0 ? {} : { risks }) }
}

function pendingPlan(session: SessionService): { readonly seq: number; readonly plan: PlanArtifact } | undefined {
  let enteredAt = -1
  let latest: { readonly seq: number; readonly plan: PlanArtifact } | undefined
  for (const event of session.events()) {
    if (event.type === 'plan/mode' && event.data.active) {
      enteredAt = event.seq
      latest = undefined
    }
    if (event.type === 'plan/proposed' && event.seq > enteredAt) latest = { seq: event.seq, plan: event.data.plan }
  }
  return latest
}

function approvedPlan(session: SessionService): { readonly proposedSeq: number; readonly plan: PlanArtifact } | undefined {
  const proposals = new Map<number, PlanArtifact>()
  let approved: { readonly proposedSeq: number; readonly plan: PlanArtifact } | undefined
  for (const event of session.events()) {
    if (event.type === 'plan/proposed') proposals.set(event.seq, event.data.plan)
    if (event.type === 'plan/approved') {
      const plan = proposals.get(event.data.proposedSeq)
      if (plan !== undefined) approved = { proposedSeq: event.data.proposedSeq, plan }
    }
  }
  return approved
}

function executionPrompt(plan: PlanArtifact): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
  const risks = plan.risks === undefined ? '' : `\n\n已知风险或待确认项：\n${plan.risks.map((risk) => `- ${risk}`).join('\n')}`
  return [
    '我已确认以下实施计划。现在请直接执行，不要再次只做规划。',
    '',
    `目标：${plan.summary}`,
    '',
    `步骤：\n${steps}${risks}`,
    '',
    '若发现必须实质性改变目标、范围或技术方案，先说明变更和影响，等待我确认；普通实现细节可以自行处理。',
  ].join('\n')
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

declare module '@lcode/context' {
  interface Services {
    planMode: PlanModeService
  }
}
