import type { Context } from '@lcode/context'
import type { SessionService } from '@lcode/session'
import type { ToolCall } from '@lcode/tools'
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
 * Router 的**工具白名单**（26 §3.3）。
 *
 * ## 为什么是白名单而不是黑名单
 *
 * 曾经用黑名单（只排除 `EXECUTION_TOOLS`），结果是 `read` / `glob` / `grep` 全留着。
 * 于是 Router 完全可以自己 grep 整个仓库、读完文档、把任务做完——**一次都没派发**。
 * 真机证据：一个勾选了「作为编排调度会话」的会话，`tool/call` 是
 * `grep×5, read×4, glob×1`，而 `worker/dispatched` 是 **0**。
 *
 * 黑名单的根本问题是：每新增一个工具都要记得同步排除，漏一次"Router 不执行"这条
 * 设计就静默失效。白名单反过来——新工具默认不给 Router，要开就得显式加。
 *
 * ## 白名单里为什么是这几个
 *
 * | 工具 | 理由 |
 * | --- | --- |
 * | `dispatch_worker` / `inject_worker` / `list_workers` | 编排本职 |
 * | `todo_write` | 规划，不碰仓库 |
 * | `skill_list` / `skill_load` | 读技能说明（提示词性质的资料），不是仓库内容 |
 *
 * 刻意**不含**：`read` / `glob` / `grep` / `lsp` / 网络类——它们都是"执行任务"
 * 而不是"调度任务"。Router 要看细节就派 worker（或 `inject` 追问已在跑的 worker）。
 */
const ROUTER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'dispatch_worker',
  'inject_worker',
  'list_workers',
  'todo_write',
  'skill_list',
  'skill_load',
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

/** 从执行 scope 里取会话 id（引擎在 `tools/pre-execute` 上传下来的身份）。 */
function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
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
   * **执行期**角色闸门（26 §3.3）。
   *
   * 上面的 `systemPrompt.tools()` 只决定"**告诉模型**有哪些工具"，属于提示层；
   * 工具执行走的是注册表按名字全量解析。真实事故：请求头里的 Router 工具表
   * 只有 6 个白名单工具，模型仍然调用了 `shell` 36 次、`read` 1 次，而系统
   * **照常执行**了——因为没有任何一层在执行路径上校验角色。
   *
   * 复用已有的 `tools/pre-execute` 缝隙（策略/审批也走这里），设 `deny` 即可。
   *
   * ⚠️ 必须 `return next()`：这是 **waterfall**，不委托的话链在这里就断了，
   * 后面的策略钩子（审批 + 沙箱档位）根本不会跑——表现是"工具莫名其妙被拒"。
   * 这个坑有测试挡着（计划模式与终端审批两条用例）。
   */
  const executionGuard = (
    payload: { call: ToolCall; scope?: unknown; deny?: string },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const sessionId = sessionIdOf(payload.scope)
    if (sessionId === undefined) return next()
    const role = service.roleOf(sessionId)
    const name = payload.call.name
    if (role === 'router' && !ROUTER_ALLOWED_TOOLS.has(name)) {
      payload.deny =
        `Router 不执行任务：${name} 不在编排会话的白名单里。` +
        `要读代码、跑命令或改文件，请用 dispatch_worker 派给 worker；` +
        `要追问已在跑的 worker，用 inject_worker。`
      return next()
    }
    if (role === 'worker' && WORKER_FORBIDDEN_TOOLS.has(name)) {
      payload.deny = `worker 不能使用 ${name}：跨会话编排最多两层（26 §7.5.2）。`
      return next()
    }
    if (role === 'normal' && (ROUTER_ONLY_TOOLS.has(name) || WORKER_ONLY_TOOLS.has(name))) {
      payload.deny = `${name} 只能在对应的会话角色里使用。`
    }
    return next()
  }
  const unregisterExecutionGuard = input.ctx.on('tools/pre-execute', executionGuard as never)

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
      /*
       * Router：**只给白名单**（26 §3.3）。
       *
       * 不是"去掉执行类"而是"只留编排类"——见上面 ROUTER_ALLOWED_TOOLS 的说明：
       * 黑名单会让 read/grep/glob 漏进 Router，于是它自己把活干完、一次都不派发。
       */
      return all.filter((tool) => ROUTER_ALLOWED_TOOLS.has(tool.name))
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
      unregisterExecutionGuard()
      unregisterPrompt()
      unregisterService()
    },
  }
}

/**
 * 供门禁与测试复用的常量：Router **不得**持有的工具。
 *
 * 以前这里只有执行类；现在补上"只读调研"类——它们同样属于"执行任务"。
 * 真实事故：Router 留着 read/glob/grep，自己把整个仓库查完写答案，一次都没派发。
 */
export const ROUTER_FORBIDDEN_TOOLS: readonly string[] = [
  ...EXECUTION_TOOLS,
  'read',
  'glob',
  'grep',
  'lsp',
  'delegate',
  'delegate_async',
  'delegate_wait',
  'report_to_router',
]

/** Router 允许持有的工具（白名单，用于测试与文档） */
export const ROUTER_TOOLS: readonly string[] = [...ROUTER_ALLOWED_TOOLS]

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    sessionRoles: SessionRoleService
  }
}

// 必须真实 import 一次，模块增强才能解析到 `@lcode/context` 的声明（同 orchestration 包）。
export type {} from '@lcode/context'
