import { useEffect } from 'react'
import { t } from '../i18n/index.ts'

export interface PlanReviewPlan {
  readonly summary: string
  readonly steps: readonly string[]
  readonly risks?: readonly string[] | undefined
}

/** 计划就绪后的确认框：应用内自绘，展示目标/步骤/风险，再决定是否开始执行。 */
export function PlanReviewDialog({
  plan,
  onLater,
  onConfirm,
}: {
  readonly plan: PlanReviewPlan
  /** 关掉弹窗，保持计划模式（chip 仍保留“开始执行”） */
  readonly onLater: () => void
  readonly onConfirm: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onLater()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLater])

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('计划已就绪')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onLater()
      }}
    >
      <div className="modal planreview">
        <div className="mh">
          <h3 style={{ margin: 0 }}>{t('计划已就绪')}</h3>
        </div>
        <div className="mb">
          <div className="sub">{t('模型已提交执行计划，确认后会退出计划模式并立即开始执行。')}</div>
          <div className="planreview-sec">
            <div className="planreview-lab">{t('目标')}</div>
            <div className="planreview-text">{plan.summary}</div>
          </div>
          <div className="planreview-sec">
            <div className="planreview-lab">{t('步骤')}</div>
            <ol className="planreview-list">
              {plan.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          </div>
          {plan.risks !== undefined && plan.risks.length > 0 ? (
            <div className="planreview-sec">
              <div className="planreview-lab">{t('风险')}</div>
              <ul className="planreview-list">
                {plan.risks.map((risk, index) => <li key={index}>{risk}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onLater}>{t('稍后')}</button>
          <button className="btn primary" onClick={onConfirm}>{t('开始执行')}</button>
        </div>
      </div>
    </div>
  )
}
