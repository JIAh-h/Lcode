import { describe, expect, it } from "vitest";
import { InMemoryAgentStore } from "@lcode/agent";
import type { AgentHandle } from "@lcode/agent";
import { InMemoryAgentDefaultModelService } from "@lcode/agent-default-model";
import { createContext } from "@lcode/context";
import { InMemoryLlmRegistry } from "@lcode/llm";
import type { LlmAdapter } from "@lcode/llm";
import { ReplayLlmAdapter } from "@lcode/llm-replay";
import type { ReplayScript } from "@lcode/llm-replay";
import { InMemorySessionStore, deriveMessages } from "@lcode/session";
import type { SessionService } from "@lcode/session";
import { createSystemPromptService } from "@lcode/system-prompt";
import { InMemoryToolRegistry } from "@lcode/tools";
import type { ToolDefinition } from "@lcode/tools";
import { ERROR_CODES, LcodeErrorImpl, asAgentId, asSessionId } from "@lcode/util";
import { createAgentLoop } from "./agent-loop.ts";
import { TurnEngine } from "./engine.ts";
import type { CapturedRequest } from "./agent-loop.ts";

// ─────────── 夹具 ───────────

const echoTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  name: "echo",
  description: "回显输入文本",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "要回显的文本" } },
    required: ["text"],
  },
  execute: (call) => ({ echoed: call.parsed.text }),
};

const toolScript: ReplayScript = {
  provider: "replay",
  chunks: [
    {
      type: "tool-call-delta",
      callId: "call-1",
      name: "echo",
      argsDelta: '{"text":',
    },
    {
      type: "tool-call-delta",
      callId: "call-1",
      name: "echo",
      argsDelta: '"hi"}',
    },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "echo",
            input: { text: "hi" },
          },
        ],
      },
    },
  ],
};

const textScript = (text: string): ReplayScript => ({
  provider: "replay",
  chunks: [
    { type: "text-delta", text },
    {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text }] },
      usage: { input: 5, output: 7, total: 12 },
    },
  ],
});

const failingTool: ToolDefinition<{ text: string }, never> = {
  name: "boom",
  description: "总是失败的工具",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "任意" } },
    required: ["text"],
  },
  execute: () => {
    throw new Error("工具内部爆炸");
  },
};

interface Harness {
  readonly session: SessionService;
  readonly prompts: ReturnType<typeof createSystemPromptService>;
  readonly models: InMemoryAgentDefaultModelService;
  readonly adapter: LlmAdapter;
  readonly registry: InMemoryToolRegistry;
  readonly ctx: ReturnType<typeof createContext>;
  readonly getSession: (id: string) => SessionService;
}

async function makeHarness(
  scripts: ReplayScript | readonly ReplayScript[],
  opts: { adapter?: LlmAdapter; configureModel?: boolean } = {},
): Promise<Harness & { loop: ReturnType<typeof createAgentLoop> }> {
  const ctx = createContext();
  const sessions = new Map<string, SessionService>();
  const session = new InMemorySessionStore(asSessionId("s1"));
  sessions.set("s1", session);
  const getSession = (id: string): SessionService => {
    const found = sessions.get(id);
    if (found === undefined) throw new Error(`session not found: ${id}`);
    return found;
  };
  const registry = new InMemoryToolRegistry(ctx);
  const prompts = createSystemPromptService(registry);
  prompts.section("base", "你是 Lcode。");
  const models = new InMemoryAgentDefaultModelService();
  if (opts.configureModel !== false)
    await models.set({ provider: "replay", model: "replay-model" });
  const adapter = opts.adapter ?? new ReplayLlmAdapter(scripts);
  const llm = new InMemoryLlmRegistry();
  llm.register(adapter);
  ctx.set("agents", new InMemoryAgentStore(ctx, getSession));
  ctx.set("tools", registry);
  ctx.set("systemPrompt", prompts);
  ctx.set("agentDefaultModel", models);
  ctx.set("llm", llm);
  const loop = createAgentLoop({ ctx, getSession });
  return { ctx, session, loop, adapter, prompts, models, registry, getSession };
}

