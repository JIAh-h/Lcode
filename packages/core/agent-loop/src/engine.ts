import type {
  AgentHandle,
  AgentStatus,
  CancelReason,
  InjectedContext,
  UserInput,
} from "@lcode/agent";
import type { Context } from "@lcode/context";
import type { LlmAdapter, PreparedCall } from "@lcode/llm";
import type { ModelSelection } from "@lcode/agent-default-model";
import type { SessionService } from "@lcode/session";
import type {
  AssistantMessage,
  ContentBlock,
  SessionEvent,
  TokenUsage,
  TurnEndReason,
} from "@lcode/session";
import type { ToolCall, ToolRegistry, ToolResult } from "@lcode/tools";
import { ERROR_CODES, LcodeErrorImpl, freezeLossless } from "@lcode/util";
import {
  buildRequestBody,
  fingerprintOf,
  headerReason,
  snapshotTools,
  toolsFingerprintOf,
  withBody,
} from "./request.ts";

/**
 * 循环引擎 —— 全仓库唯一的具体循环的运行时（文档 20 §5.6、23 §14 批次③）。
 *
 * ## 不变量落点
 * - **I1**：每次请求的 `system` / `messages` 一律在请求构建那一刻从会话日志派生
 *   （`systemPrompt.assemble` + `session.deriveMessages()`），从不从内存数组拼装；
 *   最终请求体见 `request.ts` 的 `buildRequestBody`。
 * - **L3**：除"取消"外不吞任何异常——错误变成 `turn/end(error)` 并向发起方再抛。
 * - **I6**：本文件不出现针对具体能力的分支。压缩 / 上下文注入 / 策略替换全部走
 *   事件协作点（`agent/pre-step`、`agent/request`、`tools/pre-execute`），
 *   能力包订阅事件即可介入，循环本身不知道它们存在。
 *
 * ## 协作点（全部通过事件，不通过 if）
 * | 时机 | 机制 |
 * |---|---|
 * | 构建请求前 | `ctx.emit('agent/pre-step')` |
 * | 请求配置可用 | `ctx.waterfall('agent/request')`——处理器**原地替换 `args.call`** 后 `next()` |
 * | 请求发出前 | `request/header` 落盘（可重放审计点） |
 * | 流式片段到达 | `assistant/chunk` 落盘（session.onEvent 订阅者即 UI） |
 * | 工具调用前后 | 注册表的 `tools/pre-execute` / `tools/post-execute` |
 * | 轮结束 | `turn/end` |
 */

/** 一次请求的捕获记录（I1 测试的数据源） */
export interface CapturedRequest {
  readonly atSeq: number;
  readonly system: string;
  readonly messages: readonly unknown[];
}

export interface AgentLoopDeps {
  readonly ctx: Context;
  /** 会话查找（装配层提供；与 InMemoryAgentStore 同一约定） */
  readonly getSession: (sessionId: string) => SessionService;
}

/** 排队项：输入 + 完成通知（followup 的 Promise 在对应轮终态时落定） */
interface QueueItem {
  readonly id: string;
  input: UserInput;
  readonly settle: (err?: unknown) => void;
  /** 本轮 user/message 的 seq（轮开跑时由 runTurn 回填；排队中为 undefined） */
  userSeq?: number;
  /** 已暂停任务的续跑：保留原始用户消息，只创建一个新的执行回合。 */
  continuation?: boolean;
  settled?: boolean;
}

/** 入队回执（agents-api 据此补全为 docs/21 §2.0 的 EnqueueReceipt） */
export interface EnqueueResult {
  readonly accepted: true;
  /** 仅在本进程存活期间有效，用于编辑/移除尚未开始的消息。 */
  readonly queueId: string;
  /** 轮已同步开跑 = 本轮 user/message 的 seq；仍在排队 = 当前日志长度（单调标记） */
  readonly seq: number;
}

export interface QueuedInput {
  readonly queueId: string;
  readonly input: UserInput;
}

