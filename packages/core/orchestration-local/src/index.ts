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
  /** 边界与完成判据（26 §5.5），派发时一次性确定 */
  readonly scope?: string | undefined
  readonly doneWhen?: string | undefined
  readonly dispatchedAt: number
  readonly preview: boolean
  state: 'running' | 'settled'
  settled?: WorkerCompletion | undefined
  /** worker 提了问在等人（26 §5.6） */
  needsInput?: boolean | undefined
  question?: string | undefined
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

  /**
   * 读某个会话最近一条 `orchestration/mode` 事件（26 §7.4）。
   *
   * 读不到（会话未打开 / 还没切过档 / 事件格式不对）就返回 undefined，
   * 由调用方回落到全局兜底值——**绝不用异常表达"没有设置"**。
   */
  const sessionModeOf = (sessionId: string): OrchestrationMode | undefined => {
    try {
      const events = options.sessions.sessionServiceFor(sessionId).events()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'orchestration/mode') continue
        const data = event.data as { readonly mode?: unknown } | null
        const value = data?.mode
        return value === 'off' || value === 'observe' || value === 'auto' ? value : undefined
      }
    } catch {
      // 会话未打开：按全局兜底处理
    }
    return undefined
  }

  const modeFor = (sessionId: string): OrchestrationMode => sessionModeOf(sessionId) ?? mode

  const service: OrchestrationService = {
    mode: () => mode,

    modeFor,

    setMode(next, reason, sessionId) {
      /*
       * 传了会话就落该会话的事件（按会话生效）；没传就改全局兜底值。
       *
       * 档位变更本身必须落事件：`observe` 下"本来会派发什么"必须可回放（26 §7.4）。
       */
      if (sessionId === undefined) {
        mode = next
        return
      }
      try {
        options.sessions.sessionServiceFor(sessionId).append({
          type: 'orchestration/mode',
          data: { mode: next, ...(reason === undefined ? {} : { reason }) },
        })
      } catch {
        // 会话未打开：退回全局兜底，至少让档位不丢
        mode = next
      }
    },

    async dispatch(input: WorkerDispatchInput): Promise<WorkerDispatchReceipt> {
      const sessionMode = modeFor(input.routerSessionId)
      if (sessionMode === 'off') throw new Error('跨会话编排已关闭（off）：请先切换到 observe 或 auto。')
      const taskId = `task-${++nextTaskSeq}-${Date.now().toString(36)}`

      // worker 不能派发 worker：这是**硬约束**，不是配额（26 §7.5.2）。
      const role = options.roleOf(input.routerSessionId)
      if (role === 'worker') throw new Error('worker 不能派发 worker：跨会话编排最多两层。')

      if (sessionMode === 'observe') {
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

    taskIdOf(workerSessionId) {
      for (const record of workers.values()) {
        if (record.workerSessionId === workerSessionId) return record.taskId
      }
      return undefined
    },

    async inject(input) {
      const record = workers.get(input.taskId)
      if (record === undefined || disposed) return false
      // 预演记录没有实体会话，注入无处可去
      if (record.preview || record.workerSessionId === '') return false

      /*
       * 先在 Router 侧记一笔（26 §5.5）。
       *
       * 顺序有意：审计先于副作用。反过来的话，如果 resume 成功但记账失败，
       * Router 日志里就会出现"worker 莫名改道"的一段。
       */
      appendToRouter(options.sessions, record.routerSessionId, {
        type: 'worker/notified',
        data: {
          taskId: record.taskId,
          workerSessionId: record.workerSessionId,
          text: input.text,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      })

      try {
        /*
         * 用 `resume` 而不是复用 `record.handle`：
         * - worker 已 settled 时，原来的 handle 已经跑完，再 followup 不会重新驱动
         * - resume 是幂等的（同一 agent 只挂一个引擎），运行中也能安全调用
         */
        const loop = options.ctx.get('agentLoop') as AgentLoopRuntime
        const handle = await loop.resume({
          sessionId: asSessionId(record.workerSessionId),
          agentId: asAgentId(record.workerSessionId),
        })
        // 续跑意味着它重新"在做"，状态与遗留结论都要清掉
        record.state = 'running'
        record.settled = undefined
        record.needsInput = undefined
        record.question = undefined
        /*
         * 注入触发的那一轮也要收尾——否则 Router 收不到它的第二次汇报。
         *
         * 用后台 promise 而不是 await：`inject` 是工具调用，调用方不该被整轮
         * 执行阻塞（与 `dispatch` 同一条原则，26 §5.1）。promise 登记进
         * inflightRuns，dispose 时会等它，避免"关完还有写入"。
         */
        const run = (async () => {
          await handle.followup({ kind: 'text', text: input.text }).catch(() => undefined)
          settleFromSession(record, 'completed')
          await handle.dispose()
          record.handle = undefined
        })().finally(() => {
          inflightRuns.delete(run)
        })
        inflightRuns.add(run)
        return true
      } catch {
        // worker 会话已关闭：注入失败，但审计事件保留（事实就是尝试过）
        return false
      }
    },

    async report(input) {
      const taskId = service.taskIdOf(input.workerSessionId)
      if (taskId === undefined || disposed) return false
      const record = workers.get(taskId)
      if (record === undefined) return false

      appendToRouter(options.sessions, record.routerSessionId, {
        type: 'worker/reported',
        data: {
          taskId,
          workerSessionId: input.workerSessionId,
          kind: input.kind,
          summary: input.summary,
          ...(input.question === undefined ? {} : { question: input.question }),
          ...(input.needs === undefined ? {} : { needs: [...input.needs] }),
        },
      })

      if (input.kind === 'question') {
        /*
         * 求助**绕过批处理**（26 §5.6）。
         *
         * 批处理的存在是为了"别让密集完成刷屏"，而求助是等不起的：
         * 窗口里多等 200ms、冷却里多等 10s，worker 就白站着。
         */
        record.needsInput = true
        record.question = input.question ?? input.summary
        await flushReport(record.routerSessionId, [], {
          taskId,
          workerSessionId: input.workerSessionId,
          summary: input.summary,
          ...(input.question === undefined ? {} : { question: input.question }),
        })
      }
      // progress 只记录，不打扰；done 由 worker 收尾路径负责，这里不重复唤醒
      return true
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
    /*
     * 必须**同时**写 `session/role`（26 §4.4）。
     *
     * `parent_session` 只说明"谁派的"，说明不了"它是什么"——侧栏靠 `role === 'worker'`
     * 把 worker 从顶层列表里摘出去并缩进挂到 Router 下。只设 parent 不设 role 的话，
     * worker 会很普通地出现在顶层，同时又是某人的子会话（实测就是这样）。
     */
    appendWorkerRole(options.sessions, created.session_id)
    const record: WorkerRecord = {
      taskId,
      workerSessionId: created.session_id,
      routerSessionId: input.routerSessionId,
      task: input.task,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.doneWhen === undefined ? {} : { doneWhen: input.doneWhen }),
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
        await record.handle.followup({ kind: 'text', text: briefingText(record) })
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
      }
      settleFromSession(record, input.signal !== undefined && input.signal.aborted ? 'cancelled' : 'completed')
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

  /**
   * 从 worker 会话的日志收尾（26 §5.4）。
   *
   * 抽出来是因为**有两处会跑 worker 回合**：初次派发与后续 `inject`。
   * 只给初次派发收尾的话，注入触发的那一轮跑完不会写 `worker/completed`，
   * Router 永远等不到第二次汇报（实测：注入后 worker 明明跑完了，汇报没有）。
   */
  function settleFromSession(record: WorkerRecord, outcome: WorkerCompletion['outcome']): void {
    /*
     * 收尾读取 worker 自己的会话。它理论上总是打开着——但 dispose 期间可能
     * 已被 close，此时不该让整个收尾失败（那会把一次成功执行误报成 failed）。
     */
    const session = safeSession(options.sessions, record.workerSessionId)
    settle(record, {
      taskId: record.taskId,
      workerSessionId: record.workerSessionId,
      outcome,
      ...(session === undefined
        ? {}
        : { summary: lastAssistantText(session), artifacts: collectArtifacts(session) }),
    })
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
  /**
   * 把一批完成合并成**一条**汇报，唤醒 Router 一次。
   *
   * `question` 非空时走**求助**通道：不发批量汇报，改发一条带问号的即时消息
   * （26 §5.6）。求助等不起批处理窗口，也不该被合并成"顺手一提"。
   */
  async function flushReport(
    routerSessionId: string,
    completions: readonly WorkerCompletion[],
    question?: {
      readonly taskId: string
      readonly workerSessionId: string
      readonly summary: string
      readonly question?: string | undefined
    },
  ): Promise<void> {
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
      const text = question === undefined ? batchReportText(completions) : questionText(question)
      await handle.followup({ kind: 'text', text })
    } catch {
      // Router 已关闭或不接受输入：汇报丢失，事件仍在日志里可查。
    }
  }

  /**
   * 求助文案（26 §5.6）。
   *
   * 刻意与汇报分开写：汇报是"事情做完了"，求助是"事情卡住了"，
   * 两者对读者要求的动作完全不同——前者可以只看不回，后者必须回。
   */
  function questionText(input: {
    readonly taskId: string
    readonly workerSessionId: string
    readonly summary: string
    readonly question?: string | undefined
  }): string {
    return [
      `worker ${input.taskId} 需要你的决定｜会话 @session:${input.workerSessionId}`,
      input.question ?? input.summary,
      '（它在等这一条；回答后用 inject 传回去，或直接忽略并取消它）',
    ].join('\n')
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

/**
 * worker 收到的第一条消息（26 §5.5）。
 *
 * 为什么不是直接把 `task` 丢过去：worker 看不到 Router 的对话，它唯一能依据的
 * 就是这条消息。所以这里必须把**边界**和**完成判据**一并写进去——
 * 只说"要做什么"而不说"什么算做完"，完成标准就只能由 worker 自己定义。
 *
 * 没有 scope / doneWhen 时保持原样（单段文本），不让既有调用方看到格式变化。
 */
function briefingText(record: {
  readonly task: string
  readonly scope?: string | undefined
  readonly doneWhen?: string | undefined
}): string {
  if (record.scope === undefined && record.doneWhen === undefined) return record.task
  const lines = [record.task]
  if (record.scope !== undefined && record.scope.trim() !== '') {
    lines.push('', `**边界（不要做）**：${record.scope}`)
  }
  if (record.doneWhen !== undefined && record.doneWhen.trim() !== '') {
    lines.push('', `**完成判据**：${record.doneWhen}`)
  }
  return lines.join('\n')
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
    // 求助状态要跟着状态一起出去：Router 靠它判断"该不该主动问一句"
    ...(record.needsInput === true ? { needsInput: true } : {}),
    ...(record.question === undefined ? {} : { question: record.question }),
  }
}

/**
 * 给新 worker 会话写 `session/role`（docs/26 §4.4）。
 *
 * 直接追加事件而不是经 `sessionRoles` 服务：后者属于装配层，编排 provider 不该依赖它；
 * `session/role` 是核心事件契约，写进去就够了（角色由日志派生，可回放）。
 *
 * **为什么必须写**：`parent_session` 只说明"谁派的"，说明不了"它是什么"。
 * 侧栏靠 `role === 'worker'` 把 worker 从顶层摘出去并缩进挂到 Router 下；
 * 只设 parent 不设 role 的话，它会既出现在顶层、又是某人的子会话（实测就是这样）。
 */
function appendWorkerRole(sessions: RuntimeSessionsService, workerSessionId: string): void {
  try {
    sessions.sessionServiceFor(workerSessionId).append({
      type: 'session/role',
      data: { role: 'worker', reason: '由 Router 派发' },
    })
  } catch {
    // 会话刚建就写失败属于异常情况；worker 仍会跑，只是侧栏不会缩进它。
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
  event: {
    readonly type: 'worker/dispatched' | 'worker/completed' | 'worker/notified' | 'worker/reported'
    readonly data: unknown
  },
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
      // 边界与完成判据也落事件：回放时要能解释"worker 被要求做到什么程度"
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.doneWhen === undefined ? {} : { doneWhen: input.doneWhen }),
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

/**
 * 汇报里摘要的字数上限（docs/26 §5.4 的 Inline/Spill 纪律）。
 *
 * 官方把上下文当缓存：**Inline 只放短摘要 + 稳定 ID，其余 Spill 掉留指针**。
 * 不设上限时 `summary` 是 worker 最后一条 assistant 的全文，动辄几千字，
 * 会作为 user 消息永久留在 Router 历史里——派十个 worker 就把上下文填满了。
 */
const REPORT_SUMMARY_MAX = 500
/** 合并汇报时每条更短：一批三个 worker 的长摘要加起来同样会撑爆。 */
const REPORT_SUMMARY_MAX_BATCH = 200

/**
 * 单个 worker 的汇报文本。
 *
 * 两处刻意的设计：
 *
 * 1. **带上 `@session:<workerSessionId>`**。没有它，Router 只知道 `task-1-xxx`，
 *    而 `taskId` 不是会话标识——它无法 `@session:` 跳过去看 worker 的完整日志，
 *    Chain of Recall 就断了。`worker/completed` 事件里虽有 sessionId，但那个事件
 *    不是 surface 事件、不进模型可见历史，等于 Router 看不见。
 * 2. **摘要截断并显式说明**。不说明的话模型会以为摘要就这么多，进而基于残缺信息下判断。
 */
function reportText(completion: WorkerCompletion, maxSummary = REPORT_SUMMARY_MAX): string {
  const verb =
    completion.outcome === 'completed' ? '已完成' : completion.outcome === 'cancelled' ? '被取消' : '失败'
  const sessionRef = completion.workerSessionId === '' ? '' : `｜会话 @session:${completion.workerSessionId}`
  const lines = [`worker ${completion.taskId} ${verb}${sessionRef}`]

  const summary = completion.summary?.trim() ?? ''
  if (summary !== '') {
    if (summary.length <= maxSummary) lines.push(summary)
    else {
      lines.push(`${summary.slice(0, maxSummary).trimEnd()}…`)
      lines.push(`（摘要已截断，原长 ${summary.length} 字；完整内容见上面的会话）`)
    }
  }
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
  return [head, '', ...ordered.map((c) => `- ${reportText(c, REPORT_SUMMARY_MAX_BATCH).replaceAll('\n', ' ')}`)].join('\n')
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
