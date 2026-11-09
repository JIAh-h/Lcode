import type { Context } from '@lcode/context'
import type { AgentLoopRuntime } from '@lcode/agent-loop'
import type { RuntimeSessionsService } from '@lcode/session-api'
import { asAgentId, asSessionId } from '@lcode/util'
import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
} from '@lcode/orchestration'
import type {
  OrchestrationMode,
  OrchestrationService,
  WorkerCompletion,
  WorkerDispatchInput,
  WorkerDispatchReceipt,
  WorkerStatus,
} from '@lcode/orchestration'

/**
 * 汇报批处理窗口（docs/26 §5.3）。
 *
 * 200ms 足以覆盖「一批 worker 几乎同时收尾」，又不至于让人明显等；
 * 10s 的冷却上限是失败风暴时的保护——防止 Router 被连续唤醒打爆。
 */
const REPORT_WINDOW_MS = 200
const REPORT_COOLDOWN_MS = 10_000

/** 单个 worker 的运行期记录。 */
interface WorkerRecord {
  readonly taskId: string
  readonly workerSessionId: string
  readonly routerSessionId: string
  readonly task: string
  readonly dispatchedAt: number
  readonly preview: boolean
  state: 'running' | 'settled'
  settled?: WorkerCompletion | undefined
  handle?: Awaited<ReturnType<AgentLoopRuntime['create']>> | undefined
}

export interface OrchestrationProviderOptions {
  readonly ctx: Context
  readonly sessions: RuntimeSessionsService
  /** 默认上限；缺省 8（26 §7.5.2）。0 = 不限。 */
  readonly maxConcurrentWorkers?: number | undefined
  /** 初始授权档位；缺省 `observe`（26 §7.4）。 */
  readonly initialMode?: OrchestrationMode | undefined
  /** 堆水位阈值（0-1）；超过时新 worker 排队。缺省 0.85。 */
  readonly heapPressureThreshold?: number | undefined
  /** 本 provider 负责的会话角色判定（Router 才能派发） */
  readonly roleOf: (sessionId: string) => 'router' | 'worker' | 'normal'
}

/**
 * 跨会话编排 provider（26）。
 *
 * ## 与 subagent 的关键差异（不要合并实现）
 *
 * - **取消隔离**：Router 的 cancel 不传播到 worker（26 §6）。worker 只能被
 *   `cancel(taskId)` 显式停止。
 * - **不能嵌套**：worker 不允许再派发 worker（26 §7.5.2）。这里用会话角色
 *   判定拦截，`MAX_WORKER_DISPATCH_DEPTH` 是给门禁与文档的常量。
 * - **observe 档预演**：记录 `worker/dispatched`，但不建会话、不调模型（26 §7.4）。
 */
