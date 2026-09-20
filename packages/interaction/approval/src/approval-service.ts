import type { ApprovalResult, SessionService } from '@lcode/session'
import { nowEpochMs } from '@lcode/util'
import type { ApprovalAskOpts, ApprovalChannel, ApprovalRequest, ApprovalService } from './approval.ts'

/**
 * 审批的实现（12 §5；批次⑥）。
 *
 * ## 两个事件一定都会落盘
 *
 * `ask()` 的**每一条出口**都要写 `approval/decided`：
 *
 * | 出口 | decidedBy | result |
 * |---|---|---|
 * | 用户点了允许 | `human` | `allowed-once` |
 * | 用户点了拒绝 | `human` | `rejected` |
 * | 请求被取消 | `cancelled` | `cancelled` |
 * | 没有应答者 / 超时 | `auto-denied` | `unavailable` |
 *
 * 漏写会让日志里留下**悬挂的 `approval/asked`**——重放时看到"问过但没人答"，
 * 与"其实答了、只是没记"分不清。批次⑥ 的崩溃恢复补记（22 §6.5）正是为了兜住
 * 真正崩溃那种情形；正常运行期不该产出悬挂。
 *
 * ## 为什么 `decidedBy` 要区分 `human` 与 `auto-denied`
 *
 * 事后复盘时，"用户拒绝了"与"根本没人被问到"是**完全不同**的两件事：
 * 前者说明策略命中了、用户有判断；后者说明界面上出了问题（通道没接上）。
 * 合并成一个字段会让这个区别永久丢失。
 */

export interface ApprovalServiceOptions {
  /** 应答通道。省略 = 永远没有应答者（一切走 `unavailable`，即 fail-closed） */
  readonly channel?: ApprovalChannel | undefined
  /** 取当前会话（用于落盘）。返回 undefined = 没有可落的日志（如子代理） */
  readonly getSession?: (() => SessionService | undefined) | undefined
  readonly now?: (() => number) | undefined
}

export function createApprovalService(options: ApprovalServiceOptions = {}): ApprovalService {
  const now = options.now ?? ((): number => nowEpochMs())
  /**
   * 正在等答案的 `callId` → 那次询问的 promise。
   *
   * **只做并发去重，不做结果缓存**（这个区别很重要）：缓存已答过的结果会跨轮次
   * 复用——第 5 轮恰好也叫 `call_1` 时，会直接沿用第 1 轮的答案，**不再问用户**。
   * 而 `callId` 由模型生成，跨轮重复是完全可能的。实测被这条绊过：
   * 假服务端每轮用同一个 id，于是第二次"允许"根本没生效。
   *
   * 并发去重解决的是真问题（调用方没等上一次就再来），而它不需要记住过去。
   */
  const inflight = new Map<string, Promise<ApprovalResult>>()

  return {
    async ask(request: ApprovalRequest, opts: ApprovalAskOpts = {}): Promise<ApprovalResult> {
      const running = inflight.get(request.callId)
      if (running !== undefined) return running

      const task = settle(request, opts)
      inflight.set(request.callId, task)
      try {
        return await task
      } finally {
        inflight.delete(request.callId)
      }
    },
  }

  /** 落 `approval/asked`、拿答案、落 `approval/decided`——三条出口共用这一条路 */
  async function settle(request: ApprovalRequest, opts: ApprovalAskOpts): Promise<ApprovalResult> {
    const session = opts.session ?? options.getSession?.()

    // ① **先落 `approval/asked`**：否则中止重启后看不到"当时问过什么"
    session?.append({
      type: 'approval/asked',
      data: {
        callId: request.callId,
        action: request.action,
        basis: request.basis,
        impact: request.impact,
        askedAt: now(),
      },
    })

    const { result, decidedBy } = await resolve(request, opts)

    // ② `approval/decided`：**无论哪条出口都写**
    session?.append({
      type: 'approval/decided',
      data: { callId: request.callId, result, decidedBy, decidedAt: now() },
    })
    return result
  }

  /** 把"取消 / 超时 / 无应答者"三种失败**都**收敛成明确结果，不抛错 */
  async function resolve(
    request: ApprovalRequest,
    opts: ApprovalAskOpts,
  ): Promise<{ result: ApprovalResult; decidedBy: 'human' | 'auto-denied' | 'cancelled' }> {
    // 已取消的请求：不必问，直接作废（12 §5.2 的"请求已取消"分支）
    if (opts.signal?.aborted === true) return { result: 'cancelled', decidedBy: 'cancelled' }

    // **没有通道 = 没有应答者 = fail-closed**（D11）。这不是错误，是一个正常结果：
    // 抛错会终结整轮，而正确行为是"拒绝这次动作、把结构化错误交给模型"。
    if (options.channel === undefined) return { result: 'unavailable', decidedBy: 'auto-denied' }

    const channel = options.channel
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined

    try {
      const raced = await Promise.race([
        channel.ask(request).then((answer) => ({ kind: 'answer' as const, answer })),
        new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
          // 不限时（21 §2.4：`approval.request` 无固定超时）。给用户设一个 30s 的钟
          // 会把"我正在读这段 diff"变成"被拒了"。
          if (opts.timeoutMs === undefined) return
          timer = setTimeout(() => resolveTimeout({ kind: 'timeout' }), opts.timeoutMs)
        }),
        new Promise<{ kind: 'aborted' }>((resolveAbort) => {
          if (opts.signal === undefined) return
          onAbort = (): void => resolveAbort({ kind: 'aborted' })
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])

      if (raced.kind === 'aborted') return { result: 'cancelled', decidedBy: 'cancelled' }
      // 超时 = 没人答 → fail-closed（D11：无应答者一律按拒绝）
      if (raced.kind === 'timeout') return { result: 'unavailable', decidedBy: 'auto-denied' }

      // 通道返回 undefined = 通道开着但对面没人，同样是"没有应答者"
      const answer = raced.answer
      if (answer === undefined) return { result: 'unavailable', decidedBy: 'auto-denied' }

      return { result: answer, decidedBy: answer === 'cancelled' ? 'cancelled' : 'human' }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}
