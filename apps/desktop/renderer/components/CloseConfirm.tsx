import { useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'

/**
 * 关闭窗口确认（自绘，不用系统对话框）。
 *
 * 系统 `dialog.showMessageBox` 的观感与自绘界面完全脱节，所以由主进程发
 * `lcode:app.close-request`，这里用应用内 `.overlay/.modal` 呈现，回答走
 * `app:close-answer`。主进程仍有 4 秒原生兜底，避免渲染层卡死时窗口关不掉。
 */
export function CloseConfirm() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    return window.lcode.onCloseRequest(() => {
      setRemember(false)
      setOpen(true)
      void window.lcode.ackClose()
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      void window.lcode.answerClose({ decision: 'cancel', remember })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, remember])

  const answer = (decision: 'cancel' | 'minimize' | 'quit'): void => {
    setOpen(false)
    void window.lcode.answerClose({ decision, remember })
  }

  if (!open) return null
  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) answer('cancel')
      }}
    >
      <div className="modal" style={{ width: 430 }} role="dialog" aria-modal="true" aria-labelledby="close-confirm-title">
        <div className="mh">
          <h3 id="close-confirm-title" style={{ margin: 0 }}>
            {t('关闭 Lcode')}
          </h3>
        </div>
        <div className="mb" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13.5 }}>{t('要关闭 Lcode 窗口吗？')}</div>
          <div className="hint">{t('最小化后 Vite 与主进程 watch 会继续运行；退出应用会停止正在进行的工作。')}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            {t('不再询问')}
          </label>
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => answer('cancel')}>
            {t('取消')}
          </button>
          <button className="btn primary" onClick={() => answer('minimize')}>
            {t('最小化')}
          </button>
          <button className="btn danger" onClick={() => answer('quit')}>
            {t('退出应用')}
          </button>
        </div>
      </div>
    </div>
  )
}
