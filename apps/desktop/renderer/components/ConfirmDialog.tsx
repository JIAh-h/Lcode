import { useEffect } from 'react'
import { t } from '../i18n/index.ts'

/** 通用确认框（应用内自绘，不用 window.confirm） */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="modal" style={{ width: 420 }} role="dialog" aria-modal="true">
        <div className="mh">
          <h3 style={{ margin: 0 }}>{title}</h3>
        </div>
        <div className="mb" style={{ fontSize: 13 }}>
          {message}
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
