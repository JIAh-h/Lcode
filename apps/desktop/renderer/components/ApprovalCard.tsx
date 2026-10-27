import type { ApprovalAction, ApprovalBasis, ApprovalResult, Impact } from '@lcode/session'
import { t } from '../i18n/index.ts'

export interface ApprovalDecision {
  readonly result: ApprovalResult
  readonly decidedBy: 'human' | 'auto-denied' | 'cancelled'
}

export interface ApprovalCardProps {
  readonly callId: string
  readonly action: ApprovalAction
  readonly basis: ApprovalBasis
  readonly impact: Impact
  readonly decision?: ApprovalDecision | undefined
}

function decisionLabel(decision: ApprovalDecision | undefined): string {
  if (decision === undefined) return t('等待你的确认')
  switch (decision.result) {
    case 'allowed-once':
      return t('已允许这一次')
    case 'rejected':
      return t('已拒绝')
    case 'cancelled':
      return t('审批已取消')
    case 'unavailable':
      return t('无人应答，已安全拒绝')
  }
}

function decisionClass(decision: ApprovalDecision | undefined): string {
  if (decision === undefined) return 'pending'
  return decision.result === 'allowed-once' ? 'allowed' : 'denied'
}

/** 会话时间线中的审批审计卡。它只复现已记录的事实，不能改变既有决定。 */
export function ApprovalCard({ callId, action, basis, impact, decision }: ApprovalCardProps) {
  const outside = (impact.paths ?? []).filter((path) => path.outsideWorkspace)
  const inside = (impact.paths ?? []).filter((path) => !path.outsideWorkspace)
  const domains = impact.network?.domains ?? []
  const networkUrl = impact.network?.url

  return (
    <section className="approval-card" aria-label={t('审批记录')}>
      <div className="approval-card-head">
        <span className="approval-card-title">{t('需要审批')}</span>
        <span className={`approval-card-state ${decisionClass(decision)}`}>{decisionLabel(decision)}</span>
      </div>
      <div className="approval-card-summary">{action.summary}</div>
      {action.argv !== undefined ? <pre className="approval-card-command mono">{action.argv.join(' ')}</pre> : null}
      <div className="approval-card-basis">
        {t('依据：')}{basis.presetName === undefined ? basis.reason : `${basis.presetName} · ${basis.reason}`}
      </div>
      {outside.length > 0 ? (
        <div className="approval-card-danger">
          <strong>{t('工作区外文件')}</strong>
          {outside.map((path) => <span className="mono" key={path.path}>{path.mode === 'write' ? '写入' : '读取'} · {path.path}</span>)}
        </div>
      ) : null}
      {domains.length > 0 ? (
        <div className="approval-card-danger">
          <strong>{domains.includes('*') ? t('网络访问') : t('出站网络')}</strong>
          {domains.map((domain) => (
            <span className="mono" key={domain}>
              {domain === '*'
                ? impact.network?.scope === 'terminal'
                  ? t('任意域名（关闭终端前有效）')
                  : t('任意域名（仅本次命令）')
                : domain}
            </span>
          ))}
          {networkUrl === undefined ? null : <span className="mono approval-card-url" title={networkUrl}>{t('请求地址：')}{networkUrl}</span>}
          {domains.includes('*')
            ? <span className="approval-card-basis">{t('OS 只能整段放行：批准后这条命令或终端可访问任意域名，请确认实际执行的命令内容。')}</span>
            : null}
        </div>
      ) : null}
      {inside.length > 0 ? <div className="approval-card-meta">{t('工作区内：')}{inside.map((path) => `${path.mode === 'write' ? '写入' : '读取'} ${path.path}`).join('，')}</div> : null}
      {impact.env !== undefined && impact.env.length > 0 ? <div className="approval-card-meta">{t('环境变量：')}<span className="mono">{impact.env.join(', ')}</span></div> : null}
      {impact.sandboxChange !== undefined ? <div className="approval-card-meta">{t('沙箱：')}{impact.sandboxChange.from} → {impact.sandboxChange.to}</div> : null}
      {impact.sandbox !== undefined ? <div className="approval-card-meta">{t('沙箱降级：')}{impact.sandbox.mechanism} · {impact.sandbox.reason}</div> : null}
      {impact.processScope !== undefined ? <div className="approval-card-meta">{t('进程范围：')}{impact.processScope}</div> : null}
      <span className="approval-card-id mono">{callId}</span>
    </section>
  )
}