/** I1 捕获装饰器：记录每次请求的 atSeq / system / messages（docs/15 §2.1 的形状） */
function captureDecorator(
  inner: LlmAdapter,
  sink: CapturedRequest[],
  session: SessionService,
): LlmAdapter {
  return {
    providerInfo: () => inner.providerInfo(),
    listModels: (signal) => inner.listModels(signal),
    resolveModel: (sel) => inner.resolveModel(sel),
    prepareCall: (sel, opts) => inner.prepareCall(sel, opts),
    providerRetryPolicy: () => inner.providerRetryPolicy(),
    stream: (call, signal) => {
      const body = call.request.body as {
        system: string;
        messages: readonly unknown[];
      };
      sink.push({
        atSeq: session.length,
        system: body.system,
        messages: body.messages,
      });
      return inner.stream(call, signal);
    },
  };
}

const typesOf = (events: readonly { type: string }[]): string[] =>
  events.map((e) => e.type);

// ─────────── 用例 ───────────

describe("批次③ · 无密钥跑通一次循环", () => {
  it("纯文本轮：完整事件序列 + turn/end(completed)", async () => {
    const h = await makeHarness(textScript("你好"));
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle.followup({ kind: "text", text: "在吗" });

    expect(typesOf(h.session.events())).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "request/header",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    const last = h.session.events().at(-1);
    expect(last).toMatchObject({
      type: "turn/end",
      data: { turn: 1, reason: "completed" },
    });
    const assistant = h.session
      .events()
      .find((e) => e.type === "assistant/message");
    expect(assistant).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "你好" }],
        },
      },
    });
    expect(handle.status).toBe("idle");
  });

  it("请求超窗：恢复协作点推进表面后自动重试，失败步被闭合", async () => {
    const inner = new ReplayLlmAdapter(textScript("恢复后成功"));
    let calls = 0;
    const adapter: LlmAdapter = {
      providerInfo: () => inner.providerInfo(),
      listModels: (signal) => inner.listModels(signal),
      resolveModel: (selection) => inner.resolveModel(selection),
      prepareCall: (selection, opts) => inner.prepareCall(selection, opts),
      providerRetryPolicy: () => inner.providerRetryPolicy(),
      stream: (call, signal) => {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            throw new LcodeErrorImpl({
              code: ERROR_CODES.EL_CONTEXT_OVERFLOW,
              message: "maximum context length exceeded",
              userMessage: "上下文超限",
              retryable: false,
            });
          })();
        }
        return inner.stream(call, signal);
      },
    };
    const h = await makeHarness(textScript("unused"), { adapter });
    h.ctx.on("agent/request-error", (async (
      payload: { session: SessionService },
      next: () => Promise<{ readonly retry: boolean }>,
    ) => {
      void next;
      payload.session.append({
        type: "user/message",
        data: { role: "user", content: [{ type: "text", text: "[summary] 旧历史已压缩" }] },
        surfaceOp: { op: "replace", start: 0, end: 1 },
      } as never);
      return { retry: true };
    }) as never);

    const handle = await h.loop.create({ sessionId: asSessionId("s1"), id: asAgentId("a1") });
    await handle.followup({ kind: "text", text: "开始" });

    expect(calls).toBe(2);
    const events = h.session.events();
    expect(events.filter((event) => event.type === "request/header")).toHaveLength(2);
    // 失败的那一步不能留一个没有终点的区间
    expect(events.filter((event) => event.type === "step/start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "step/end")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "turn/end", data: { turn: 1, reason: "completed" } });
    // 重试请求看到的是压缩后的表面：摘要 + 本轮回复
    expect(deriveMessages(events)).toEqual([
      { role: "user", content: [{ type: "text", text: "[summary] 旧历史已压缩" }] },
      { role: "assistant", content: [{ type: "text", text: "恢复后成功" }] },
    ]);
  });

  it("工具循环：两段脚本驱动，raw args 原样落盘，I3 配对完整", async () => {
    const h = await makeHarness([toolScript, textScript("完成：hi")]);
    h.registry.register({ ...echoTool, card: "read" });
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle.followup({ kind: "text", text: "把 hi 回显一遍" });

    const types = typesOf(h.session.events());
    expect(types).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "request/header",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/end",
      "tool/call",
      "tool/result",
      "step/start",
      "request/header",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    // D9：tool/call 的 arguments 是未解析的原始 JSON 串（两段 delta 的原样拼接）
    const call = h.session.events().find((e) => e.type === "tool/call");
    expect(call).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "echo",
        arguments: '{"text":"hi"}',
      },
    });
    const result = h.session.events().find((e) => e.type === "tool/result");
    expect(result).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          toolCallId: "call-1",
          content: '{"echoed":"hi"}',
          isError: false,
        },
      },
    });
    // 第二次请求的快照原因：同 system / 同工具 / 同模型 → continuation
    const headers = h.session
      .events()
      .filter((e) => e.type === "request/header");
    expect(headers).toHaveLength(2);
    expect(headers[1]).toMatchObject({ data: { reason: "continuation" } });
    // I3：无悬空 call
    const derived = deriveMessages(h.session.events());
    expect(derived).toHaveLength(4);
    expect(derived[1]).toMatchObject({ role: "assistant" });
    expect(derived[2]).toMatchObject({ role: "user", toolCallId: "call-1" });
  });

  it("模型切换只在下一轮生效，工具续步仍使用本轮开始时的快照", async () => {
    const h = await makeHarness([toolScript, textScript("第一轮完成")]);
    const nextTurnAdapter = new ReplayLlmAdapter({
      provider: "other",
      model: "other-model",
      chunks: textScript("第二轮完成").chunks,
    });
    h.ctx.get("llm").register(nextTurnAdapter);
    h.registry.register({
      ...echoTool,
      execute: async () => {
        await h.models.set({ provider: "other", model: "other-model" });
        return { echoed: "hi" };
      },
    });
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });

    await handle.followup({ kind: "text", text: "第一轮带工具" });
    const firstTurnHeaders = h.session
      .events()
      .filter((event) => event.type === "request/header")
      .map((event) => event.data.header);
    expect(firstTurnHeaders).toHaveLength(2);
    expect(firstTurnHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "replay", model: "replay-model" }),
      ]),
    );
    expect(firstTurnHeaders.every((header) => header.provider === "replay")).toBe(true);

    await handle.followup({ kind: "text", text: "下一轮采用新模型" });
    const headers = h.session.events().filter((event) => event.type === "request/header");
    expect(headers.at(-1)).toMatchObject({
      data: { header: { provider: "other", model: "other-model" }, reason: "model-switch" },
    });
  });

  it("模型路由在选择 Adapter 前发生，并把整轮选择固定进 request/header", async () => {
    const h = await makeHarness(textScript("默认模型不应被调用"));
    const routed = new ReplayLlmAdapter({ ...textScript("已由路由模型完成"), provider: "routed" });
    h.ctx.get("llm").register(routed);
    h.ctx.on("agent/model-selection", (async (
      args: { selection: { provider: string; model: string } },
      next: () => Promise<{ provider: string; model: string }>,
    ) => {
      const value = args;
      value.selection = { provider: "routed", model: "routed-model" };
      return await next();
    }) as never);
    const handle = await h.loop.create({ sessionId: asSessionId("s1"), id: asAgentId("a1") });
    await handle.followup({ kind: "text", text: "路由一次" });
    expect(routed.served).toHaveLength(1);
    expect(h.session.events().find((event) => event.type === "request/header")).toMatchObject({
      data: { header: { provider: "routed", model: "routed-model" } },
    });
  });

  it("每轮复制模型采样参数，避免后续设置改写当前请求", async () => {
    const base = new ReplayLlmAdapter(textScript("参数已应用"));
    const selections: unknown[] = [];
    const adapter: LlmAdapter = {
      providerInfo: () => base.providerInfo(),
      listModels: (signal) => base.listModels(signal),
      resolveModel: (selection) => base.resolveModel(selection),
      prepareCall: async (selection, options) => {
        selections.push(selection);
        return base.prepareCall(selection, options);
      },
      stream: (call, signal) => base.stream(call, signal),
      providerRetryPolicy: () => base.providerRetryPolicy(),
    };
    const h = await makeHarness([], { adapter });
    await h.models.set({ provider: "replay", model: "replay-model", params: { temperature: 0.2, maxTokens: 128 } });
    const handle = await h.loop.create({ sessionId: asSessionId("s1"), id: asAgentId("a1") });
    await handle.followup({ kind: "text", text: "带参数运行" });
    expect(selections).toEqual([
      expect.objectContaining({ params: { temperature: 0.2, maxTokens: 128 } }),
    ]);
  });

  it("I1 · 模型可见即可重放：每次请求都能从日志前缀精确重建", async () => {
    const base = new ReplayLlmAdapter([toolScript, textScript("done")]);
    const h0 = await makeHarness([]);
    const sink: CapturedRequest[] = [];
    const captured = captureDecorator(base, sink, h0.session);
    // 重建一个用捕获适配器的装配
    h0.ctx.set("llm", {
      register: () => () => {},
      get: () => captured,
      list: () => ["replay"],
    });
    h0.registry.register(echoTool);
    const handle = await h0.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle.followup({ kind: "text", text: "把 hi 回显一遍" });

    expect(sink.length).toBe(2);
    const expectedSystem = (await h0.prompts.assemble({ sessionId: "s1" }))
      .system;
    for (const req of sink) {
      const prefix = h0.session.events().slice(0, req.atSeq);
      // ① messages 结构深相等（从日志前缀派生）
      expect(req.messages).toEqual(deriveMessages(prefix));
      // ② system 逐字节一致
      expect(req.system).toBe(expectedSystem);
    }
  });

  it("取消（流中）：interrupted 消息 + turn/end(cancelled) 带血缘，二次取消幂等", async () => {
    const ref: { current?: AgentHandle } = {};
    let streamCount = 0;
    const cancelAdapter: LlmAdapter = {
      providerInfo: () => ({
        id: "replay",
        name: "replay",
        capabilities: { streaming: true, reasoning: true, toolCalls: true },
      }),
      listModels: async () => [{ id: "replay-model" }],
      resolveModel: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
      }),
      prepareCall: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
        request: { endpoint: "replay://", headers: {}, body: {} },
        retryPolicy: {
          maxAttempts: 1,
          baseDelayMs: 0,
          shouldRetry: () => false,
        },
      }),
      stream: () =>
        (async function* () {
          if (streamCount++ > 0) {
            yield {
              type: "done",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "下一轮正常完成" }],
              },
            };
            return;
          }
          yield { type: "text-delta", text: "部分" };
          void ref.current?.cancel("user");
          yield { type: "text-delta", text: "取消后到达" };
        })(),
      providerRetryPolicy: () => ({
        maxAttempts: 1,
        baseDelayMs: 0,
        shouldRetry: () => false,
      }),
    };
    const h = await makeHarness([], { adapter: cancelAdapter });
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    ref.current = handle;
    await handle.followup({ kind: "text", text: "写一首诗" });

    // 取消后到达的 chunk 不入日志；取消前的内容以 interrupted 消息落盘
    const texts = h.session
      .events()
      .filter((e) => e.type === "assistant/chunk")
      .map((e) => (e.data as { chunk: { text?: string } }).chunk.text);
    expect(texts).not.toContain("取消后到达");
    const interrupted = h.session
      .events()
      .find(
        (e) =>
          e.type === "assistant/message" &&
          (e.data as { interrupted?: boolean }).interrupted === true,
      );
    expect(interrupted).toBeDefined();
    expect(interrupted).toMatchObject({
      data: { message: { content: [{ type: "text", text: "部分" }] } },
    });
    const turnEnd = h.session.events().find((e) => e.type === "turn/end");
    expect(turnEnd).toMatchObject({
      type: "turn/end",
      data: { reason: "cancelled" },
      sourceEventSeqs: [0],
    });
    expect(handle.status).toBe("idle");
    // 二次取消幂等；“继续”基于已落盘上下文续跑，不重复追加原始用户消息。
    await expect(handle.cancel("user")).resolves.toBeUndefined();
    const completed = new Promise<void>((resolve) => {
      const stop = h.session.onEvent((event) => {
        if (event.type === "turn/end" && event.data.turn === 2) {
          stop();
          resolve();
        }
      });
    });
    await expect(handle.resumeTurn()).resolves.toBe(true);
    await completed;
    expect(h.session.events().filter((e) => e.type === "turn/end")).toMatchObject([
      { data: { turn: 1, reason: "cancelled" } },
      { data: { turn: 2, reason: "completed" } },
    ]);
    expect(
      h.session.events().filter((event) => event.type === "user/message"),
    ).toHaveLength(1);
  });

  it("工具失败不终结轮：失败变成 tool/result 交给模型（08 §4.4）", async () => {
    const h = await makeHarness([
      {
        provider: "replay",
        chunks: [
          {
            type: "tool-call-delta",
            callId: "call-9",
            name: "boom",
            argsDelta: '{"text":"x"}',
          },
          {
            type: "done",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-9",
                  name: "boom",
                  input: { text: "x" },
                },
              ],
            },
          },
        ],
      },
      textScript("已处理失败"),
    ]);
    h.registry.register(failingTool);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle.followup({ kind: "text", text: "用 boom 工具" });

    const result = h.session.events().find((e) => e.type === "tool/result");
    expect(result).toMatchObject({
      data: { message: { isError: true }, error: { code: "ET-ERROR" } },
    });
    const last = h.session.events().at(-1);
    expect(last).toMatchObject({
      type: "turn/end",
      data: { reason: "completed" },
    });
  });

  it("resume：新循环实例接上同一会话，轮号从日志续排", async () => {
    const h = await makeHarness([textScript("第一轮"), textScript("第二轮")]);
    const handle1 = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle1.followup({ kind: "text", text: "第一句" });
    // 新的循环实例（模拟进程重启后的恢复）
    const loop2 = createAgentLoop({ ctx: h.ctx, getSession: h.getSession });
    const handle2 = await loop2.resume({
      sessionId: asSessionId("s1"),
      agentId: asAgentId("a1"),
    });
    await handle2.followup({ kind: "text", text: "第二句" });
    const turns = h.session.events().filter((e) => e.type === "turn/start");
    expect(turns.map((t) => (t.data as { turn: number }).turn)).toEqual([1, 2]);
  });

  it("followup 排队：两个输入顺序成轮（turn 1 → turn 2）", async () => {
    const h = await makeHarness([textScript("一"), textScript("二")]);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    const p1 = handle.followup({ kind: "text", text: "第一句" });
    const p2 = handle.followup({ kind: "text", text: "第二句" });
    await Promise.all([p1, p2]);
    const turns = h.session.events().filter((e) => e.type === "turn/start");
    expect(turns.map((t) => (t.data as { turn: number }).turn)).toEqual([1, 2]);
    expect(
      h.session.events().filter((e) => e.type === "turn/end"),
    ).toHaveLength(2);
  });

  it("未配置模型：EL-NO_MODEL_CONFIGURED，turn/end(error)，L3 不吞", async () => {
    const h = await makeHarness(textScript("x"), { configureModel: false });
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await expect(
      handle.followup({ kind: "text", text: "在吗" }),
    ).rejects.toMatchObject({
      code: "EL-NO_MODEL_CONFIGURED",
    });
    const turnEnd = h.session.events().find((e) => e.type === "turn/end");
    expect(turnEnd).toMatchObject({ data: { reason: "error" } });
  });

  it("无适配器：EL-NO_ADAPTER", async () => {
    const h = await makeHarness(textScript("x"));
    await h.models.set({ provider: "ghost", model: "whatever" });
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await expect(
      handle.followup({ kind: "text", text: "在吗" }),
    ).rejects.toMatchObject({ code: "EL-NO_ADAPTER" });
  });

  it("steer：插话在下一个步边界进入模型可见历史", async () => {
    const h = await makeHarness([toolScript, textScript("收到补充")]);
    h.registry.register(echoTool);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    // 第一个 chunk 落盘后插话一次（模拟运行中用户输入）
    let steered = false;
    const dispose = h.session.onEvent((e) => {
      if (e.type === "assistant/chunk" && !steered) {
        steered = true;
        void handle.steer({ kind: "text", text: "顺便补一句" }).catch(() => {});
      }
    });
    await handle.followup({ kind: "text", text: "把 hi 回显一遍" });
    dispose();

    const events = h.session.events();
    const resultIdx = events.findIndex((e) => e.type === "tool/result");
    expect(events[resultIdx + 1]).toMatchObject({
      type: "user/message",
      data: { content: "顺便补一句" },
    });
    expect(events[resultIdx + 2]).toMatchObject({
      type: "step/start",
      data: { step: 2 },
    });
    // 最后一次请求的派生消息包含插话
    const derived = deriveMessages(events);
    expect(
      derived.some((m) => m.role === "user" && m.content === "顺便补一句"),
    ).toBe(true);
  });

  it("steer：当前回合没有下一步骤时，自动提升为队首下一轮而不丢失", async () => {
    const h = await makeHarness([textScript("第一轮完成"), textScript("已按引导继续")]);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    const twoTurns = new Promise<void>((resolve) => {
      let ended = 0;
      const stop = h.session.onEvent((event) => {
        if (event.type !== "turn/end") return;
        ended += 1;
        if (ended === 2) {
          stop();
          resolve();
        }
      });
    });
    let steered = false;
    const stop = h.session.onEvent((event) => {
      if (event.type !== "assistant/chunk" || steered) return;
      steered = true;
      void handle.steer({ kind: "text", text: "改为只补测试" });
    });

    await handle.followup({ kind: "text", text: "开始处理" });
    await twoTurns;
    stop();

    expect(h.session.events().filter((event) => event.type === "user/message").map((event) => event.data.content)).toEqual([
      "开始处理",
      "改为只补测试",
    ]);
    expect(h.session.events().filter((event) => event.type === "turn/start")).toHaveLength(2);
  });

  it("边界：状态 getter、暂停后保持可继续对话", async () => {
    let release: (() => void) | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let streamCount = 0;
    const blockingAdapter: LlmAdapter = {
      providerInfo: () => ({
        id: "replay",
        name: "replay",
        capabilities: { streaming: true, reasoning: true, toolCalls: true },
      }),
      listModels: async () => [{ id: "replay-model" }],
      resolveModel: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
      }),
      prepareCall: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
        request: { endpoint: "replay://", headers: {}, body: {} },
        retryPolicy: {
          maxAttempts: 1,
          baseDelayMs: 0,
          shouldRetry: () => false,
        },
      }),
      stream: (_call, signal) =>
        (async function* () {
          if (streamCount++ > 0) {
            yield {
              type: "done",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "恢复后的回答" }],
              },
            };
            return;
          }
          started();
          yield { type: "text-delta", text: "等待中" };
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      providerRetryPolicy: () => ({
        maxAttempts: 1,
        baseDelayMs: 0,
        shouldRetry: () => false,
      }),
    };
    const h = await makeHarness([], { adapter: blockingAdapter });
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    const inner = h.ctx.get("agents").get(asAgentId("a1"))!;
    const engine = new TurnEngine(
      { ctx: h.ctx, getSession: h.getSession },
      inner,
    );
    expect(engine.status).toBe("idle");
    expect(handle.status).toBe("idle");
    await expect(engine.resumeTurn()).resolves.toBe(false);
    await expect((engine as unknown as { waitForIdle: () => Promise<void> }).waitForIdle()).resolves.toBeUndefined();

    const first = handle.followup({ kind: "text", text: "第一轮" });
    await startedPromise;
    const queued = handle.enqueue({ kind: "text", text: "排队输入" });
    expect(queued).toMatchObject({ accepted: true, queueId: expect.any(String), seq: h.session.length });
    expect(handle.queued()).toEqual([{ queueId: queued.queueId, input: { kind: "text", text: "排队输入" } }]);
    expect(handle.editQueued(queued.queueId, { kind: "text", text: "改过的排队输入" })).toBe(true);
    expect(handle.queued()).toEqual([{ queueId: queued.queueId, input: { kind: "text", text: "改过的排队输入" } }]);
    expect(handle.guideQueued(queued.queueId)).toBe(true);
    expect(handle.queued()).toEqual([]);
    const cancelled = handle.cancel("user");
    release?.();
    await cancelled;
    await first;
    expect(handle.status).toBe("idle");
    await handle.followup({ kind: "text", text: "下一轮" });
    expect(handle.status).toBe("idle");
  });

  it("销毁时拒绝尚未开始的排队输入", async () => {
    let release: (() => void) | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter: LlmAdapter = {
      providerInfo: () => ({
        id: "replay",
        name: "replay",
        capabilities: { streaming: true, reasoning: true, toolCalls: true },
      }),
      listModels: async () => [{ id: "replay-model" }],
      resolveModel: async (selection) => ({ provider: selection.provider, model: selection.model }),
      prepareCall: async (selection) => ({
        provider: selection.provider,
        model: selection.model,
        request: { endpoint: "replay://", headers: {}, body: {} },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false },
      }),
      stream: (_call, signal) =>
        (async function* () {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      providerRetryPolicy: () => ({ maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false }),
    };
    const h = await makeHarness([], { adapter });
    const handle = await h.loop.create({ sessionId: asSessionId("s1"), id: asAgentId("a1") });
    const active = handle.followup({ kind: "text", text: "活动输入" });
    await startedPromise;
    const pending = handle.followup({ kind: "text", text: "排队输入" });
    const pendingRejected = expect(pending).rejects.toMatchObject({ code: "EC-NOT_RUNNING" });
    const disposing = handle.dispose();
    release?.();
    await disposing;
    await active;
    await pendingRejected;
  });

  it("边界：reasoning/usage 片段、无 done 协议错误与流异常取消", async () => {
    const chunks: ReplayScript = {
      provider: "replay",
      chunks: [
        { type: "reasoning-delta", text: "内部推理" },
        { type: "usage", usage: { input: 2, output: 3, total: 5 } },
        { type: "text-delta", text: "正文" },
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "正文" }],
          },
        },
      ],
    };
    const h = await makeHarness(chunks);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle.followup({ kind: "text", text: "开始" });
    expect(
      h.session.events().find((e) => e.type === "assistant/message"),
    ).toMatchObject({ data: { usage: { input: 2, output: 3, total: 5 } } });

    const noDone = await makeHarness({
      provider: "replay",
      chunks: [{ type: "text-delta", text: "没有结束" }],
    });
    const noDoneHandle = await noDone.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await expect(
      noDoneHandle.followup({ kind: "text", text: "协议错误" }),
    ).rejects.toMatchObject({ code: "EM-STREAM_PROTOCOL" });
    expect(noDone.session.events().at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: "error" },
    });

    const ref: { handle?: AgentHandle } = {};
    const throwingAdapter: LlmAdapter = {
      providerInfo: () => ({
        id: "replay",
        name: "replay",
        capabilities: { streaming: true, reasoning: true, toolCalls: true },
      }),
      listModels: async () => [{ id: "replay-model" }],
      resolveModel: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
      }),
      prepareCall: async (sel) => ({
        provider: sel.provider,
        model: sel.model,
        request: { endpoint: "replay://", headers: {}, body: {} },
        retryPolicy: {
          maxAttempts: 1,
          baseDelayMs: 0,
          shouldRetry: () => false,
        },
      }),
      stream: () =>
        (async function* () {
          yield { type: "text-delta", text: "部分" };
          void ref.handle?.cancel("user");
          throw new Error("取消时流异常");
        })(),
      providerRetryPolicy: () => ({
        maxAttempts: 1,
        baseDelayMs: 0,
        shouldRetry: () => false,
      }),
    };
    const interrupted = await makeHarness([], { adapter: throwingAdapter });
    const interruptedHandle = await interrupted.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    ref.handle = interruptedHandle;
    await interruptedHandle.followup({ kind: "text", text: "取消" });
    expect(interruptedHandle.status).toBe("idle");

    const plainThrowingAdapter: LlmAdapter = {
      ...throwingAdapter,
      stream: () =>
        (async function* () {
          throw new Error("流异常");
        })(),
    };
    const plainThrowing = await makeHarness([], {
      adapter: plainThrowingAdapter,
    });
    const plainHandle = await plainThrowing.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await expect(
      plainHandle.followup({ kind: "text", text: "流异常" }),
    ).rejects.toThrow("流异常");

    const prepareAbortRef: { handle?: AgentHandle } = {};
    const prepareAbortAdapter: LlmAdapter = {
      ...plainThrowingAdapter,
      prepareCall: async (_sel) => {
        void prepareAbortRef.handle?.cancel("user");
        throw new Error("准备阶段取消");
      },
    };
    const prepareAbort = await makeHarness([], {
      adapter: prepareAbortAdapter,
    });
    const prepareHandle = await prepareAbort.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    prepareAbortRef.handle = prepareHandle;
    await prepareHandle.followup({ kind: "text", text: "准备阶段取消" });
    expect(prepareHandle.status).toBe("idle");
  });

  it("边界：工具注册表异常按 ET-ABORTED 兜底并闭合工具结果", async () => {
    const h = await makeHarness([toolScript, textScript("工具错误已返回")]);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    h.ctx.set("tools", {
      execute: async () => {
        void handle.cancel("user");
        throw new Error("工具取消");
      },
    } as never);
    await handle.followup({ kind: "text", text: "执行工具" });
    expect(
      h.session.events().find((e) => e.type === "tool/result"),
    ).toMatchObject({ data: { error: { code: "ET-ABORTED" } } });
    expect(handle.status).toBe("idle");

    const stringErrorHarness = await makeHarness([
      toolScript,
      textScript("字符串错误已返回"),
    ]);
    const stringErrorHandle = await stringErrorHarness.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    stringErrorHarness.ctx.set("tools", {
      execute: async () => {
        throw "工具字符串异常";
      },
    } as never);
    await stringErrorHandle.followup({ kind: "text", text: "字符串错误工具" });

    const stringResultHarness = await makeHarness([
      toolScript,
      textScript("字符串结果已返回"),
    ]);
    const stringResultHandle = await stringResultHarness.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    stringResultHarness.ctx.set("tools", {
      execute: async (call: { callId: string; name: string }) => ({
        callId: call.callId,
        name: call.name,
        ok: true,
        value: "纯字符串结果",
      }),
    } as never);
    await stringResultHandle.followup({ kind: "text", text: "字符串结果工具" });

    const missingCodeHarness = await makeHarness([
      toolScript,
      textScript("缺少错误码已返回"),
    ]);
    const missingCodeHandle = await missingCodeHarness.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    missingCodeHarness.ctx.set("tools", {
      execute: async (call: { callId: string; name: string }) => ({
        callId: call.callId,
        name: call.name,
        ok: false,
        error: { name: "LcodeError" },
      }),
    } as never);
    await missingCodeHandle.followup({ kind: "text", text: "缺少错误码工具" });
  });

  it("边界：工具注册表异常按 ET-ERROR 兜底并闭合工具结果", async () => {
    const h = await makeHarness([toolScript, textScript("工具错误已返回")]);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    h.ctx.set("tools", {
      execute: async () => {
        throw new Error("工具内部异常");
      },
    } as never);
    await handle.followup({ kind: "text", text: "执行失败工具" });
    expect(
      h.session.events().find((e) => e.type === "tool/result"),
    ).toMatchObject({ data: { error: { code: "ET-ERROR" } } });
  });

  it("边界：没有增量参数时从 tool_use input 生成原始参数", async () => {
    const fallbackScript: ReplayScript = {
      provider: "replay",
      chunks: [
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-fallback",
                name: "echo",
                input: { text: "fallback" },
              },
            ],
          },
        },
      ],
    };
    const h = await makeHarness([fallbackScript, textScript("备用参数已执行")]);
    h.registry.register(echoTool);
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });
    await handle.followup({ kind: "text", text: "备用参数" });
    expect(
      h.session.events().find((e) => e.type === "tool/call"),
    ).toMatchObject({
      data: { arguments: '{"text":"fallback"}' },
    });
  });
});

