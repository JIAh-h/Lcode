import type { JsonValue } from '@lcode/util'

/**
 * ────────────────────────────────────────────────────────────────
 * Lcode 事件数据模型（文档 06 §2 + 22 §5 字段字典 + 22 §6 枚举）
 * ────────────────────────────────────────────────────────────────
 * SessionEventMap 是**开放**接口（声明合并）：插件可新增日志事件而不改内核（06 §2.2）。
 * 因为开放，switch (event.type) 不能用 assertNever，必须写 default 兜底（06 §2.3）。
 */

// ─────────── 枚举（22 §6） ───────────

/** 轮结束原因（22 §6.2 会话/agent 状态） */
export type TurnEndReason = 'completed' | 'cancelled' | 'interrupted' | 'error'

/** 审批结果四态（22 §6.5；rejected 与 cancelled 是两个不同的事实，不得合并） */
export type ApprovalResult = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 工具卡片类型（22 §6.3） */
export type CardType = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'

/** agent 状态（20 §5.4 AgentHandle） */
export type AgentStatus = 'idle' | 'running' | 'waiting-approval' | 'cancelled'

/** 请求快照原因（06 待补充完整集合，骨架先列已知值） */
export type RequestHeaderReason = 'new-epoch' | 'continuation' | 'model-switch'

/** 被审批的**动作**（12 §5.4：意图化摘要，不是 JSON dump） */
export interface ApprovalAction {
  readonly tool: string
  /** 一句人能看懂的话（"把 > 写到 /Users/you/other/.env"），不是参数原文 */
  readonly summary: string
  readonly argv?: readonly string[] | undefined
  readonly cwd?: string | undefined
}

/**
 * 这条请求**凭什么被提出来**（12 §5.4）。
 *
 * 四选一，因为"为什么问你"本身是用户判断要不要放行的关键信息：
 * 是预设规定的？是某条策略加的？还是守卫要求的？
 */
export interface ApprovalBasis {
  readonly source: 'preset' | 'waterfall' | 'guard' | 'delegation'
  readonly reason: string
  /** `source === 'preset'` 时给出档位名（如「标准」） */
  readonly presetName?: string | undefined
}

/** 一处受影响的文件 */
export interface ApprovalPathImpact {
  readonly path: string
  readonly mode: 'read' | 'write'
  /**
   * **是否在工作区之外**。
   *
   * 这个字段是 T1 的最后一道防线：UI **必须**把它显著标出来（21 §6.2 的
   * `EP-OUTSIDE_WORKSPACE` 要求"弹出询问框并显著标出工作区外"）。
   */
  readonly outsideWorkspace: boolean
}

/**
 * 审批展示的影响面（12 §5.4）。
 *
 * 三段（action / basis / impact）**缺一不可**（`SEC-APPROVAL-003`）：
 * 用户要在**不点开工具参数**的情况下看懂"它要干什么、为什么要问、会碰到什么"。
 */
export interface Impact {
  readonly paths?: readonly ApprovalPathImpact[] | undefined
  /** 出站的域名（不是 URL——用户判断的是"要不要让数据去这个站"） */
  readonly network?: { readonly domains: readonly string[] } | undefined
  /** 涉及的**环境变量名**（**只给名字不给值**——值可能含凭据，I7） */
  readonly env?: readonly string[] | undefined
  /** 沙箱档位变化（放宽档位本身是需要审批的动作之一，12 §9.3 ⑤） */
  readonly sandboxChange?: { readonly from: string; readonly to: string } | undefined
  /**
   * 当前动作无法获得系统级沙箱约束时的实际状态。
   *
   * 它与 `sandboxChange` 不同：前者描述“本次根本没有强制边界”，后者描述“用户
   * 请求把某个档位调宽”。两者混为一谈会让审批界面把降级误读成用户主动提权。
   */
  readonly sandbox?: { readonly status: 'degraded'; readonly mechanism: string; readonly reason: string } | undefined
  readonly processScope?: string | undefined
}

// ─────────── 消息与内容块 ───────────

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: JsonValue }
  | {
      readonly type: 'tool_result'
      readonly toolCallId: string
      readonly content: string | readonly ContentBlock[]
      readonly isError: boolean
    }

export interface UserMessage {
  readonly role: 'user'
  readonly content: string | readonly ContentBlock[]
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: readonly ContentBlock[]
  /** 来源标注（provider / model），来自适配器 */
  readonly provider?: string
  readonly model?: string
}

export interface ToolResultMessage {
  readonly role: 'user'
  readonly toolCallId: string
  readonly content: string | readonly ContentBlock[]
  readonly isError: boolean
}

