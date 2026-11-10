import type { Context } from '@lcode/context'
import type { ToolDefinition } from '@lcode/tools'

/**
 * `inject_worker`：Router 向已存在的 worker 追加一条输入（26 §5.5）。
 *
 * ## 为什么这是唯一需要新增的通道
 *
 * 派发是一次性的：worker 拿到任务就跑了，Router 之后没有任何办法影响它。
 * 但实际使用中三种情况都要用到同一条通道：
 *
 * | 场景 | 说什么 |
 * | --- | --- |
 * | 补充要求 | "顺便把 X 也改了" |
 * | 追问细节 | "你刚才说的 Y 具体改在哪一行？" |
 * | 回答求助 | worker 提问后，把答案传回去让它继续 |
 *
 * 三种都是"加一句话让它接着干"，所以是一个原语而不是三个工具。
 *
 * ## 为什么不做成"打断重来"
 *
 * worker 运行中时，这条输入进它的会话队列、成为下一个回合（不打断当前步）。
 * 已有的进度、读过的文件、试过的方向都保留——这正是重派一个新 worker 会丢掉的东西。
 */

export interface InjectWorkerInput {
  readonly taskId: string
  readonly text: string
  /** 为什么追加（落事件，供回放解释 worker 为何改道） */
  readonly reason?: string
}

export interface InjectWorkerResult {
  readonly state: 'injected' | 'rejected'
  readonly message: string
}

export function createInjectWorkerTool(ctx: Context): ToolDefinition<InjectWorkerInput, InjectWorkerResult> {
  return {
    name: 'inject_worker',
    description:
      '向一个已经派出去的 worker 追加一条输入。它正在跑就插进它的队列（不打断当前步骤），已经跑完就唤醒它接着原历史继续。用来补充要求、追问细节，或回答它的提问。',
    card: 'generic',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要追加输入的任务 id（派发时拿到的那个）' },
        text: { type: 'string', description: '要追加的内容（worker 会当作新的一条用户消息看到）' },
        reason: { type: 'string', description: '为什么要追加（落事件供回放）' },
      },
      required: ['taskId', 'text'],
    },
    async execute(call, opts) {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('inject_worker 缺少会话 scope')
      // 第二道防线：worker 不能反过来指挥别的 worker
      if (ctx.get('sessionRoles').roleOf(sessionId) === 'worker') {
        return { state: 'rejected', message: 'worker 不能向其他 worker 追加输入。' }
      }
      const orchestration = ctx.get('orchestration')
      const record = orchestration.status(call.parsed.taskId)
      if (record === undefined) {
        return { state: 'rejected', message: `找不到任务 ${call.parsed.taskId}。` }
      }
      // 只能操作自己派出去的 worker：跨 Router 注入会让审计归属说不清
      if (record.routerSessionId !== sessionId) {
        return { state: 'rejected', message: '只能向本会话派出的 worker 追加输入。' }
      }
      const ok = await orchestration.inject({
        taskId: call.parsed.taskId,
        text: call.parsed.text,
        ...(call.parsed.reason === undefined ? {} : { reason: call.parsed.reason }),
      })
      return ok
        ? { state: 'injected', message: '已追加。它会在当前步骤结束后接着处理这条。' }
        : { state: 'rejected', message: '这个 worker 已经不在了（会话已关闭），无法追加。' }
    },
  }
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const value = (scope as { readonly sessionId?: unknown }).sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}
