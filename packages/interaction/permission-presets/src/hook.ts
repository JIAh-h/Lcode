import type { Context } from '@lcode/context'
import type { ApprovalService } from '@lcode/approval'
import type { SessionService } from '@lcode/session'
import type { ToolActionIntent, ToolCall } from '@lcode/tools'
import { ERROR_CODES } from '@lcode/util'
import { evaluate } from './policy.ts'
import type { PermissionPresetService } from './permission-presets.ts'

/**
 * 把权限判定接进工具流水线（12 §6.4；批次⑥）。
 *
 * ## 它做了什么
 *
 * 订阅 `tools/pre-execute`（waterfall），对**工具申报的意图**做判定：
 *
 * | 判定 | 动作 |
 * |---|---|
 * | `allow` | 什么都不做（放行） |
 * | `deny` | 往 `payload.deny` 写理由（注册表会拒掉，**工具体不执行**） |
 * | `ask` | 调 `approval.ask` → **只有 `allowed-once` 才放行** |
 *
 * ## 审批的四种结果都要分别处理
 *
 * - `rejected` → 用户拒绝（`EP-APPROVAL_REJECTED`）
 * - `cancelled` → 请求作废（`EP-APPROVAL_CANCELLED`）
 * - `unavailable` → **没有应答者**，fail-closed（`EP-APPROVAL_UNAVAILABLE`）
 *
 * 把 `unavailable` 读成"没人反对所以放行"是最危险的读法——那正好把 D11 反了过来。
 *
 * ## 会话身份从哪来
 *
 * `scope` 由引擎在每次 `tools.execute` 时传下来（见 `agent-loop` 的 `executeTool`），
 * **不走 ctx 上的全局变量**：多个会话可以并发跑工具，一份全局的"当前会话"
 * 会在并发时互相覆盖——那会让 A 会话的写按 B 会话的工作区做边界判定。
 */

/** 引擎传给每次工具执行的 scope（`ToolRegistry.execute` 的第三参） */
export interface ToolExecutionScope {
  readonly sessionId: string
}

export interface PolicyHookOptions {
  readonly ctx: Context
  /** 审批服务。缺失 = 一律 `unavailable`（fail-closed），这是**合法**配置（无人值守） */
  readonly approval?: ApprovalService | undefined
  readonly presets: PermissionPresetService
  /** 某个会话的工作区根（从会话 header 的 cwd 读，不是 `process.cwd()`） */
  readonly workspaceOf: (sessionId: string) => string | undefined
  /** 取会话（审批事件要落到它的日志里） */
  readonly getSession: (sessionId: string) => SessionService | undefined
  /** "项目已见命令集"（启发式；省略则不据它判定） */
  readonly seenCommands?: ReadonlySet<string> | undefined
  readonly seenDomains?: ReadonlySet<string> | undefined
}

/**
 * 装上审批钩子，返回撤销器。
 *
 * **装上之后，未被许可的副作用不会发生**——这不是"提示"，是拦截：拒掉时
 * 工具体根本不会执行（见 `InMemoryToolRegistry.execute` 的第 3 步）。
 *
 * 处理器签名遵循 `waterfall` 的约定 `(args, next) => R`：改完 `args` 后
 * **必须调 `next()`**，否则整条链短路、注册表拿不到 `pre`（表现为"拒绝失效"）。
 */
export function installPolicyHook(options: PolicyHookOptions): () => void {
  const { ctx, approval, presets, workspaceOf } = options

  const handler = async (
    payload: { call: ToolCall; intent?: ToolActionIntent; scope?: unknown; deny?: string },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    // 工具没申报意图 = 它声明自己无外部副作用（如纯计算的 todo_write）→ 放行
    if (payload.intent === undefined) return next()

    const sessionId = sessionIdOf(payload.scope)
    if (sessionId === undefined) {
      /*
       * 拿不到会话身份就**判不出**路径边界，而"判不出来"必须按最保守处理。
       * 直接拒绝而不是放行：放行意味着"边界未知时默认可以在任意路径写"，
       * 那正好把 T5 反过来。
       */
      payload.deny = '这个工具调用没有带上会话身份，无法判定路径边界（已按最保守方式拒绝）'
      return next()
    }

    const workspaceRoot = workspaceOf(sessionId)
    if (workspaceRoot === undefined) {
      payload.deny = '拿不到这个会话的工作区根，无法判定路径边界（已按最保守方式拒绝）'
      return next()
    }

    const verdict = evaluate(
      {
        // 工具名在 `call.name` 上；工具只申报"要碰什么"
        tool: payload.call.name,
        summary: payload.intent.summary,
        ...(payload.intent.paths === undefined ? {} : { paths: payload.intent.paths }),
        ...(payload.intent.argv === undefined ? {} : { argv: payload.intent.argv }),
        ...(payload.intent.domains === undefined ? {} : { domains: payload.intent.domains }),
        ...(payload.intent.env === undefined ? {} : { env: payload.intent.env }),
      },
      {
        preset: presets.get(),
        workspaceRoot,
        ...(options.seenCommands === undefined ? {} : { seenCommands: options.seenCommands }),
        ...(options.seenDomains === undefined ? {} : { seenDomains: options.seenDomains }),
      },
    )

    if (verdict.kind === 'deny') {
      payload.deny = verdict.reason
      return next()
    }

    if (verdict.kind === 'ask') {
      // ── ask：问一次。**只有 allowed-once 才放行** ──
      const result =
        approval === undefined
          ? ('unavailable' as const)
          : await approval.ask({
              callId: payload.call.callId,
              action: {
                tool: payload.call.name,
                summary: payload.intent.summary,
                ...(payload.intent.argv === undefined ? {} : { argv: payload.intent.argv }),
              },
              basis: verdict.basis,
              impact: verdict.impact,
            })
      if (result !== 'allowed-once') payload.deny = denyReason(result)
    }
    // verdict.kind === 'allow' → 什么都不做

    return next()
  }

  return ctx.on('tools/pre-execute', handler as never)
}

/** 从 scope 里取出会话 id（形状由引擎保证；非本形状一律当作"拿不到"） */
function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const id = (scope as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

function denyReason(result: 'rejected' | 'cancelled' | 'unavailable'): string {
  switch (result) {
    case 'rejected':
      return `用户拒绝了这次操作（${ERROR_CODES.EP_APPROVAL_REJECTED}）`
    case 'cancelled':
      return `这次操作已被取消（${ERROR_CODES.EP_APPROVAL_CANCELLED}）`
    case 'unavailable':
      // 措辞要说清"没人被问到"，而不是"被拒了"——两者对用户的意义完全不同
      return `没有人能确认这次操作，已按最保守方式拒绝（${ERROR_CODES.EP_APPROVAL_UNAVAILABLE}）`
  }
}

export { sessionIdOf }