/** 模型可见消息：三种角色（文档 06 §2.2：表面只含这三类） */
export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage

export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly total?: number
}

/** 待办项（todo/write 整表快照，last-write-wins，06 §2.2） */
export interface TodoItem {
  readonly id: string
  readonly text: string
  readonly status: 'pending' | 'in-progress' | 'done'
}

/** 用户可确认、可回放的实施计划。计划本身不产生文件或进程副作用。 */
export interface PlanArtifact {
  readonly summary: string
  readonly steps: readonly string[]
  readonly risks?: readonly string[] | undefined
}

// ─────────── 流协议（闭合联合） ───────────

/**
 * StreamChunk：流式协议是 provider 与内核之间的**严格契约**（06 §2.3）。
 * 闭合联合——加变体必须让所有处理者编译失败，而不是静默漏处理。
 */
export type StreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly callId: string; readonly name: string; readonly argsDelta: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'done'; readonly message: AssistantMessage; readonly usage?: TokenUsage }

/**
 * 一次模型请求中模型可见的工具定义。
 *
 * 它有意不复用 `@lcode/tools` 的 `ToolSchema`：session 是更底层的事实层，
 * 只能持有无损 JSON 快照，不能反向依赖工具运行时。
 */
export interface RequestToolSnapshot {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonValue
}

/**
 * 请求快照（`request/header` 事件）。
 *
 * 指纹负责快速比较 epoch；`system` / `tools` 是审计重放所需的权威副本。
 * 只保存指纹会让历史界面只能证明"配置变过"，却无法还原模型实际看到的输入。
 */
export interface EpochHeader {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly tools: readonly RequestToolSnapshot[]
  readonly systemFingerprint: string
  readonly toolsFingerprint: string
}

/** request/context 事件载荷（骨架：外部上下文来源清单） */
export interface RequestContext {
  readonly sources: readonly string[]
}

// ─────────── 事件词汇表 ───────────

/**
 * 事件判别字段 → data 载荷（开放，声明合并扩展）：
 *
 *   declare module '@lcode/session' {
 *     interface SessionEventMap {
 *       'myplugin/custom': { foo: string }
 *     }
 *   }
 */
export interface SessionEventMap {
  // ─────────── 结构边界 ───────────
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }

  // ─────────── 表面事件（会产生模型可见消息） ───────────
  'user/message': UserMessage
  'assistant/message': {
    readonly turn: number
    readonly step: number
    readonly message: AssistantMessage
    readonly usage?: TokenUsage
    /** 流式被打断但有可见内容时为 true */
    readonly interrupted?: true
  }
  'tool/result': {
    readonly turn: number
    readonly step: number
    readonly message: ToolResultMessage
    readonly error?: { readonly name: string; readonly code: string }
    /** 可重放的 UI 元数据（如 diff 的 hunk） */
    readonly meta?: JsonValue
  }

  // ─────────── 日志事件（不进模型历史） ───────────
  'assistant/chunk': { readonly turn: number; readonly step: number; readonly chunk: StreamChunk }
  'tool/call': {
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly name: string
    /** 工具声明的 UI 卡片类型；旧日志缺省时由 UI 按工具名回退。 */
    readonly card?: CardType | undefined
    /** ⚠️ 未解析的原始 JSON 字符串，不是对象（D9：参数不可被改写） */
    readonly arguments: string
  }
  'request/header': { readonly header: EpochHeader; readonly reason: RequestHeaderReason }
  'request/context': RequestContext
  /** 生命周期分界线：空载荷，靠位置表达含义（11 §7） */
  'session/end-seed': Record<string, never>
  /** 待办整表快照，last-write-wins */
  'todo/write': { readonly todos: readonly TodoItem[] }
  /** 计划模式：整值替换；退出原因让“确认执行”和“取消”在回放中可区分。 */
  'plan/mode': {
    readonly active: boolean
    readonly reason?: 'entered' | 'confirmed' | 'cancelled' | undefined
  }
  /** 计划模式中的模型提交了一份结构化计划，等待用户批准。 */
  'plan/proposed': {
    readonly plan: PlanArtifact
  }
  /** 用户批准某一份计划；随后由宿主创建正常执行回合。 */
  'plan/approved': {
    readonly proposedSeq: number
  }
  /** 已批准计划发生实质变更；批准记录仍由 approval/* 事件保存。 */
  'plan/changed': {
    readonly previousProposedSeq: number
    readonly plan: PlanArtifact
    readonly reason: string
  }
  /** 当前会话工作区的信任结论；全局状态由宿主配置文件持久化。 */
  'workspace/trust': {
    readonly workspace: string
    readonly trusted: boolean
  }
  /**
   * 提了一个审批问题（12 §5.5）。
   *
   * **落盘**：审批是时间轴上的一等事实——中止后重新打开，用户要能看到
   * "当时问过什么、怎么答的"（21 §4 索引）。
   */
  'approval/asked': {
    readonly callId: string
    readonly action: ApprovalAction
    readonly basis: ApprovalBasis
    readonly impact: Impact
    readonly askedAt: number
  }
  'approval/decided': {
    readonly callId: string
    readonly result: ApprovalResult
    /**
     * 谁定的。
     *
     * `auto-denied` 与 `human` 必须能区分：前者是"没有应答者"，后者是"人点了拒绝"。
     * 混在一起会让事后复盘把"没人问"读成"用户拒绝了"（12 §5.5）。
     */
    readonly decidedBy: 'human' | 'auto-denied' | 'cancelled'
    readonly decidedAt: number
  }
  /** 当前动作没有系统级沙箱约束；必须保留，即使用户批准了此次动作。 */
  'sandbox/degraded': { readonly reason: string; readonly mechanism: string }
  /** 某次执行生成的原生约束配置，供回放解释当时的实际边界。 */
  'sandbox/profile': { readonly profile: string; readonly mode: string }
  /** 已闭合回合的文件检查点；快照内容独立保存，日志只保存可审计的索引。 */
  'checkpoint/created': {
    readonly checkpointId: string
    readonly turn: number
    readonly endSeq: number
    readonly files: number
    readonly partial: boolean
    readonly skipped?: readonly { readonly path: string; readonly reason: string }[] | undefined
  }
  /** 恢复文件检查点的事实；追加而非篡改此前的工具或文件事件。 */
  'checkpoint/restored': {
    readonly checkpointId: string
    readonly restoredPaths: readonly string[]
    readonly removedPaths: readonly string[]
  }
  'compaction/start': { readonly compactionId: string }
  'compaction/summary': { readonly compactionId: string; readonly summary: string }
  'compaction/end': { readonly compactionId: string }
}