describe("技能上下文生命周期", () => {
  it("技能只在本轮请求里生效，后续轮次会剥掉旧 skill 块", async () => {
    const h = await makeHarness([textScript("第一轮"), textScript("第二轮")]);
    const captures: CapturedRequest[] = [];
    h.ctx.get("llm").register(captureDecorator(h.adapter, captures, h.session));
    const handle = await h.loop.create({
      sessionId: asSessionId("s1"),
      id: asAgentId("a1"),
    });

    await handle.followup({
      kind: "content",
      content: [
        { type: "text", text: "用技能看一下" },
        { type: "skill", id: "review", name: "Review", instructions: "只看改动。" },
      ],
    });
    await handle.followup({ kind: "text", text: "继续" });

    expect(captures).toHaveLength(2);
    expect(JSON.stringify(captures[0]!.messages)).toContain('"type":"skill"');
    expect(JSON.stringify(captures[1]!.messages)).not.toContain('"type":"skill"');
    expect(JSON.stringify(captures[1]!.messages)).toContain("用技能看一下");
  });

  it("屏蔽的轮次不进入请求；附件引用在请求边界解析成图片内容", async () => {
    const h = await makeHarness([textScript("第一答"), textScript("第二答")]);
    const captures: CapturedRequest[] = [];
    h.ctx.set("attachments", {
      resolveImage: ({ hash }) => (hash === "b".repeat(64) ? "BASE64DATA" : undefined),
    });
    h.ctx.get("llm").register(captureDecorator(h.adapter, captures, h.session));
    const handle = await h.loop.create({ sessionId: asSessionId("s1"), id: asAgentId("a1") });
    await handle.followup({ kind: "text", text: "这是会被屏蔽的第一问" });
    const firstUser = h.session.events().find((event) => event.type === "user/message");
    expect(firstUser).toBeDefined();
    h.session.append({ type: "context/turn-marker", data: { targetSeq: firstUser!.seq, muted: true } });
    await handle.followup({
      kind: "content",
      content: [
        { type: "text", text: "第二问带图" },
        { type: "image-ref", mediaType: "image/png", hash: "b".repeat(64), bytes: 9 },
      ],
    });

    expect(JSON.stringify(captures[1]!.messages)).not.toContain("这是会被屏蔽的第一问");
    expect(JSON.stringify(captures[1]!.messages)).toContain('"type":"image"');
    expect(JSON.stringify(captures[1]!.messages)).toContain("BASE64DATA");
  });
});
