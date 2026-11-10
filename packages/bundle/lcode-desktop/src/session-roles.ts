import type { Context } from '@lcode/context'
import type { SessionService } from '@lcode/session'
import type { Disposer } from '@lcode/util'

/**
 * 会话角色（26 §3.3 / §4.4）。
 *
 * ## 为什么角色是"事件 + 派生"，不是会话表上的一个字段
 *
 * 角色会变（普通会话可以升格为 Router），而 `SessionHeader` 是 **不可变的文件头**。
 * 把 role 写进 header 会让"升格"变成改历史。这里改用 `session/role` 事件追加，
 * 当前有效角色由日志派生——与其余一切状态保持同一套 I1 语义。
 */

export type SessionRole = 'router' | 'worker' | 'normal'

/**
 * Router 会话**不能**持有的执行类工具（26 §3.2）。
 *
 * ⚠️ 这里只列**执行**能力。`dispatch_worker` / `delegate*` 是 Router 的正当工具，
 * 不能出现在这个集合里——否则 Router 会因为"没有执行工具"被误伤成"什么都干不了"，
 * 派发本身也一起被过滤掉（实测踩过：Router 拿不到 dispatch_worker）。
 */
const EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'terminal',
  'write',
  'edit',
  'run_code',
])

/**
 * 只有 Router 该看到的工具（26 §3.2 / §5.5）。
 *
 * 普通会话也一并排除：`dispatch_worker` 在普通会话里没有任何意义——没有
 * Router 身份就没有 worker 归属、没有汇报回路，派出去的任务会变成一个
 * 谁也管不到的孤儿会话。工具内部还有第二道防线，这里是第一道。
 */
const ROUTER_ONLY_TOOLS: ReadonlySet<string> = new Set(['dispatch_worker', 'list_workers', 'inject_worker'])

/** worker 不能持有的工具：派发与指挥类（否则变成三层结构，26 §7.5.2）。 */
const WORKER_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'dispatch_worker',
  'list_workers',
  'inject_worker',
])

/** 只有 worker 该看到的工具：向 Router 回传（26 §5.6）。 */
const WORKER_ONLY_TOOLS: ReadonlySet<string> = new Set(['report_to_router'])

export interface SessionRoleService {
  roleOf(sessionId: string): SessionRole
  /** 追加 `session/role` 事件并立即生效（不回改历史） */
  setRole(sessionId: string, role: SessionRole, reason?: string): void
}

export function registerSessionRoles(input: {
  readonly ctx: Context
  readonly getSession: (sessionId: string) => SessionService
}): { readonly service: SessionRoleService; readonly dispose: Disposer } {  const service: SessionRoleService = {
    roleOf(sessionId) {
      try {
        const events = input.getSession(sessionId).events()
        // 取**最后一条**角色事件：角色可变，历史不改。
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type === 'session/role') return event.data.role
        }
      } catch {
        // 会话不可用时按普通会话处理：不能因为查不到角色就放大成异常。
      }
      return 'normal'
    },
    setRole(sessionId, role, reason) {
      input.getSession(sessionId).append({
        type: 'session/role',
        data: { role, ...(reason === undefined ? {} : { reason }) },
      })
    },
  }

  /*
   * Router / worker 的工具可见性过滤。
   *
   * 复用 `systemPrompt.tools()` 的自定义过滤链（subagent 用它做收窄），
   * 不新增机制。**关键在 Router 一条**：它读所有消息、提示注入攻击面最大，
   * 必须没有执行能力——让它"没有工具可用"比让它"不要用工具"可靠得多。
   */
  const unregisterPrompt = input.ctx.get('systemPrompt').tools((all, promptCtx) => {
    const sessionId = promptCtx.sessionId
    if (sessionId === undefined) return all
    const role = service.roleOf(sessionId)
    if (role === 'router') {
      // Router：去掉执行能力与「只有 worker 该用」的工具，保留派发/巡检/注入
      return all.filter((tool) => !EXECUTION_TOOLS.has(tool.name) && !WORKER_ONLY_TOOLS.has(tool.name))
    }
    if (role === 'worker') {
      // worker 有完整执行工具，但不能派发或指挥别人：否则变成三层结构（26 §7.5.2）。
      return all.filter((tool) => !WORKER_FORBIDDEN_TOOLS.has(tool.name))
    }
    // 普通会话：既不是 Router 也不是 worker，两边专属的工具都不给
    return all.filter((tool) => !ROUTER_ONLY_TOOLS.has(tool.name) && !WORKER_ONLY_TOOLS.has(tool.name))
  })

  const unregisterService = input.ctx.set('sessionRoles', service)
  return {
    service,
    dispose: () => {
      unregisterPrompt()
      unregisterService()
    },
  }
}

/** 供门禁与测试复用的常量：Router 不得持有这些工具。 */
export const ROUTER_FORBIDDEN_TOOLS: readonly string[] = [...EXECUTION_TOOLS]

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    sessionRoles: SessionRoleService
  }
}

// 必须真实 import 一次，模块增强才能解析到 `@lcode/context` 的声明（同 orchestration 包）。
export type {} from '@lcode/context'
