import type { Context } from '@lcode/context'
import type { ApprovalService } from '@lcode/approval'
import { normalizePath } from '@lcode/fs'
import type { FsMutationAuthority } from '@lcode/fs'
import type { Impact, SessionService } from '@lcode/session'
import '@lcode/sandbox'
import type { SandboxService, SandboxStatus } from '@lcode/sandbox'
import type { ToolActionIntent, ToolCall } from '@lcode/tools'
import { ERROR_CODES } from '@lcode/util'
import { evaluate } from './policy.ts'
import { knobsOf } from './permission-presets.ts'
import type { PermissionPreset, PermissionPresetService } from './permission-presets.ts'
import type { WorkspaceTrustService } from './workspace-trust.ts'
import { resolve } from 'node:path'

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
  /** 发起这次工具调用的 agent；持久终端等资源用它作所有权边界。 */
  readonly agentId: string
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
  /** 未明确可信的工作区只允许读取；此服务的持久化不属于工作区。 */
  readonly workspaceTrust?: WorkspaceTrustService | undefined
  /**
   * 当前 OS 沙箱 Provider。它是可选依赖，便于纯策略测试；桌面运行时必须注入。
   * Provider 报告降级时，策略层决定审批或拒绝，不能继续把裸执行当作受保护执行。
   */
  readonly sandbox?: SandboxService | undefined
  /** "项目已见命令集"（启发式；省略则不据它判定） */
  readonly seenCommands?: ReadonlySet<string> | undefined
  readonly seenDomains?: ReadonlySet<string> | undefined
  /**
   * 文件 Provider 的一次性写入许可。只在本 hook 最终放行之后签发，避免
   * “审批已拒绝、底层却仍能直接写” 的能力旁路。
   */
  readonly mutationAuthority?: FsMutationAuthority | undefined
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
    payload: { call: ToolCall; intent?: ToolActionIntent; scope?: unknown; signal?: AbortSignal; deny?: string },
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

    // 首次打开的目录默认不可信。读取仍可用于了解项目；写、shell 与终端等副作用
    // 必须等用户在桌面弹窗/设置/CLI 显式授予精确目录信任后才进入后续策略与审批。
    if (isMutationIntent(payload.intent) && options.workspaceTrust?.isTrusted(workspaceRoot) === false) {
      payload.deny = '这个工作区尚未被信任；当前只允许读取。请先在工作区提示或设置中选择“信任此文件夹”。'
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

    const sandboxStatus = await statusForMutation(options.sandbox, payload.intent)
    if (sandboxStatus?.degraded === true) {
      const session = options.getSession(sessionId)
      session?.append({
        type: 'sandbox/degraded',
        data: { reason: sandboxStatus.reason ?? '当前沙箱 Provider 未能强制约束此操作。', mechanism: sandboxStatus.mechanism },
      })

      // `never` 的含义不是“关闭询问就允许裸跑”。没有系统级边界时，不可询问
      // 的自动/无人值守档必须拒绝；否则会把用户选择的“少打扰”变成“无防护”。
      if (knobsOf(presets.get()).approvalPolicy === 'never') {
        payload.deny = `当前沙箱不可用，${sandboxStatus.reason ?? '无法强制约束此操作'}；此预设不询问，已按最保守方式拒绝`
        return next()
      }

      const degradation = sandboxImpact(sandboxStatus, presets.get())
      const forced = verdict.kind === 'ask'
        ? { kind: 'ask' as const, basis: { ...verdict.basis, reason: `${verdict.basis.reason}；${degradation.reason}` }, impact: mergeImpact(verdict.impact, degradation.impact) }
        : { kind: 'ask' as const, basis: degradation.basis, impact: degradation.impact }
      const result = await requestApproval({
        approval,
        call: payload.call,
        intent: payload.intent,
        session,
        signal: payload.signal,
        basis: forced.basis,
        impact: forced.impact,
      })
      if (result !== 'allowed-once') payload.deny = denyReason(result)
      else grantMutation(options.mutationAuthority, payload.call, sessionId, workspaceRoot, payload.intent)
      return next()
    }

    if (verdict.kind === 'ask') {
      // ── ask：问一次。**只有 allowed-once 才放行** ──
      const result = await requestApproval({
        approval,
        call: payload.call,
        intent: payload.intent,
        session: options.getSession(sessionId),
        signal: payload.signal,
        basis: verdict.basis,
        impact: verdict.impact,
      })
      if (result !== 'allowed-once') payload.deny = denyReason(result)
    }
    // verdict.kind === 'allow' → 什么都不做

    if (payload.deny === undefined) {
      grantMutation(options.mutationAuthority, payload.call, sessionId, workspaceRoot, payload.intent)
    }

    return next()
  }

  return ctx.on('tools/pre-execute', handler as never)
}

