import type { AgentHandle, AgentRef, AgentSpec } from '@lcode/agent'
import type { PreparedCall } from '@lcode/llm'
import type { ModelSelection } from '@lcode/agent-default-model'
import type { SessionService, ToolResultMessage, TurnEndReason } from '@lcode/session'
import { TurnEngine } from './engine.ts'
import type { AgentLoopDeps, LoopHandle } from './engine.ts'

/**
 * AgentLoop —— 全仓库唯一的具体循环（文档 20 §5.6）。
 * ctx key: `ctx.agentLoop`。
 *
 * ⚠️ 实现纪律（产品宪法第三条 / 不变量 L1=I6）：
 * 本接口的任何实现中，`if` 所判断的内容不得涉及任何具体能力。
 * 协作点（压缩 / 上下文注入 / 策略替换）一律通过事件（见 engine.ts 协作点表）。
 */
export interface AgentLoop {
  create(spec: AgentSpec): Promise<AgentHandle>
  resume(ref: AgentRef): Promise<AgentHandle>
}

/**
 * 循环的运行时形态：句柄带 `enqueue`（agents.* API 的 followup 底层）。
 * `Services.agentLoop` 仍声明为 `AgentLoop`（冻结契约）；装配层把本接口的实现
 * 注册进去，边界层 API 用 `AgentLoopRuntime` 消费。
 */
export interface AgentLoopRuntime extends AgentLoop {
  create(spec: AgentSpec): Promise<LoopHandle>
  resume(ref: AgentRef): Promise<LoopHandle>
}

export type { AgentLoopDeps, CapturedRequest } from './engine.ts'
export type { EnqueueResult, LoopHandle, QueuedInput } from './engine.ts'

/** 具体循环：把注册表身份（@lcode/agent）与轮引擎组装成一个可用的句柄 */
class ConcreteAgentLoop implements AgentLoopRuntime {
  private readonly engines = new Map<string, TurnEngine>()

  constructor(private readonly deps: AgentLoopDeps) {}

  async create(spec: AgentSpec): Promise<LoopHandle> {
    const inner = await this.deps.ctx.get('agents').create(spec)
    return this.attach(inner)
  }

  async resume(ref: AgentRef): Promise<LoopHandle> {
    const inner = await this.deps.ctx.get('agents').resume(ref)
    return this.attach(inner)
  }

  /** 同一 agent 只挂一个引擎（resume 幂等） */
  private attach(inner: AgentHandle): LoopHandle {
    const existing = this.engines.get(inner.id)
    if (existing !== undefined) return existing.handle
    const engine = new TurnEngine(this.deps, inner)
    this.engines.set(inner.id, engine)
    return engine.handle
  }
}

/** 装配入口（批次③里程碑：无密钥也能跑通一次循环——用 @lcode/llm-replay 驱动） */
export function createAgentLoop(deps: AgentLoopDeps): AgentLoopRuntime {
  return new ConcreteAgentLoop(deps)
}

/**
 * 循环自有协作点（文档 20 §5.6 协作点表）：
 * - `agent/pre-step`：构建请求前（emit；压缩 / 上下文注入 / 守卫订阅它）
 * - `agent/model-selection`：回合开始时（waterfall；在选择适配器前路由，整轮固定快照）
 * - `agent/request`：请求配置可用（waterfall；处理器**原地替换 `args.call`** 后调 `next()`，
 *   直接 return 则短路。只可替换调用配置——system / messages 属于日志派生，不在其内，I1）
 */
declare module '@lcode/context' {
  interface Events {
    'agent/pre-step': { agentId: string; turn: number; nextStep: number }
    'agent/model-selection': { agentId: string; sessionId: string; turn: number; selection: ModelSelection }
    'agent/request': { call: PreparedCall }
    /**
     * 请求失败（waterfall）。处理器可在此做"压缩后重试"之类的恢复，并返回
     * `{ retry: true }`；返回 false 或没人处理时错误照常向上抛。
     *
     * 只应在**规范化错误码**上分支（例如 `EL-CONTEXT_OVERFLOW`），不要读错误文案。
     */
    'agent/request-error': {
      agentId: string
      sessionId: string
      session: SessionService
      turn: number
      step: number
      error: unknown
    }
    /** 回合已写入终态；检查点等终局副作用在此串行完成，下一回合开始前可见。 */
    'agent/turn-ended': { agentId: string; sessionId: string; session: SessionService; turn: number; reason: TurnEndReason; endSeq: number }
    /** 工具结果已经成为表面事件；剪枝 / spill 只能在这里或后续步边界做替换。 */
    'agent/tool-result-appended': {
      agentId: string
      sessionId: string
      session: SessionService
      sourceEventSeq: number
      tool: { readonly callId: string; readonly name: string }
      message: ToolResultMessage
    }
  }
  /** ctx key（文档 20 §5.6）：单数 = 一个引擎 */
  interface Services {
    agentLoop: AgentLoop
  }
}
