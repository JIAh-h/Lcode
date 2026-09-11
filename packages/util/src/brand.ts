/**
 * 品牌类型（Branded Types）——文档 23 §6.3。
 * "同是 string/number 但语义不同"的值用品牌类型区分，避免传错参数。
 * 全仓库唯一定义处，各包不得重复定义。
 */

/** 全局唯一的会话 id（文档 D17：agent 与会话共享同一个 id） */
export type SessionId = string & { readonly __brand: 'SessionId' }

/** 全局唯一的 agent id；与 SessionId 同值（D17），但语义不同，仍分开标注 */
export type AgentId = string & { readonly __brand: 'AgentId' }

/** 一次工具调用的 id（会话内唯一，文档 22 §5.3） */
export type CallId = string & { readonly __brand: 'CallId' }

/** 事件序号：单调、连续、无空洞，恒等于追加前的日志长度（不变量 I2） */
export type Seq = number & { readonly __brand: 'Seq' }

/** 轮编号（≥1） */
export type TurnNumber = number & { readonly __brand: 'TurnNumber' }

/** 步编号（轮内唯一，≥1） */
export type StepNumber = number & { readonly __brand: 'StepNumber' }

export function asSessionId(v: string): SessionId {
  return v as SessionId
}

export function asAgentId(v: string): AgentId {
  return v as AgentId
}

export function asCallId(v: string): CallId {
  return v as CallId
}

export function asSeq(v: number): Seq {
  return v as Seq
}
