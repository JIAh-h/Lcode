import type { Context } from '@lcode/context'
import type { ToolDefinition } from '@lcode/tools'
import type { SubagentRunResult } from '@lcode/subagent'

/**
 * 把内置 `ctx.subagents` 暴露为统一工具流水线中的一个纯委托入口。
 * 该工具自身不直接读写文件、启动进程或请求网络；真正可用的能力仍由 provider 的
 * 子会话 scope 以及 tools/pre-execute 统一收窄和拦截。
 */
export function createSubagentTool(ctx: Context): ToolDefinition<{
  readonly task: string
  readonly allowedToolIds?: readonly string[]
}, SubagentRunResult> {
  return {
    name: 'delegate',
    description: '把一个只读子任务委托给受限子代理，并返回可审计的汇总结果。子代理不能请求人工审批。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '需要独立调查或汇总的具体子任务' },
        allowedToolIds: { type: 'array', description: '可选，只能缩小子代理默认的只读工具集合' },
      },
      required: ['task'],
    },
    async execute(call, opts) {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('delegate 缺少会话 scope')
      return await ctx.get('subagents').run({
        parentSessionId: sessionId,
        ...(agentIdOf(opts.scope) === undefined ? {} : { parentAgentId: agentIdOf(opts.scope) }),
        task: call.parsed.task,
        ...(call.parsed.allowedToolIds === undefined ? {} : { allowedToolIds: call.parsed.allowedToolIds }),
      })
    },
  }
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function agentIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly agentId?: unknown }).agentId
  return typeof value === 'string' && value !== '' ? value : undefined
}
