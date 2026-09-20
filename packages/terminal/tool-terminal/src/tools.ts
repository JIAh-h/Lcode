import type { TerminalService } from '@lcode/terminal'
import type { ToolActionIntent, ToolDefinition } from '@lcode/tools'
import type { JsonValue } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { resolve } from 'node:path'

const TERMINAL_OPS = ['open', 'send', 'read', 'signal', 'close', 'list'] as const
type TerminalOp = (typeof TERMINAL_OPS)[number]

interface TerminalToolArgs {
  readonly op: TerminalOp
  readonly terminalId?: string | undefined
  readonly data?: string | undefined
  readonly signal?: string | undefined
  readonly cwd?: string | undefined
  readonly shell?: string | undefined
}

export interface ToolTerminalDeps {
  readonly terminals: TerminalService
  readonly workspaceRoot: string
  readonly workspaceOf?: ((sessionId: string) => string | undefined) | undefined
}

/**
 * 单一 terminal 工具，按 `op` 闭合分派六个终端动作。
 *
 * owner 永远从 `ExecuteOpts.scope.agentId` 取，绝不接受模型声称的 owner id；否则任意
 * 模型输出都可以借另一个 agent 的终端继续执行命令。
 */
export function createTerminalTool(deps: ToolTerminalDeps): ToolDefinition<TerminalToolArgs> {
  return {
    name: 'terminal',
    description:
      '管理持久终端：open 打开，send 发送输入，read 按 offset 读取增量输出，signal 中断，' +
      'close 关闭，list 列出当前任务拥有的终端。终端输入不会自动进入对话上下文。',
    card: 'terminal',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: TERMINAL_OPS, description: '操作：open、send、read、signal、close 或 list' },
        terminalId: { type: 'string', description: '终端 ID（send/read/signal/close 必填）' },
        data: { type: 'string', description: '发送给终端的原始输入（send 必填）' },
        signal: { type: 'string', description: '信号名称，例如 SIGINT（signal 必填）' },
        cwd: { type: 'string', description: '打开终端的工作目录（open 可选，默认当前工作区）' },
        shell: { type: 'string', description: '终端 shell（open 可选）' },
      },
      required: ['op'],
    },
    describeAction: (parsed) => actionFor(parsed),
    presentationMeta: (args, value) => presentationFor(args, value),
    execute: async (call, opts) => {
      const args = call.parsed
      const ownerAgentId = agentIdOf(opts.scope)
      const root = workspaceFor(opts.scope, deps)
      switch (args.op) {
        case 'open': {
          const opened = await deps.terminals.open({
            ownerAgentId,
            cwd: args.cwd === undefined ? root : resolve(root, args.cwd),
            ...(args.shell === undefined ? {} : { shell: args.shell }),
          })
          return opened as never
        }
        case 'send': {
          const terminalId = requiredString(args.terminalId, 'terminalId')
          const data = requiredString(args.data, 'data', true)
          return (await deps.terminals.send({ ownerAgentId, terminalId, data })) as never
        }
        case 'read': {
          const terminalId = requiredString(args.terminalId, 'terminalId')
          return (await deps.terminals.read({ ownerAgentId, terminalId })) as never
        }
        case 'signal': {
          const terminalId = requiredString(args.terminalId, 'terminalId')
          const signal = requiredString(args.signal, 'signal')
          return (await deps.terminals.signal({ ownerAgentId, terminalId, signal })) as never
        }
        case 'close': {
          const terminalId = requiredString(args.terminalId, 'terminalId')
          return (await deps.terminals.close({ ownerAgentId, terminalId })) as never
        }
        case 'list':
          return { terminals: deps.terminals.list({ ownerAgentId }) } as never
        default:
          throw invalidArgs('op 必须是 open、send、read、signal、close 或 list')
      }
    },
  }
}

function actionFor(args: TerminalToolArgs): ToolActionIntent {
  const summary = actionSummary(args)
  if (args.op === 'read' || args.op === 'list') return { summary }
  return {
    summary,
    // 让终端的创建、输入、中断、关闭经过与 shell 相同的权限流水线；在只读预设下
    // 它们会被拒绝，而不是绕开用户选择的边界。
    paths: [{ path: args.cwd ?? '.', mode: 'write' }],
    argv: ['terminal', args.op],
  }
}

function presentationFor(args: TerminalToolArgs, value: JsonValue): JsonValue {
  const result = isRecord(value) ? value : {}
  const terminalId = typeof result.terminalId === 'string' ? result.terminalId : args.terminalId
  const data = typeof result.data === 'string' ? result.data : ''
  const meta: Record<string, JsonValue> = {
    description: actionSummary(args),
    op: args.op,
  }
  if (terminalId !== undefined) meta.terminalId = terminalId
  // 复用现有 terminal 卡片的输出区域；完整的持久终端抽屉属于 P3-04。
  if (args.op === 'read') {
    meta.stdout = data
    meta.exited = result.exited === true
    meta.exitCode = typeof result.exitCode === 'number' ? result.exitCode : ''
  }
  if (args.op === 'list') meta.stdout = JSON.stringify(result.terminals ?? [], null, 2)
  return meta
}

function workspaceFor(scope: unknown, deps: ToolTerminalDeps): string {
  const sessionId = sessionIdOf(scope)
  return (sessionId === undefined ? undefined : deps.workspaceOf?.(sessionId)) ?? deps.workspaceRoot
}

function agentIdOf(scope: unknown): string {
  if (typeof scope === 'object' && scope !== null) {
    const agentId = (scope as { agentId?: unknown }).agentId
    if (typeof agentId === 'string' && agentId !== '') return agentId
  }
  throw new LcodeErrorImpl({
    code: ERROR_CODES.EC_NOT_READY,
    message: 'terminal 工具调用缺少 agentId scope',
    userMessage: '当前任务还没有准备好使用终端。',
  })
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const sessionId = (scope as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw invalidArgs(`${field} 必填`)
  return value
}

function invalidArgs(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ET_INVALID_ARGS,
    message,
    userMessage: '终端工具参数无效。',
  })
}

function actionSummary(args: TerminalToolArgs): string {
  switch (args.op) {
    case 'open': return `打开持久终端${args.cwd === undefined ? '' : `：${args.cwd}`}`
    case 'send': return `向终端发送输入：${args.terminalId ?? ''}`
    case 'read': return `读取终端输出：${args.terminalId ?? ''}`
    case 'signal': return `中断终端：${args.terminalId ?? ''}`
    case 'close': return `关闭终端：${args.terminalId ?? ''}`
    case 'list': return '列出当前任务的终端'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
