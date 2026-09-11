import type { AgentHandle, AgentRef, AgentSpec } from '@lcode/agent'

/**
 * AgentLoop —— 全仓库唯一的具体循环（文档 20 §5.6）。
 * ctx key: `ctx.agentLoop`。
 *
 * ⚠️ 实现纪律（产品宪法第三条 / 不变量 L1）：
 * 本接口的任何实现中，`if` 所判断的内容不得涉及任何具体能力。
 * 协作点（压缩 / 审批 / 上下文注入 / 模型替换）一律通过事件（见 README 协作点表）。
 */
export interface AgentLoop {
  create(spec: AgentSpec): Promise<AgentHandle>
  resume(ref: AgentRef): Promise<AgentHandle>
}

// 骨架占位：批次 ③（23 §14）与 llm-replay 一起落地真实循环。
// 届时实现必须满足：① I6 静态检查（AST 关键词黑名单）；② 无密钥可跑通一次循环。
export function createAgentLoop(): AgentLoop {
  throw new Error(
    'agent-loop 未实现：按文档 23 §14 批次 ③ 落地（llm-replay 驱动、无密钥可跑）。' +
      '实现时遵守 I6：不出现针对具体能力的 if。',
  )
}