export function registerLocalOrchestration(
  options: OrchestrationProviderOptions,
): { readonly service: OrchestrationService; readonly dispose: () => Promise<void> } {
  const workers = new Map<string, WorkerRecord>()
  let mode: OrchestrationMode = options.initialMode ?? 'observe'
  let nextTaskSeq = 0
  /** 在途 worker 的运行 promise；dispose 时逐个等待，保证"关完就没有后续写入"。 */
  const inflightRuns = new Set<Promise<void>>()

  /** 汇报批处理的桶（按 Router 分会话）与冷却时间（docs/26 §5.3）。 */
  const reportBuckets = new Map<string, { pending: WorkerCompletion[]; timer: ReturnType<typeof setTimeout> | undefined }>()
  const lastReportAt = new Map<string, number>()

  /** dispose 后所有在途 worker 的收尾都不再写事件（会话可能已关闭）。 */
  let disposed = false
  const maxWorkers = options.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS
  const heapThreshold = options.heapPressureThreshold ?? 0.85

  /** 排队中的派发：超过上限或堆压力时暂存，轮到时再真正派发。 */
  const queue: { readonly input: WorkerDispatchInput; readonly resolve: (receipt: WorkerDispatchReceipt) => void }[] = []

  const runningCount = (routerSessionId?: string): number =>
    [...workers.values()].filter(
      (worker) => worker.state === 'running' && (routerSessionId === undefined || worker.routerSessionId === routerSessionId),
    ).length

  const heapUnderPressure = (): boolean => {
    const usage = process.memoryUsage()
    // heapUsed / heapTotal 只是当前堆内的占用比例；真正的压力看是否逼近上限，
    // 用 v8 的 heap_size_limit 更准（heapTotal 会随分配增长，比例恒在 0.7 附近）。
    const limit = typeof process.versions.v8 === 'string' ? v8HeapLimit() : 0
    if (limit <= 0) return false
    return usage.heapUsed / limit > heapThreshold
  }

  const service: OrchestrationService = {
    mode: () => mode,

    setMode(next, reason) {
      mode = next
      // 档位变更本身落事件：`observe` 下"本来会派发什么"必须可回放（26 §7.4）。
      // 这里没有会话上下文，由调用方（runtime/CLI）负责写进目标会话。
      void reason
    },

    async dispatch(input: WorkerDispatchInput): Promise<WorkerDispatchReceipt> {
      if (mode === 'off') throw new Error('跨会话编排已关闭（off）：请先切换到 observe 或 auto。')
      const taskId = `task-${++nextTaskSeq}-${Date.now().toString(36)}`

      // worker 不能派发 worker：这是**硬约束**，不是配额（26 §7.5.2）。
      const role = options.roleOf(input.routerSessionId)
      if (role === 'worker') throw new Error('worker 不能派发 worker：跨会话编排最多两层。')

      if (mode === 'observe') {
        // 预演：只落事件，不建会话、不调模型。workerSessionId 用空串表示"没有实体"。
        const record: WorkerRecord = {
          taskId,
          workerSessionId: '',
          routerSessionId: input.routerSessionId,
          task: input.task,
          dispatchedAt: Date.now(),
          preview: true,
          state: 'settled',
          settled: { taskId, workerSessionId: '', outcome: 'cancelled', summary: 'observe 档：仅记录，未执行。' },
        }
        workers.set(taskId, record)
        writeDispatched(options.sessions, input, taskId, '')
        return { taskId, workerSessionId: '', materialized: false }
      }

      // auto：真正的派发。超限或堆压力时排队（26 §7.5.2 / §7.5.3）。
      if ((maxWorkers > 0 && runningCount() >= maxWorkers) || heapUnderPressure()) {
        return await new Promise<WorkerDispatchReceipt>((resolve) => {
          queue.push({ input, resolve })
        })
      }

      return await materialize(input, taskId)
    },

    list(input) {
      return [...workers.values()]
        .filter((worker) => input?.routerSessionId === undefined || worker.routerSessionId === input.routerSessionId)
        .map(toStatus)
    },

    status(taskId) {
      const found = workers.get(taskId)
      return found === undefined ? undefined : toStatus(found)
    },

    async cancel(taskId) {
      const found = workers.get(taskId)
      if (found === undefined || found.state !== 'running' || found.handle === undefined) return false
      await found.handle.cancel('user')
      return true
    },

    running(routerSessionId) {
      return runningCount(routerSessionId)
    },
  }

  async function materialize(input: WorkerDispatchInput, taskId: string): Promise<WorkerDispatchReceipt> {
    if (disposed) {
      // dispose 后再派发：不建会话，直接回一个未落地的回执。
      return { taskId, workerSessionId: '', materialized: false }
    }
    const workspace = input.workspaceRoot ?? options.sessions.workspaceOf(input.routerSessionId)
    const created = await options.sessions.create({
      ...(workspace === undefined ? {} : { cwd: workspace }),
      title: `worker：${input.task.slice(0, 60)}`,
      // 归属标记（26 §4.2）：worker 的父是 Router，但生命周期独立于它。
      parentSessionId: input.routerSessionId,
    })
    const record: WorkerRecord = {
      taskId,
      workerSessionId: created.session_id,
      routerSessionId: input.routerSessionId,
      task: input.task,
      dispatchedAt: Date.now(),
      preview: false,
      state: 'running',
    }
    workers.set(taskId, record)
    writeDispatched(options.sessions, input, taskId, created.session_id)

    // 后台执行：Router 不等它（26 §5.1）。
    const run = runWorker(record, input)
      .catch((error: unknown) => {
        /*
         * runWorker 内部已收尾，但**收尾写事件**本身可能抛（Router 被 dispose 后
         * `append` 会报 ES-SESSION_NOT_FOUND）。没有这一行，这条 promise 就是无人
         * 等待的孤儿，会变成进程级 unhandled rejection——测试里表现为"用例全绿但
         * 报 Errors 1"，生产里会静默污染日志。
         */
        if (record.state === 'running') {
          record.state = 'settled'
          record.settled = {
            taskId: record.taskId,
            workerSessionId: record.workerSessionId,
            outcome: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })
      .finally(() => {
        inflightRuns.delete(run)
      })
    inflightRuns.add(run)
    return { taskId, workerSessionId: created.session_id, materialized: true }
  }

  async function runWorker(record: WorkerRecord, input: WorkerDispatchInput): Promise<void> {
    try {
      if (input.signal?.aborted === true) {
        settle(record, { taskId: record.taskId, workerSessionId: record.workerSessionId, outcome: 'cancelled', error: '派发前已取消。' })
        return
      }
      const loop = options.ctx.get('agentLoop') as AgentLoopRuntime
      record.handle = await options.ctx.get('agents').withInitiator(
        { sessionId: asSessionId(record.routerSessionId), agentId: asAgentId(record.routerSessionId) },
        async () => await loop.create({ sessionId: asSessionId(record.workerSessionId), name: `worker:${record.taskId}` }),
      )
      const onAbort = (): void => {
        void record.handle?.cancel('user').catch(() => {})
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await record.handle.followup({ kind: 'text', text: record.task })
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
      }
      /*
       * 收尾读取 worker 自己的会话。它理论上总是打开着——但 dispose 期间可能
       * 已被 close，此时不该让整个收尾失败（那会把一次成功执行误报成 failed）。
       */
      const session = safeSession(options.sessions, record.workerSessionId)
      settle(record, {
        taskId: record.taskId,
        workerSessionId: record.workerSessionId,
        outcome: input.signal !== undefined && input.signal.aborted ? 'cancelled' : 'completed',
        ...(session === undefined
          ? {}
          : { summary: lastAssistantText(session), artifacts: collectArtifacts(session) }),
      })
    } catch (error) {
      settle(record, {
        taskId: record.taskId,
        workerSessionId: record.workerSessionId,
        outcome: input.signal !== undefined && input.signal.aborted ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await record.handle?.dispose()
      record.handle = undefined
      pumpQueue()
    }
  }

  function settle(record: WorkerRecord, completion: WorkerCompletion): void {
    record.state = 'settled'
    record.settled = completion
    // 已 dispose 时不再写事件：会话可能已关闭，写进去只会变成 unhandled rejection。
    if (disposed) return
    writeCompleted(options.sessions, record.routerSessionId, completion)
    enqueueReport(record.routerSessionId, completion)
  }

  /**
   * 批处理窗口（docs/26 §5.3）。
   *
   * ## 为什么必须合并
   *
   * 每个 worker 完成都唤醒一次 Router，在并行度高的场景里会连续触发 N 轮模型调用：
   * 用户看到刷屏，账单也会难看。原文的批处理把单次决策从 6.4s 降到 1.6s，
   * 思路就是**把密集到达的事件攒成一次判断**。
   *
   * ## 两条边界
   *
   * - **窗口 200ms**：足以覆盖「一批 worker 几乎同时收尾」的情况，又不至于让人等。
   * - **每 Router 10s 内最多唤醒 1 次**：失败风暴时防止把 Router 打爆。
   *
   * 只有**需要开口**的完成才进桶（`shouldReport`）。无产出的 worker 连事件都不进桶，
   * 避免它们把窗口一直撑开。
   */
  function enqueueReport(routerSessionId: string, completion: WorkerCompletion): void {
    if (!shouldReport(completion)) return
    const bucket = reportBuckets.get(routerSessionId) ?? { pending: [], timer: undefined }
    bucket.pending.push(completion)
    if (bucket.timer !== undefined) return

    // 距离上次唤醒不足冷却时间就顺延，避免连续轰炸
    const now = Date.now()
    const last = lastReportAt.get(routerSessionId) ?? 0
    const cooldownLeft = Math.max(0, REPORT_COOLDOWN_MS - (now - last))
    const waitMs = Math.max(REPORT_WINDOW_MS, cooldownLeft)

    bucket.timer = setTimeout(() => {
      bucket.timer = undefined
      const ready = bucket.pending.splice(0)
      reportBuckets.delete(routerSessionId)
      if (ready.length === 0) return
      lastReportAt.set(routerSessionId, Date.now())
      void flushReport(routerSessionId, ready)
    }, waitMs)
    if (typeof bucket.timer.unref === 'function') bucket.timer.unref()
    reportBuckets.set(routerSessionId, bucket)
  }

  /** 把一批完成合并成**一条**汇报，唤醒 Router 一次。 */
  async function flushReport(routerSessionId: string, completions: readonly WorkerCompletion[]): Promise<void> {
    try {
      /*
       * 唤醒 Router：`agentLoop.resume` 是幂等的（同一 agent 只挂一个引擎），
       * 所以不需要先查"有没有活跃引擎"——有就复用，没有就建。
       */
      const loop = options.ctx.get('agentLoop') as AgentLoopRuntime
      const handle = await loop.resume({
        sessionId: asSessionId(routerSessionId),
        agentId: asAgentId(routerSessionId),
      })
      await handle.followup({ kind: 'text', text: batchReportText(completions) })
    } catch {
      // Router 已关闭或不接受输入：汇报丢失，事件仍在日志里可查。
    }
  }

  /**
   * 汇报策略（docs/26 §5.4）。
   *
   * 用户已明确要求 worker 完成后 Router 自动汇报。但"自动"不等于"每次都说话"：
   *
   * | 情形 | 行为 |
   * | --- | --- |
   * | 有实质产出 | 主动汇报 |
   * | 完成但无产出 | 记录事件，不主动开口 |
   * | 失败 / 取消 | 必须开口（失败不能静默） |
   *
   * 分界是"用户是否需要据此做决定"。多个 worker 由 §5.3 的批处理窗口合并成一条。
   */


  /** 队列排空：上限或堆压力解除后按 FIFO 继续。 */
  function pumpQueue(): void {
    while (queue.length > 0) {
      // dispose 之后不再启动任何排队项：此时会话可能已关闭，启动出来的 worker
      // 收尾时会向不存在的会话写事件（unhandled rejection 的另一个来源）。
      if (disposed) return
      if (maxWorkers > 0 && runningCount() >= maxWorkers) return
      if (heapUnderPressure()) return
      const next = queue.shift()
      if (next === undefined) return
      const taskId = `task-${++nextTaskSeq}-${Date.now().toString(36)}`
      void materialize(next.input, taskId).then(next.resolve, () => {
        next.resolve({ taskId, workerSessionId: '', materialized: false })
      })
    }
  }

  const unregister = options.ctx.set('orchestration', service)
  return {
    service,
    /**
     * ⚠️ 返回的是 Promise：必须**等**在途 worker 的 agent 停下再放行。
     *
     * 只做同步清理（取消 + 清表）是不够的——`cancel` 只是发信号，worker 的
     * followup 还要几个 tick 才收尾。调用方紧接着关闭会话或删目录时，那次收尾
     * 就会向不存在的会话写事件，变成进程级 unhandled rejection。
     * 这里显式等待，把"dispose 之后不会再有任何写入"变成可依赖的保证。
     */
    async dispose(): Promise<void> {
      disposed = true
      queue.splice(0)
      // 清掉待发的批次：否则定时器会在 dispose 之后触发一次汇报，撞上已关闭的会话。
      for (const bucket of reportBuckets.values()) {
        if (bucket.timer !== undefined) clearTimeout(bucket.timer)
      }
      reportBuckets.clear()
      lastReportAt.clear()
      // 先发取消信号，让在途 worker 尽快收尾
      for (const record of workers.values()) {
        await record.handle?.cancel?.('user').catch(() => {})
      }
      // 再等所有在途运行结束——**这是"dispose 之后不再有写入"的唯一保证**。
      // 只发信号不等待，调用方紧接着关会话/删目录时，收尾写事件仍会撞上
      // ES-SESSION_NOT_FOUND 变成 unhandled rejection（实测踩过多次）。
      await Promise.allSettled([...inflightRuns])
      for (const record of workers.values()) {
        await record.handle?.dispose().catch(() => {})
        record.handle = undefined
      }
      workers.clear()
      inflightRuns.clear()
      unregister()
    },
  }
}

function v8HeapLimit(): number {
  try {
    // 通过 require('v8') 在 ESM 下不可用，改用 performance 无关的 process 常量。
    // Node 暴露的是 process.constrainedMemory()（有则更准），退化到 0 表示不做压力判断。
    const constrained = (process as unknown as { constrainedMemory?: () => number }).constrainedMemory
    if (typeof constrained === 'function') return constrained()
  } catch {
    // 忽略：没有可用信息来源时不做堆压力判断，不阻塞派发。
  }
  return 0
}

function toStatus(record: WorkerRecord): WorkerStatus {
  return {
    taskId: record.taskId,
    workerSessionId: record.workerSessionId,
    routerSessionId: record.routerSessionId,
    task: record.task,
    state: record.state,
    dispatchedAt: record.dispatchedAt,
    ...(record.settled === undefined
      ? {}
      : { completedAt: Date.now(), outcome: record.settled.outcome }),
    ...(record.preview ? { preview: true } : {}),
  }
}

/**
 * 写 Router 会话的安全封装。
 *
 * `sessionServiceFor` 对已关闭的会话会抛 ES-SESSION_NOT_FOUND。worker 的生命周期
 * 独立于 Router，完全可能活得更久——它收尾时 Router 已经被关掉是正常情况，
 * 不是异常。这里吞掉该错误：审计事实丢一条，比让整个进程吃一个 unhandled
 * rejection 要好得多。
 */
function appendToRouter(
  sessions: RuntimeSessionsService,
  routerSessionId: string,
  event: { readonly type: 'worker/dispatched' | 'worker/completed'; readonly data: unknown },
): void {
  try {
    sessions.sessionServiceFor(routerSessionId).append(event as never)
  } catch {
    // Router 已关闭：worker 自己的独立日志仍然完整。
  }
}

function writeDispatched(
  sessions: RuntimeSessionsService,
  input: WorkerDispatchInput,
  taskId: string,
  workerSessionId: string,
): void {
  appendToRouter(sessions, input.routerSessionId, {
    type: 'worker/dispatched',
    data: {
      taskId,
      workerSessionId,
      task: input.task,
      routerSessionId: input.routerSessionId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      dispatchedAt: Date.now(),
    },
  })
}

function writeCompleted(sessions: RuntimeSessionsService, routerSessionId: string, completion: WorkerCompletion): void {
  appendToRouter(sessions, routerSessionId, {
    type: 'worker/completed',
    data: {
      taskId: completion.taskId,
      workerSessionId: completion.workerSessionId,
      outcome: completion.outcome,
      ...(completion.summary === undefined ? {} : { summary: completion.summary }),
      ...(completion.artifacts === undefined ? {} : { artifacts: completion.artifacts }),
      ...(completion.error === undefined ? {} : { error: completion.error }),
    },
  })
}

/** 取会话；已关闭时返回 undefined 而不是抛错。 */
function safeSession(
  sessions: RuntimeSessionsService,
  sessionId: string,
): { deriveMessages(): readonly unknown[]; events(): readonly unknown[] } | undefined {
  try {
    return sessions.sessionServiceFor(sessionId)
  } catch {
    return undefined
  }
}

/**
 * 是否应该向用户开口（docs/26 §5.4）。
 *
 * 分界：**用户是否需要据此做决定**。失败与取消需要（要不要重试/换方案），
 * 无事发生不需要——每次都说"我查了没什么问题"就是打扰。
 */
function shouldReport(completion: WorkerCompletion): boolean {
  if (completion.outcome !== 'completed') return true
  // 有产出：改了文件、调过工具、或给了结论
  if (completion.summary !== undefined && completion.summary.trim() !== '') return true
  if ((completion.artifacts?.changedPaths.length ?? 0) > 0) return true
  if ((completion.artifacts?.toolCalls ?? 0) > 0) return true
  return false
}

/** 单个 worker 的一行摘要：模型可读、简洁、带 taskId 便于追问。 */
function reportText(completion: WorkerCompletion): string {
  const head =
    completion.outcome === 'completed'
      ? `worker ${completion.taskId} 已完成`
      : completion.outcome === 'cancelled'
        ? `worker ${completion.taskId} 被取消`
        : `worker ${completion.taskId} 失败`
  const lines = [head]
  if (completion.summary !== undefined && completion.summary !== '') lines.push(completion.summary)
  if (completion.error !== undefined) lines.push(`错误：${completion.error}`)
  const paths = completion.artifacts?.changedPaths ?? []
  if (paths.length > 0) lines.push(`改动文件：${paths.join('、')}`)
  return lines.join('\n')
}

/**
 * 一批完成的合并汇报（docs/26 §5.3）。
 *
 * 只有一个时报文与单条一致（不让用户察觉批处理的存在）；多个时列成清单，
 * 且**失败排在最前**——失败是最需要人做决定的部分。
 */
function batchReportText(completions: readonly WorkerCompletion[]): string {
  if (completions.length === 1) {
    const only = completions[0]
    return only === undefined ? '' : reportText(only)
  }
  const ordered = [...completions].sort((a, b) => rankOf(a.outcome) - rankOf(b.outcome))
  const failed = ordered.filter((c) => c.outcome !== 'completed').length
  const head =
    failed === 0
      ? `${ordered.length} 个 worker 已完成`
      : `${ordered.length} 个 worker 已结束（${failed} 个未成功）`
  return [head, '', ...ordered.map((c) => `- ${reportText(c).replaceAll('\n', ' ')}`)].join('\n')
}

/** 汇报排序：失败最先，取消次之，成功最后。 */
function rankOf(outcome: WorkerCompletion['outcome']): number {
  return outcome === 'failed' ? 0 : outcome === 'cancelled' ? 1 : 2
}

function lastAssistantText(session: { deriveMessages(): readonly unknown[] }): string {
  const messages = session.deriveMessages() as readonly { readonly role?: string; readonly content?: unknown }[]
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  if (last === undefined) return ''
  if (typeof last.content === 'string') return last.content
  if (!Array.isArray(last.content)) return ''
  return last.content
    .filter(
      (block): block is { readonly type: 'text'; readonly text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

function collectArtifacts(session: { events(): readonly unknown[] }) {
  const events = session.events() as readonly Record<string, unknown>[]
  const changed: string[] = []
  let toolCalls = 0
  let failedToolCalls = 0
  let input: number | undefined
  let output: number | undefined

  for (const event of events) {
    const type = event['type']
    const data = (event['data'] ?? {}) as Record<string, unknown>
    if (type === 'tool/call') {
      toolCalls += 1
      const name = data['name']
      if (name !== 'write' && name !== 'edit') continue
      const path = parsedPath(data['arguments'])
      if (path !== undefined && !changed.includes(path)) changed.push(path)
      continue
    }
    if (type === 'tool/result') {
      const message = data['message'] as Record<string, unknown> | undefined
      if (data['error'] !== undefined || message?.['isError'] === true) failedToolCalls += 1
      continue
    }
    if (type === 'assistant/message') {
      const usage = data['usage'] as Record<string, unknown> | undefined
      if (usage === undefined) continue
      if (typeof usage['input'] === 'number') input = (input ?? 0) + usage['input']
      if (typeof usage['output'] === 'number') output = (output ?? 0) + usage['output']
    }
  }

  return {
    changedPaths: changed,
    toolCalls,
    failedToolCalls,
    ...(input === undefined && output === undefined
      ? {}
      : { usage: { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) } }),
    events: events.length,
  }
}

function parsedPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const path = parsed['path']
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}
