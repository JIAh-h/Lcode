import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { t } from '../i18n/index.ts'
import { sessionBridge } from '../store/sessionBridge.ts'

export function RecoveryPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [repaired, setRepaired] = useState(false)
  const [closers, setClosers] = useState<readonly { type: string }[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (sessionId === undefined) return
    const api = sessionBridge()
    if (api === undefined) {
      setError(t('当前环境没有主进程桥'))
      return
    }
    let alive = true
    void api
      .open(sessionId)
      .then((opened) => {
        if (!alive) return
        setRepaired(opened.repaired)
        setClosers(opened.closers)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : t('无法恢复这个对话'))
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  return (
    <main className="page">
      <h2>{repaired ? t('上次没有正常退出') : t('会话状态正常')}</h2>
      {error !== null ? (
        <div className="sserror">{error}</div>
      ) : repaired ? (
        <>
          <p>{t('已经恢复到最后一个完整状态，恢复事件已写回会话日志。')}</p>
          <div className="recovery-summary">
            <div>{t('恢复时补全的记录：{n} 条', { n: closers.length })}</div>
            <div>{closers.map((closer) => closer.type).join(' → ')}</div>
          </div>
        </>
      ) : (
        <p>{t('没有发现需要补记的中断结构。')}</p>
      )}
      <div className="page-actions">
        <button className="btn primary" onClick={() => navigate(sessionId === undefined ? '/' : `/sessions/${sessionId}`)}>
          {t('继续这个对话')}
        </button>
      </div>
    </main>
  )
}
