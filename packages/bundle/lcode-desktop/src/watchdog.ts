import type { Context } from '@lcode/context'
import type { RuntimeSessionsService } from '@lcode/session-api'
import type { Disposer } from '@lcode/util'

/**
 * Watchdog（docs/26 §8）。
 *
 * ## 一条不可商量的边界
 *
 * > **只通知，不派发、不接管、不自动重试。**
 *
 * 让它能派发 = 让一个定时任务能自主花钱。这里所有检查都只产出"通知事实"，
 * 由 UI 决定怎么呈现，由用户决定要不要处理。
 *
 * ## 为什么判据全部读日志
 *
 * 只有读日志才能保证"同样的日志得出同样的结论"（I1）。读进程内状态会让
 * 重启后的判断与重启前不一致，而 Watchdog 恰恰是长跑场景的可靠性装置。
 */

export type WatchdogFindingKind =
  /** 长时间 running 但没有新事件 */
  | 'stalled'
  /** 等待审批过久 */
  | 'awaiting-approval'
  /** 失败但用户可能没看到 */
  | 'silent-failure'
  /** 同一 Router 在途 worker 过多 */
  | 'worker-backlog'

export interface WatchdogFinding {
  readonly kind: WatchdogFindingKind
  readonly sessionId: string
  /** 人可读的一句话；文案由渲染层按 i18n 组织，这里只给事实 */
  readonly detail: string
  /** 相关 worker（worker-backlog 才有） */
  readonly taskIds?: readonly string[] | undefined
}

export interface WatchdogOptions {
  readonly ctx: Context
  readonly sessions: RuntimeSessionsService
  /** 巡检间隔；缺省 5 分钟。测试可传很小的值。 */
  readonly intervalMs?: number | undefined
  /** running 超过多久算卡死；缺省 10 分钟。 */
  readonly stallMs?: number | undefined
  /** 等待审批超过多久算等人超时；缺省 10 分钟。 */
  readonly approvalWaitMs?: number | undefined
  /** 在途 worker 超过多少算堆积；缺省取编排上限。 */
  readonly backlogThreshold?: number | undefined
  /** 需要巡检的会话；缺省从 sessions 列表取最近活跃的。 */
  readonly listSessions?: (() => Promise<readonly string[]>) | undefined
  /** 发现结果回调（UI / 日志）。**注意：这里不允许触发派发。** */
  readonly onFindings?: ((findings: readonly WatchdogFinding[]) => void) | undefined
}

export interface WatchdogService {
  /** 跑一次巡检并返回结论（测试与手动触发都用它） */
  scan(now?: number): Promise<readonly WatchdogFinding[]>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    watchdog: WatchdogService
  }
}

// 必须真实 import 一次，模块增强才能解析到 `@lcode/context` 的声明。
export type {} from '@lcode/context'

export interface WatchdogHandle {
  readonly service: WatchdogService
  readonly dispose: Disposer
}

export function registerLocalWatchdog(options: WatchdogOptions): WatchdogHandle {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000
  const stallMs = options.stallMs ?? 10 * 60 * 1000
  const approvalWaitMs = options.approvalWaitMs ?? 10 * 60 * 1000
  const backlogThreshold = options.backlogThreshold ?? 8

  const service: WatchdogService = {
    async scan(now = Date.now()) {
      const findings: WatchdogFinding[] = []
      const ids = options.listSessions === undefined ? [] : await options.listSessions()

      for (const sessionId of ids) {
        const session = safeSession(options.sessions, sessionId)
        if (session === undefined) continue
        const events = session.events()

        // ① 卡死：running 很久没有新事件
        const lastTurnStart = lastEventOfType(events, 'turn/start')
        const lastTurnEnd = lastEventOfType(events, 'turn/end')
        const running = lastTurnStart !== undefined && (lastTurnEnd === undefined || lastTurnEnd.seq < lastTurnStart.seq)
        if (running) {
          const idleFor = now - eventTime(events, events.length - 1)
          if (idleFor > stallMs) {
            findings.push({
              kind: 'stalled',
              sessionId,
              detail: `回合已运行 ${Math.round(idleFor / 60000)} 分钟没有新事件`,
            })
          }
          const lastAsked = lastEventOfType(events, 'approval/asked')
          const lastDecided = lastEventOfType(events, 'approval/decided')
          const awaiting = lastAsked !== undefined && (lastDecided === undefined || lastDecided.seq < lastAsked.seq)
          if (awaiting && now - eventTime(events, lastAsked.seq) > approvalWaitMs) {
            findings.push({
              kind: 'awaiting-approval',
              sessionId,
              detail: `审批等待已超过 ${Math.round(approvalWaitMs / 60000)} 分钟`,
            })
          }
        }

        // ③ 失败静默：最后一个 turn/end 是 error 且之后没有用户消息
        if (lastTurnEnd !== undefined && reasonOf(lastTurnEnd) === 'error') {
          const after = events.filter((event) => event.seq > lastTurnEnd.seq)
          const userSpokeSince = after.some((event) => event.type === 'user/message')
          if (!userSpokeSince) {
            findings.push({ kind: 'silent-failure', sessionId, detail: '上一轮失败后没有后续动作' })
          }
        }
      }

      // ④ worker 堆积：按 Router 统计在途数
      const orchestration = safeOrchestration(options.ctx)
      if (orchestration !== undefined) {
        const atLimit = ids
          .map((sessionId) => ({ sessionId, running: orchestration.running(sessionId) }))
          .filter((entry) => entry.running >= backlogThreshold)
        for (const entry of atLimit) {
          findings.push({
            kind: 'worker-backlog',
            sessionId: entry.sessionId,
            detail: `在途 worker 已达 ${entry.running} 个`,
          })
        }
      }

      options.onFindings?.(findings)
      return findings
    },
  }

  const timer = setInterval(() => {
    void service.scan().catch(() => {
      // 巡检失败不能影响主进程：下一轮再试。
    })
  }, intervalMs)
  // 不阻止进程退出
  if (typeof timer.unref === 'function') timer.unref()

  return {
    service,
    dispose: () => clearInterval(timer),
  }
}

function safeSession(
  sessions: RuntimeSessionsService,
  sessionId: string,
): { events(): readonly SessionEventLike[] } | undefined {
  try {
    return sessions.sessionServiceFor(sessionId)
  } catch {
    return undefined
  }
}

function safeOrchestration(ctx: Context): { running(routerSessionId?: string): number } | undefined {
  try {
    return ctx.get('orchestration')
  } catch {
    return undefined
  }
}

interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly time?: number | undefined
  readonly data: unknown
}

/** 取事件的 reason 字段（校验后才用）。 */
function reasonOf(event: SessionEventLike): string | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const reason = (data as { readonly reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

function lastEventOfType(events: readonly SessionEventLike[], type: string): SessionEventLike | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === type) return event
  }
  return undefined
}

function eventTime(events: readonly SessionEventLike[], seq: number): number {
  const found = events.find((event) => event.seq === seq)
  return found?.time ?? 0
}
