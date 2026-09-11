import type { ApprovalResult } from '@lcode/session'

/** 审批请求（12 §5.4 展示内容规范） */
export interface ApprovalRequest {
  readonly callId: string
  readonly action: string
  readonly basis: string
  readonly impact: { readonly kind: 'write' | 'exec' | 'network' | 'other'; readonly summary: string }
}

/** ApprovalService —— 审批（一次性、fail-closed、不允许永久允许） */
export interface ApprovalService {
  ask(request: ApprovalRequest, opts?: { readonly timeoutMs?: number }): Promise<ApprovalResult>
}

/** ctx key 声明（合并进 @lcode/context） */
declare module '@lcode/context' {
  interface Services {
    approval: ApprovalService
  }
}
