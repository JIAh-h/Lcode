import type { ApprovalAction, ApprovalBasis, ApprovalResult, Impact } from '@lcode/session'

/**
 * ApprovalService —— 审批（12 §5）。
 *
 * ## 四条硬性语义
 *
 * | 语义 | 含义 | 出处 |
 * |---|---|---|
 * | **一次性** | 内核**没有**"记住这个选择"的状态位；要"永久"就显式换预设 | 12 §5.1 |
 * | **fail-closed** | 无应答者 / 无通道 / 已取消 / 无 agent 归属 → `unavailable` → **不执行** | 12 §5.2（D11） |
 * | **三段齐备** | `action` / `basis` / `impact` 缺一不可（`SEC-APPROVAL-003`） | 12 §5.4 |
 * | **两个事件都落盘** | `approval/asked` + `approval/decided`，落盘 = 是 | 12 §5.5 |
 *
 * ## 为什么 `ask` 不抛错来表示"没人应答"
 *
 * `unavailable` 是一个**正常结果**，不是异常：CLI 无人值守、子代理不能直接问人、
 * 请求已被取消——这些都该让流水线继续走到"拒绝执行并把结构化错误交给模型"，
 * 而不是让一个异常穿到引擎里（那会终结整轮，违反"工具失败永不终结轮"）。
 */

/** 审批请求：三段齐备（12 §5.4） */
export interface ApprovalRequest {
  /** 与 `tool/call` 的 `callId` 配对（I3 的配对锚点） */
  readonly callId: string
  readonly action: ApprovalAction
  readonly basis: ApprovalBasis
  readonly impact: Impact
}

/**
 * 应答通道 —— **由接入层提供**（桌面走 IPC，CLI 走终端提示，无人值守没有）。
 *
 * 分离出来是刻意的：`approval` 这个包**不知道**用户界面长什么样。它只负责
 * "问一次、等一个答案、落两个事件"。
 */
export interface ApprovalChannel {
  /**
   * 把问题交给用户。
   *
   * 返回 `undefined` = **没有应答者**（通道关闭、用户没界面、子代理等）→ fail-closed。
   * 这个区分很重要：抛错会被当成"通道坏了"而重试或上浮，而"没人应答"是一个事实。
   */
  ask(request: ApprovalRequest): Promise<ApprovalResult | undefined>
}

export interface ApprovalAskOpts {
  /**
   * 等多久算"没人应答"。
   *
   * **省略 = 不限时**（21 §2.4：`approval.request` 无固定超时）。这是对的：
   * 用户可能正在读那段 diff，给他设一个 30s 的钟会把"我在看"变成"被拒了"。
   */
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
}

export interface ApprovalService {
  /**
   * 问一次。
   *
   * 返回四态之一：`allowed-once` / `rejected` / `cancelled` / `unavailable`。
   * **只有 `allowed-once` 表示可以继续**——其余三态调用方都必须拒绝执行本次动作。
   */
  ask(request: ApprovalRequest, opts?: ApprovalAskOpts): Promise<ApprovalResult>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    approval: ApprovalService
  }
}