/** 循环驱动的句柄：AgentHandle 行为 + 同步入队（agents.* API 的 followup 用） */
export type LoopHandle = AgentHandle & {
  readonly enqueue: (input: UserInput) => EnqueueResult;
  readonly resumeTurn: () => Promise<boolean>;
  /** 不含当前执行回合的待发送消息。 */
  readonly queued: () => readonly QueuedInput[];
  editQueued(queueId: string, input: UserInput): boolean;
  removeQueued(queueId: string): boolean;
  clearQueued(): number;
  /** 原子地把一条待发送消息转为当前回合的引导。 */
  guideQueued(queueId: string): boolean;
};

export class TurnEngine {
  private readonly queue: QueueItem[] = [];
  private nextQueueId = 0;
  private readonly steerQueue: UserInput[] = [];
  private readonly injectQueue: InjectedContext[] = [];
  private drainRunning = false;
  private disposed = false;
  private pauseAfterCurrent = false;
  private controller: AbortController | null = null;
  /** 当前在跑的轮的收尾通知 */
  private inflight: Promise<TurnEndReason> | null = null;
  private cancellation: Promise<void> | null = null;
  private readonly idleWaiters: Array<() => void> = [];
  /** 最近一个被用户暂停、尚未被续跑的回合。 */
  private suspended: QueueItem | null = null;
  private _status: AgentStatus = "idle";

  constructor(
    private readonly deps: AgentLoopDeps,
    readonly inner: AgentHandle,
  ) {}

  get status(): AgentStatus {
    return this._status;
  }

  /** 循环驱动的 AgentHandle（身份来自注册表，行为来自本引擎） */
  get handle(): LoopHandle {
    const engine = this;
    return {
      id: this.inner.id,
      sessionId: this.inner.sessionId,
      get status(): AgentStatus {
        return engine.status;
      },
      followup: (input: UserInput) => engine.followup(input),
      steer: (input: UserInput) => engine.steer(input),
      inject: (input: InjectedContext) => engine.inject(input),
      cancel: (reason: CancelReason) => engine.cancel(reason),
      dispose: () => engine.dispose(),
      enqueue: (input: UserInput) => engine.enqueue(input),
      resumeTurn: () => engine.resumeTurn(),
      queued: () => engine.queued(),
      editQueued: (queueId, input) => engine.editQueued(queueId, input),
      removeQueued: (queueId) => engine.removeQueued(queueId),
      clearQueued: () => engine.clearQueued(),
      guideQueued: (queueId) => engine.guideQueued(queueId),
    };
  }

  // ─────────── AgentHandle 行为 ───────────

  /** 追加一轮；返回的 Promise 在**这一轮终态**时落定（调用方可自由不等待） */
  async followup(input: UserInput): Promise<void> {
    this.assertInteractive();
    return new Promise<void>((resolve, reject) => {
      this.pushQueue(input, (err) =>
        err === undefined ? resolve() : reject(err),
      );
    });
  }

  /**
   * 同步入队（不等待轮终态）。agents.followup 的底层：
   * 若 agent 空闲，轮会在本次调用内同步开跑——user/message 立即落盘，
   * 回执 seq 就是它的 seq；若在忙，seq 是当前日志长度（单调标记，
   * 配合 watch 的「idle 且 seq ≥ 回执 seq」判据使用）。
   */
  enqueue(input: UserInput): EnqueueResult {
    this.assertInteractive();
    const item = this.pushQueue(input, () => {});
    const session = this.deps.getSession(this.inner.sessionId);
    return {
      accepted: true,
      queueId: item.id,
      ...(item.userSeq !== undefined
        ? { seq: item.userSeq }
        : { seq: session.length }),
    };
  }

  private pushQueue(
    input: UserInput,
    settle: (err?: unknown) => void,
  ): QueueItem {
    const item: QueueItem = { id: `q-${++this.nextQueueId}`, input, settle };
    this.queue.push(item);
    if (!this.drainRunning) {
      void this.drain();
    }
    return item;
  }

  queued(): readonly QueuedInput[] {
    const start = this.drainRunning ? 1 : 0;
    return this.queue.slice(start).map(({ id, input }) => ({ queueId: id, input }));
  }

