import type {} from '@lcode/agent-loop'
import type { ModelSelection } from '@lcode/agent-default-model'
import type { Context } from '@lcode/context'
import type { Disposer } from '@lcode/util'

export interface ModelRouteRule {
  readonly id: string
  readonly enabled?: boolean | undefined
  readonly match?: {
    readonly sessionId?: string | undefined
    readonly provider?: string | undefined
    readonly model?: string | undefined
  } | undefined
  readonly target: ModelSelection
}

export interface ModelRoutingInput {
  readonly agentId: string
  readonly sessionId: string
  readonly turn: number
  selection: ModelSelection
}

export interface ModelRoutingService {
  /** 返回新的不可变选择；不修改默认模型，也不改变已经开始的回合。 */
  route(input: ModelRoutingInput): ModelSelection
  rules(): readonly ModelRouteRule[]
}

declare module '@lcode/context' {
  interface Services {
    modelRouting: ModelRoutingService
  }
}

/**
 * 数据驱动的首命中路由。规则不允许执行任意回调，以避免设置文件变成代码执行入口。
 * 目标可以只覆盖 provider/model，参数未提供时继承本轮初始选择。
 */
export function createModelRouter(input: { readonly rules?: readonly ModelRouteRule[] | undefined } = {}): ModelRoutingService {
  const rules = (input.rules ?? []).map(copyRule)
  return {
    route(input) {
      const rule = rules.find((candidate) => matches(candidate, input))
      if (rule === undefined) return copySelection(input.selection)
      return {
        provider: rule.target.provider,
        model: rule.target.model,
        ...(
          rule.target.params === undefined
            ? input.selection.params === undefined ? {} : { params: { ...input.selection.params } }
            : { params: { ...rule.target.params } }
        ),
      }
    },
    rules: () => rules.map(copyRule),
  }
}

/** 将路由接入引擎唯一的选择协作点。撤销即可停止影响后续回合。 */
export function registerModelRouter(input: { readonly ctx: Context; readonly routing: ModelRoutingService }): Disposer {
  const unregisterService = input.ctx.set('modelRouting', input.routing)
  const unregisterRoute = input.ctx.on('agent/model-selection', (async (
    args: ModelRoutingInput,
    next: () => Promise<ModelSelection>,
  ) => {
    args.selection = input.routing.route(args)
    return await next()
  }) as never)
  return () => {
    unregisterRoute()
    unregisterService()
  }
}

function matches(rule: ModelRouteRule, input: ModelRoutingInput): boolean {
  if (rule.enabled === false) return false
  const match = rule.match
  return (match?.sessionId === undefined || match.sessionId === input.sessionId)
    && (match?.provider === undefined || match.provider === input.selection.provider)
    && (match?.model === undefined || match.model === input.selection.model)
}

function copyRule(rule: ModelRouteRule): ModelRouteRule {
  return {
    id: rule.id,
    ...(rule.enabled === undefined ? {} : { enabled: rule.enabled }),
    ...(rule.match === undefined ? {} : { match: { ...rule.match } }),
    target: copySelection(rule.target),
  }
}

function copySelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.params === undefined ? {} : { params: { ...selection.params } }),
  }
}
