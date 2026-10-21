import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n/index.ts'
import { TextInput } from './controls.tsx'

/** 重命名会话（应用内自绘，不用 window.prompt） */
export function RenameDialog({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string
  onCancel: () => void
  onSubmit: (title: string) => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = (): void => {
    const title = value.trim()
    if (title !== '') onSubmit(title)
  }

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="modal" style={{ width: 420 }} role="dialog" aria-modal="true">
        <div className="mh">
          <h3 style={{ margin: 0 }}>{t('重命名会话')}</h3>
        </div>
        <div className="mb">
          <TextInput value={value} onChange={setValue} onEnter={submit} inputRef={inputRef} placeholder={t('会话标题')} />
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
          <button className="btn primary" disabled={value.trim() === ''} onClick={submit}>
            {t('保存')}
          </button>
        </div>
      </div>
    </div>
  )
}