  editQueued(queueId: string, input: UserInput): boolean {
    const item = this.findQueued(queueId);
    if (item === undefined) return false;
    item.input = input;
    return true;
  }

  removeQueued(queueId: string): boolean {
    const start = this.drainRunning ? 1 : 0;
    const index = this.queue.findIndex((item, offset) => offset >= start && item.id === queueId);
    if (index < 0) return false;
    const [removed] = this.queue.splice(index, 1);
    if (removed !== undefined) this.settleItem(removed, this.cancelledError());
    return true;
  }

  clearQueued(): number {
    const start = this.drainRunning ? 1 : 0;
    const removed = this.queue.splice(start);
    for (const item of removed) this.settleItem(item, this.cancelledError());
    return removed.length;
  }

  guideQueued(queueId: string): boolean {
    if (!this.drainRunning) return false;
    const index = this.queue.findIndex((item, offset) => offset > 0 && item.id === queueId);
    if (index < 0) return false;
    const [item] = this.queue.splice(index, 1);
    if (item === undefined) return false;
    this.steerQueue.push(item.input);
    this.settleItem(item);
    void this.deps.ctx.emit("agent/inbox", { agentId: this.inner.id, kind: "steer" });
    return true;
  }

  private findQueued(queueId: string): QueueItem | undefined {
    const start = this.drainRunning ? 1 : 0;
    return this.queue.find((item, offset) => offset >= start && item.id === queueId);
  }

