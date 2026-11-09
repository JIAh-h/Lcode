import type { Context } from '@lcode/context'
import type { ToolDefinition } from '@lcode/tools'
import type { SubagentArtifacts, SubagentRunResult } from '@lcode/subagent'

/**
 * 子代理的两个门面，能力相同、等待方式不同。
 *
 * - `delegate`（本文件同包）：同步等待，返回完整结论。
 * - `delegate_async`（本文件）：立刻返回回执，父会话可以继续做别的事。
 * - `delegate_wait`：按 delegation id 取回结果；未结束就等，已结束立刻返回。
 *
 * 三者共用 `ctx.subagents`，因此审计事件、深度校验与只读收窄完全一致——
 * 这里只是把"等不等"的选择权交给模型，而不是复制一套执行逻辑。
 */

const DELIVER = {
  type: 'object',
  properties: {
    task: { type: 'string', description: '需要独立调查或汇总的具体子任务' },
    allowedToolIds: { type: 'array', description: '可选，只能缩小子代理默认的只读工具集合' },
  },
  required: ['task'],
} as const

export interface AsyncDelegateResult {
  readonly state: 'started' | 'rejected'
  readonly delegationId: string
  readonly childSessionId?: string | undefined
  readonly depth?: number | undefined
  /** started：提示父代理稍后用 delegate_wait 取结果 */
  readonly hint?: string | undefined
  readonly error?: string | undefined
}

export interface AwaitDelegateResult {
  readonly state: 'completed' | 'failed' | 'unknown'
  readonly delegationId: string
  readonly childSessionId?: string | undefined
  readonly result?: string | undefined
  readonly artifacts?: SubagentArtifacts | undefined
  readonly error?: string | undefined
}

/** 立刻派发，不阻塞父会话。 */
export function createAsyncSubagentTool(ctx: Context): ToolDefinition<{ readonly task: string; readonly allowedToolIds?: readonly string[] }, AsyncDelegateResult> {
  return {
    name: 'delegate_async',
    description: '把一个只读子任务派发给子代理后**立即返回**，不等待它跑完；之后用 delegate_wait 取结果。适合同一轮里还有别的事要做时。',
    card: 'generic',
    inputSchema: DELIVER,
    async execute(call, opts) {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('delegate_async 缺少会话 scope')
      const outcome = await ctx.get('subagents').start({
        parentSessionId: sessionId,
        ...(agentIdOf(opts.scope) === undefined ? {} : { parentAgentId: agentIdOf(opts.scope) }),
        task: call.parsed.task,
        ...(call.parsed.allowedToolIds === undefined ? {} : { allowedToolIds: call.parsed.allowedToolIds }),
        // 同样是会话内的执行单元：父回合取消时一并中止。
        signal: opts.signal,
      })
      if (outcome.kind === 'rejected') {
        return {
          state: 'rejected',
          delegationId: outcome.result.delegationId,
          ...(outcome.result.error === undefined ? {} : { error: outcome.result.error }),
        }
      }
      return {
        state: 'started',
        delegationId: outcome.receipt.delegationId,
        childSessionId: outcome.receipt.childSessionId,
        depth: outcome.receipt.depth,
        hint: '它还在跑。需要结论时调用 delegate_wait（可以继续做别的事，不必立刻等）。',
      }
    },
  }
}

/** 取回已派发子代理的结果；未结束则等待。 */
export function createAwaitSubagentTool(ctx: Context): ToolDefinition<{ readonly delegationId: string }, AwaitDelegateResult> {
  return {
    name: 'delegate_wait',
    description: '等待并取回 delegate_async 派发的子代理结果。子代理已结束会立即返回；未知 id 返回 state=unknown。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        delegationId: { type: 'string', description: 'delegate_async 返回的 delegationId' },
      },
      required: ['delegationId'],
    },
    async execute(call) {
      const delegationId = call.parsed.delegationId
      const settled = await ctx.get('subagents').wait(delegationId)
      if (settled === undefined) return { state: 'unknown', delegationId, error: '没有这个派发记录（可能已随进程重启清理）。' }
      return toAwaitResult(settled)
    },
  }
}

function toAwaitResult(result: SubagentRunResult): AwaitDelegateResult {
  return {
    state: result.outcome === 'completed' ? 'completed' : 'failed',
    delegationId: result.delegationId,
    ...(result.childSessionId === undefined ? {} : { childSessionId: result.childSessionId }),
    ...(result.result === undefined ? {} : { result: result.result }),
    ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
    ...(result.error === undefined ? {} : { error: result.error }),
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
