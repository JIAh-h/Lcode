import type { ReactNode } from 'react'

/** 通用按钮（原型的 .send / .tbtn 语义） */
export function Button({
  children,
  variant = 'default',
  onClick,
  disabled,
}: {
  children: ReactNode
  variant?: 'default' | 'primary' | 'ghost'
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button className={`btn ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

/** 错误条（错误码 → 人话文案的呈现位；用户看到的 message 必须过术语黑名单，UX-COPY-001） */
export function ErrorBanner({ userMessage, details }: { userMessage: string; details?: string }) {
  return (
    <div className="errbanner" role="alert">
      <span>{userMessage}</span>
      {details ? <details className="errdetails">{details}</details> : null}
    </div>
  )
}

/** 询问弹窗（P4）：一次操作 + 依据 + 影响面 + 四个结果 */
export function ApprovalModal({
  action,
  basis,
  impact,
  onResult,
}: {
  action: string
  basis: string
  impact: string
  onResult: (result: 'allowed-once' | 'rejected' | 'cancelled') => void
}) {
  return (
    <div className="modal-mask">
      <div className="modal">
        <h3>确认这一步</h3>
        <p className="m-action">{action}</p>
        <p className="m-basis">依据：{basis}</p>
        <p className="m-impact">影响：{impact}</p>
        <div className="m-actions">
          <button className="btn" onClick={() => onResult('cancelled')}>
            取消
          </button>
          <button className="btn danger" onClick={() => onResult('rejected')}>
            拒绝
          </button>
          <button className="btn primary" onClick={() => onResult('allowed-once')}>
            允许这一次
          </button>
        </div>
      </div>
    </div>
  )
}