  /** 在当前轮的下一个步边界生效（插话） */
  async steer(input: UserInput): Promise<void> {
    this.assertInteractive();
    if (!this.drainRunning) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_RUNNING,
        message: "agent 未在运行，无法插话",
        userMessage: "它现在没在干活，插话没地方放。",
        retryable: false,
      });
    }
    this.steerQueue.push(input);
    await this.deps.ctx.emit("agent/inbox", {
      agentId: this.inner.id,
      kind: "steer",
    });
  }

  /** 不改对话可见内容，只入上下文（内容经装配变量进入下一次请求；来源落 request/context） */
  async inject(input: InjectedContext): Promise<void> {
    this.assertInteractive();
    this.injectQueue.push(input);
    await this.deps.ctx.emit("agent/inbox", {
      agentId: this.inner.id,
      kind: "inject",
    });
  }

  /**
   * 仅取消当前活动回合。
   *
   * 这对应桌面端的“暂停”：中断流、工具或审批等待，让 `runTurn` 以
   * `turn/end(cancelled)` 收尾，随后回到 idle。它绝不调用底层 agent 的
   * 永久 cancel，因此下一条用户消息仍可继续这个会话。
   */
  async cancel(reason: CancelReason): Promise<void> {
    void reason;
    if (this.cancellation !== null) return this.cancellation;
    if (this.inflight === null || this.controller === null) return;

    this.pauseAfterCurrent = true;
    this.controller.abort();
    const completion = this.waitForIdle();
    this.cancellation = completion;
    try {
      await completion;
    } finally {
      this.cancellation = null;
    }
  }

  /** 重新开始最近一次由用户暂停的任务；没有可续跑任务时返回 false。 */
  async resumeTurn(): Promise<boolean> {
    this.assertInteractive();
    const item = this.suspended;
    if (item === null) return false;

    this.suspended = null;
    item.continuation = true;
    this.queue.unshift(item);
    if (!this.drainRunning) void this.drain();
    return true;
  }

  /** A4：销毁即回滚；之后不得再有该 agent 的事件 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pauseAfterCurrent = true;
    this.controller?.abort();
    // 当前轮由 runTurn 收尾；尚未开始的输入没有会话事件，直接拒绝即可。
    const from = this.drainRunning ? 1 : 0;
    const pending = this.queue.splice(from);
    for (const item of pending) this.settleItem(item, this.cancelledError());
    if (this.drainRunning) await this.waitForIdle();
    await this.inner.dispose();
  }

  // ─────────── 排水与轮执行 ───────────

  private async drain(): Promise<void> {
    /* c8 ignore next 3 -- pushQueue only calls drain when it is not already running */
    if (this.drainRunning) return;
    this.drainRunning = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        /* c8 ignore next 3 -- queue mutation is private and length > 0 guarantees an item */
        if (item === undefined) break;
        this.inflight = this.runTurn(item);
        const controller = this.controller;
        let turnReason: TurnEndReason | undefined;
        try {
          turnReason = await this.inflight;
          this.settleItem(item);
        } catch (err) {
          // L3：错误向上传播给这一轮的发起方；后续排队输入一并失败（它们没机会跑了）
          //
          // 同时**打到控制台**：`agents.followup` 走的是 `enqueue`，而它的 settle 是空函数
          // （同步入队的语义就是"不等结果"），于是这个 err 在这里就断了线——
          // 界面上只剩一句 `turn/end {reason:'error'}` 和一片空白。
          // 没有这行日志，"模型配好了但发不出消息"根本无从查起（实测踩过）。
          console.error("[lcode] 本轮执行失败：", err);
          this.settleItem(item, err);
          const rest = this.queue.splice(1);
          /* c8 ignore next 3 -- the loop is defensive; normal failure has no pending tail */
          for (const waiting of rest) this.settleItem(waiting, err);
          break;
        } finally {
          this.inflight = null;
          if (this.controller === controller) this.controller = null;
          this.queue.shift();
          this.promoteUnconsumedSteers();
        }
        if (this.pauseAfterCurrent) {
          this.pauseAfterCurrent = false;
          if (turnReason === "cancelled" && !this.disposed) {
            this.suspended = item;
          }
          break;
        }
      }
    } finally {
      this.drainRunning = false;
    }
    // idle 事件在 drain 完全收尾（drainRunning 已复位，可再接受 steer/followup）之后广播——
    // watch 侧看到 idle 即可安全认为「空闲且可交互」，不会撞上收尾竞态
    if (!this.disposed) {
      this._status = "idle";
      await this.emitStatus("idle");
    }
    this.resolveIdleWaiters();
  }

  private async runTurn(item: QueueItem): Promise<TurnEndReason> {
    const { input } = item;
    const session = this.deps.getSession(this.inner.sessionId);
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // 取消竞态：排队项还没开跑就被取消——不落任何事件（取消方已拒绝过它）
    /* c8 ignore next 4 -- controller is created immediately before this synchronous guard */
    if (signal.aborted) {
      this.settleItem(item, this.cancelledError());
      return "cancelled";
    }

    const turn = nextTurnNumber(session.events());
    const turnStart = session.append({ type: "turn/start", data: { turn } });
    if (!item.continuation) {
      const userMsg = session.append({
        type: "user/message",
        data: { role: "user", content: toMessageContent(input) },
      });
      item.userSeq = userMsg.seq;
    }
    this._status = "running";
    await this.emitStatus("running");

    let reason: TurnEndReason = "completed";
    let stepOpened = false;
    let step = 0;

    try {
      // 模型选择在回合开始时冻结。设置页的切换只能影响下一次 turn/start，不能让
      // 正在执行、且可能经历多次工具步骤的同一回合前后混用两个模型。
      const selectedModel = this.deps.ctx.get("agentDefaultModel").get();
      if (selectedModel === undefined) {
        throw new LcodeErrorImpl({
          code: ERROR_CODES.EL_NO_MODEL_CONFIGURED,
          message: "没有可用的模型选择（agentDefaultModel 未配置）",
          userMessage: "还没有选择模型。请到「设置 → 模型」里选一个。",
          retryable: false,
        });
      }
      const turnSelection: ModelSelection = {
        provider: selectedModel.provider,
        model: selectedModel.model,
        ...(selectedModel.params === undefined ? {} : { params: { ...selectedModel.params } }),
      };

      for (;;) {
        /* c8 ignore next 4 -- cancellation is handled at the explicit await boundaries below */
        if (signal.aborted) {
          reason = "cancelled";
          break;
        }

        // 协作点：构建请求前（压缩 / 上下文注入 / 守卫在此挂钩）
        await this.deps.ctx.emit("agent/pre-step", {
          agentId: this.inner.id,
          turn,
          nextStep: step + 1,
        });
        // 插话在步边界生效：入模型可见历史（表面事件）
        while (this.steerQueue.length > 0) {
          const s = this.steerQueue.shift();
          if (s !== undefined)
            session.append({
              type: "user/message",
              data: { role: "user", content: toMessageContent(s) },
            });
        }
        /* c8 ignore next 4 -- cancellation after pre-step is folded into the step boundary */
        if (signal.aborted) {
          reason = "cancelled";
          break;
        }

        step += 1;
        stepOpened = true;
        session.append({ type: "step/start", data: { turn, step } });

        // ── 构建请求（I1：一切从日志派生） ──
        const injected = this.injectQueue.splice(0);
        const injectedVars: Record<string, string> = {};
        for (const [i, ctxItem] of injected.entries()) {
          injectedVars[`injected_${i}`] = ctxItem.content;
        }
        if (injected.length > 0) {
          session.append({
            type: "request/context",
            data: { sources: injected.map((c) => c.source) },
          });
        }

        const adapter = this.requireAdapter(turnSelection);
        const assembled = await this.deps.ctx.get("systemPrompt").assemble({
          sessionId: this.inner.sessionId,
          ...(Object.keys(injectedVars).length > 0
            ? { variables: injectedVars }
            : {}),
        });
        const system = item.continuation
          ? `${assembled.system}\n\n上一个执行回合已被用户暂停。请基于当前对话继续未完成的任务，不要重复已经完成的工作。`
          : assembled.system;
        const messages = session.deriveMessages();

        const prepared = await adapter.prepareCall(toCallSelection(turnSelection), {
          signal,
        });
        // 协作点：请求配置可被替换（模型替换 / 降级）。处理器原地改 args.call 后 next()。
        const wf: { call: PreparedCall } = { call: prepared };
        const finalPrepared = await this.deps.ctx.waterfall<
          "agent/request",
          { call: PreparedCall },
          PreparedCall
        >("agent/request", wf, undefined, async () => wf.call);

        const header = {
          provider: finalPrepared.provider,
          model: finalPrepared.model,
          system,
          tools: snapshotTools(assembled.tools),
          systemFingerprint: fingerprintOf(system),
          toolsFingerprint: toolsFingerprintOf(assembled.tools),
        };
        session.append({
          type: "request/header",
          data: { header, reason: headerReason(session.events(), header) },
        });

        // ── 流式消费 ──
        const outcome = await this.consumeStream(
          adapter,
          withBody(
            finalPrepared,
            buildRequestBody(system, messages, assembled.tools),
          ),
          signal,
          session,
          turn,
          step,
        );
        if (outcome.kind === "cancelled") {
          reason = "cancelled";
          break;
        }

        session.append({
          type: "assistant/message",
          data: {
            turn,
            step,
            message: outcome.message,
            ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
          },
        });
        session.append({ type: "step/end", data: { turn, step } });
        stepOpened = false;

        // ── 工具执行（有 tool_use 才进入下一步） ──
        const toolUses = outcome.message.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
            b.type === "tool_use",
        );
        if (toolUses.length === 0) break;

        for (const block of toolUses) {
          const raw =
            outcome.rawArgs.get(block.id) ?? JSON.stringify(block.input);
          const call: ToolCall = {
            callId: block.id,
            name: block.name,
            arguments: raw,
          };
          const card = this.deps.ctx.get("tools").card?.(call.name);
          session.append({
            type: "tool/call",
            data: {
              turn,
              step,
              callId: call.callId,
              name: call.name,
              arguments: raw,
              ...(card === undefined ? {} : { card }),
            },
          });
          /*
           * 把**会话身份**交给工具执行（`scope`）。
           *
           * 工具需要它才能：① 把事件落到正确的会话（审批的两条事件是 per-session 的）、
           * ② 知道工作区根在哪（路径边界判定的输入）。少了它，审批就只能落到"某个
           * 全局通道"上，而那个通道没法回答"这是哪个会话在问"。
           */
          const result = await this.executeTool(call, signal, {
            sessionId: this.inner.sessionId,
            agentId: this.inner.id,
          });
          session.append({
            type: "tool/result",
            data: {
              turn,
              step,
              message: {
                role: "user",
                toolCallId: call.callId,
                content: toolResultContent(result),
                isError: !result.ok,
              },
              ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.meta !== undefined ? { meta: result.meta } : {}),
            },
          });
          if (signal.aborted) {
            reason = "cancelled";
            break;
          }
        }
        if (reason === "cancelled") break;
      }
    } catch (err) {
      // L3：不吞。取消以外的异常 → 轮终态 error + 向发起方再抛
      if (!signal.aborted) {
        const end = session.append({ type: "turn/end", data: { turn, reason: "error" } });
        await this.deps.ctx.emit('agent/turn-ended', {
          agentId: this.inner.id,
          sessionId: this.inner.sessionId,
          session,
          turn,
          reason: 'error',
          endSeq: end.seq,
        });
        stepOpened = false;
        throw err;
      }
      reason = "cancelled";
    }

    // 取消收尾：闭合打开的步，再闭合轮（带血缘，A2）
    if (stepOpened) session.append({ type: "step/end", data: { turn, step } });
    const end = reason === "cancelled"
      ? session.append({
        type: "turn/end",
        data: { turn, reason },
        sourceEventSeqs: [turnStart.seq],
      })
      : session.append({ type: "turn/end", data: { turn, reason } });
    await this.deps.ctx.emit('agent/turn-ended', {
      agentId: this.inner.id,
      sessionId: this.inner.sessionId,
      session,
      turn,
      reason,
      endSeq: end.seq,
    });
    return reason;
  }

  /** 流式消费：逐 chunk 落盘 + 聚合；返回本步的最终消息（或取消标记） */
  private async consumeStream(
    adapter: LlmAdapter,
    call: PreparedCall,
    signal: AbortSignal,
    session: SessionService,
    turn: number,
    step: number,
  ): Promise<
    | { kind: "cancelled" }
    | {
        kind: "done";
        message: AssistantMessage;
        usage?: TokenUsage;
        rawArgs: Map<string, string>;
      }
  > {
    let text = "";
    let usage: TokenUsage | undefined;
    let done: AssistantMessage | undefined;
    let doneUsage: TokenUsage | undefined;
    const argsByCall = new Map<string, { parts: string[] }>();

    try {
      for await (const chunk of adapter.stream(call, signal)) {
        // 取消后到达的片段不再进入日志（轮已取消；到达即事实，但取消方不再需要它们）
        if (signal.aborted) break;
        session.append({
          type: "assistant/chunk",
          data: { turn, step, chunk },
        });
        switch (chunk.type) {
          case "text-delta":
            text += chunk.text;
            break;
          case "reasoning-delta":
            break; // 推理内容已随 chunk 入日志；不进正文
          case "tool-call-delta": {
            const acc = argsByCall.get(chunk.callId) ?? { parts: [] };
            acc.parts.push(chunk.argsDelta);
            argsByCall.set(chunk.callId, acc);
            break;
          }
          case "usage":
            usage = chunk.usage;
            break;
          case "done":
            done = chunk.message;
            doneUsage = chunk.usage;
            break;
        }
      }
    } catch (err) {
      // 适配器以异常响应中止（如 throwIfAborted）：与"静默停止"同一条收尾路径
      if (!signal.aborted) throw err;
    }

    if (signal.aborted && done === undefined) {
      // 打断：有可见内容则记 interrupted 的 assistant 消息（06 §4.1 的不对称：中断不算"到达成功"）
      if (text !== "") {
        session.append({
          type: "assistant/message",
          data: {
            turn,
            step,
            message: { role: "assistant", content: [{ type: "text", text }] },
            interrupted: true,
          },
        });
      }
      return { kind: "cancelled" };
    }

    if (done === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EM_STREAM_PROTOCOL,
        message:
          "流结束但没有收到 done 块（StreamChunk 协议要求每个流以 done 收尾）",
        userMessage: "模型响应中断了。",
        retryable: true,
      });
    }

    const rawArgs = new Map<string, string>();
    for (const [callId, acc] of argsByCall)
      rawArgs.set(callId, acc.parts.join(""));
    return {
      kind: "done",
      message: done,
      ...(doneUsage !== undefined
        ? { usage: doneUsage }
        : usage !== undefined
          ? { usage }
          : {}),
      rawArgs,
    };
  }

  private async executeTool(
    call: ToolCall,
    signal: AbortSignal,
    scope: { readonly sessionId: string; readonly agentId: string },
  ): Promise<ToolResult> {
    const tools: ToolRegistry = this.deps.ctx.get("tools");
    try {
      return await tools.execute(call, { signal, scope });
    } catch (err) {
      // 注册表契约：失败变 result 不上抛。这里的兜底只为保住 I3 配对（tool/call 必须有 result）。
      if (signal.aborted) {
        return {
          callId: call.callId,
          name: call.name,
          ok: false,
          error: { name: "LcodeError", code: ERROR_CODES.ET_ABORTED },
        };
      }
      return {
        callId: call.callId,
        name: call.name,
        ok: false,
        error: { name: "LcodeError", code: ERROR_CODES.ET_ERROR },
        meta: freezeLossless({
          diagnostic: err instanceof Error ? err.message : String(err),
        }),
      };
    }
  }

  private requireAdapter(selection: ModelSelection): LlmAdapter {
    const adapter = this.deps.ctx.get("llm").get(selection.provider);
    if (adapter === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EL_NO_ADAPTER,
        message: `没有注册名为「${selection.provider}」的模型适配器`,
        userMessage: "这个模型供应商不可用。请到「设置 → 模型」换一个。",
        retryable: false,
      });
    }
    return adapter;
  }

  private assertInteractive(): void {
    if (this.disposed) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_RUNNING,
        message: "agent 已销毁",
        userMessage: "这个对话已经关闭了。",
        retryable: false,
      });
    }
  }

  private cancelledError(): LcodeErrorImpl {
    return new LcodeErrorImpl({
      code: ERROR_CODES.EC_NOT_RUNNING,
      message: "agent 已取消，排队输入未执行",
      userMessage: "它已经被停下了。",
      retryable: false,
    });
  }

  private settleItem(item: QueueItem, err?: unknown): void {
    if (item.settled === true) return;
    item.settled = true;
    item.settle(err);
  }

  private waitForIdle(): Promise<void> {
    if (!this.drainRunning) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /**
   * 插话只能在下一次模型请求前安全地进入当前回合。若本轮已经结束（例如模型只输出
   * 一段最终文本、没有工具步骤），不能把消息悄悄留到将来某个无关回合；把它提升为
   * 队首的普通追问，既不打断已完成回复，也保证用户的引导必然可见。
   */
  private promoteUnconsumedSteers(): void {
    if (this.steerQueue.length === 0 || this.disposed) return;
    const deferred = this.steerQueue.splice(0).map((input): QueueItem => ({ id: `q-${++this.nextQueueId}`, input, settle: () => {} }));
    this.queue.unshift(...deferred);
  }

  private async emitStatus(status: AgentStatus): Promise<void> {
    await this.deps.ctx.emit("agent/status", {
      agentId: this.inner.id,
      status,
    });
  }
}

function nextTurnNumber(events: readonly SessionEvent[]): number {
  let last = 0;
  for (const event of events) {
    if (event.type === "turn/start") last = event.data.turn;
  }
  return last + 1;
}

/** UserInput → user/message 的 content（两种形态同构落盘） */
function toMessageContent(input: UserInput): string | readonly ContentBlock[] {
  return input.kind === "text" ? input.text : input.content;
}

function toCallSelection(selection: ModelSelection): ModelSelection {
  return selection;
}

function toolResultContent(result: ToolResult): string {
  if (result.ok) {
    const value = result.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  const diagnostic = (result.meta as { diagnostic?: unknown } | undefined)
    ?.diagnostic;
  const detail = typeof diagnostic === "string" ? `：${diagnostic}` : "";
  return `工具执行失败（${result.error?.code ?? ERROR_CODES.ET_ERROR}）${detail}`;
}