function isSandboxRelevant(intent: ToolActionIntent): boolean {
  return isMutationIntent(intent)
}

async function statusForMutation(sandbox: SandboxService | undefined, intent: ToolActionIntent): Promise<SandboxStatus | undefined> {
  if (sandbox === undefined || !isSandboxRelevant(intent)) return undefined
  try {
    return await sandbox.status()
  } catch {
    // 无法读取 Provider 状态和明确的 degraded 等价：不能把“状态查询出错”解释成安全。
    return {
      available: false,
      mechanism: 'unknown',
      knownEscapeSurfaces: ['沙箱状态不可读取'],
      degraded: true,
      reason: '无法读取当前沙箱状态，无法确认系统级约束是否生效。',
      capabilities: {
        platform: process.platform,
        mechanism: 'unknown',
        boundaries: {
          filesystem: { state: 'unavailable', plannedMechanism: 'unknown', message: '沙箱状态不可读取' },
          network: { state: 'unavailable', plannedMechanism: 'unknown', message: '沙箱状态不可读取' },
          spawn: { state: 'unavailable', plannedMechanism: 'unknown', message: '沙箱状态不可读取' },
        },
        reason: '沙箱状态不可读取',
      },
    }
  }
}

function sandboxImpact(status: SandboxStatus, preset: PermissionPreset): {
  readonly basis: { readonly source: 'preset'; readonly reason: string; readonly presetName: PermissionPreset }
  readonly impact: Impact
  readonly reason: string
} {
  const reason = status.reason ?? `当前 ${status.mechanism} 沙箱未能强制约束此操作`
  return {
    basis: { source: 'preset', reason: `当前操作没有系统级沙箱约束：${reason}`, presetName: preset },
    impact: { sandbox: { status: 'degraded', mechanism: status.mechanism, reason } },
    reason,
  }
}

function mergeImpact(left: Impact, right: Impact): Impact {
  return { ...left, ...right }
}

async function requestApproval(input: {
  readonly approval: ApprovalService | undefined
  readonly call: ToolCall
  readonly intent: ToolActionIntent
  readonly session: SessionService | undefined
  readonly signal: AbortSignal | undefined
  readonly basis: Parameters<ApprovalService['ask']>[0]['basis']
  readonly impact: Impact
}): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
  if (input.approval === undefined) return 'unavailable'
  return input.approval.ask(
    {
      callId: input.call.callId,
      action: {
        tool: input.call.name,
        summary: input.intent.summary,
        ...(input.intent.argv === undefined ? {} : { argv: input.intent.argv }),
      },
      basis: input.basis,
      impact: input.impact,
    },
    { session: input.session, ...(input.signal === undefined ? {} : { signal: input.signal }) },
  )
}

function isMutationIntent(intent: ToolActionIntent): boolean {
  return intent.argv !== undefined || intent.paths?.some((path) => path.mode === 'write') === true
}

/** 只签发 write 路径；read/shell 等其它能力不会借文件 broker 获得权限。 */
function grantMutation(
  authority: FsMutationAuthority | undefined,
  call: ToolCall,
  sessionId: string,
  workspaceRoot: string,
  intent: ToolActionIntent,
): void {
  if (authority === undefined) return
  const paths = (intent.paths ?? [])
    .filter((path) => path.mode === 'write')
    .map((path) => normalizePath(resolve(workspaceRoot, path.path)))
  if (paths.length === 0) return
  authority.grant({ sessionId, callId: call.callId, paths })
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