export type SessionEventType = keyof SessionEventMap

/** 表面操作（D5：压缩的唯一原语；不做删除） */
export type SurfaceOp = 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number }

/**
 * 事件信封（06 §2.1）。
 * seq = log.length（不变量 I2）；time 为 epoch ms（D18）；
 * ignorable 缺省即**不可跳过**——读到不认识的必需事件类型时拒绝重建会话（06 §2.1）。
 */
export interface SessionEventEnvelope<K extends SessionEventType = SessionEventType> {
  readonly type: K
  readonly seq: number
  readonly time: number
  readonly data: SessionEventMap[K]
  /** 仅表面事件携带 */
  readonly surfaceOp?: SurfaceOp
  /** 血缘：更早的 seq 列表（06 §6.2） */
  readonly sourceEventSeqs?: readonly number[]
  /** 向前兼容标记 */
  readonly ignorable?: true
}

/**
 * 日志中的事件。
 *
 * ⚠️ 这里**必须是按 K 分配的映射联合**（`{[P in K]: …}[K]`），不能直接写成
 * `SessionEventEnvelope<K>`：后者是**一个**对象类型，`type` 与 `data` 是彼此独立的
 * 属性，于是 `if (e.type === 'turn/start') e.data.turn` 窄化不了 `data`
 * （TS 会说「Property 'turn' does not exist on UserMessage | …」）。
 * 写成映射联合后 `type` 成为**判别式**，`switch (e.type)` / `e.type === x` 都能正确收窄。
 *
 * 因为 `SessionEventMap` 是开放接口（插件可声明合并新增事件），映射联合会**自动**
 * 把插件新增的事件纳入进来，不需要改这里——这也是 06 §2.2 想要的开放语义。
 */
export type SessionEvent<K extends SessionEventType = SessionEventType> = {
  [P in K]: SessionEventEnvelope<P>
}[K]

/** 追加事件时的输入（seq 由 session 模块分配，调用方不得传入） */
export type EventInput<K extends SessionEventType = SessionEventType> = Omit<
  SessionEventEnvelope<K>,
  'seq' | 'time'
> & {
  readonly time?: number
}

/** 追加后的完整事件（seq / time 已物化） */
export type AppendedEvent<K extends SessionEventType = SessionEventType> = SessionEventEnvelope<K>

/** 表面事件类型集合（06 §3.1：表面只包含这三类事件） */
export const SURFACE_EVENT_TYPES: readonly SessionEventType[] = [
  'user/message',
  'assistant/message',
  'tool/result',
]

export function isSurfaceEventType(type: string): type is 'user/message' | 'assistant/message' | 'tool/result' {
  return type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
}
