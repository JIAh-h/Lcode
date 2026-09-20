import { useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { t } from '../i18n/index.ts'
import { notifySessionChanged, sessionBridge } from '../store/sessionBridge.ts'

export function ForkPage() {
  const { sessionId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as {
    boundary?: unknown
    step?: unknown
    title?: unknown
  } | null
  const boundary = typeof state?.boundary === 'number' ? state.boundary : null
  const step = typeof state?.step === 'number' ? state.step : 0
  const title = typeof state?.title === 'string' && state.title !== '' ? state.title : t('当前会话')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fork = async () => {
    if (sessionId === undefined || boundary === null) return
    const api = sessionBridge()
    if (api === undefined) {
      setError(t('当前环境没有主进程桥'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.fork({ source_session_id: sessionId, boundary })
      notifySessionChanged()
      navigate(`/sessions/${result.session_id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('无法从这一步重新开始'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page">
      <h2>{t('从第 {n} 步重新开始', { n: step })}</h2>
      <div className="fork-detail">
        <div>
          <b>{t('从哪开始')}</b>：{boundary === null ? t('没有选择有效的步骤') : t('第 {n} 步的已完成边界', { n: step })}
        </div>
        <div>
          <b>{t('会带过去')}</b>：{t('截至该步骤的完整记录（当时模型看到的原样）')}
        </div>
        <div>
          <b>{t('不会带过去')}</b>：{t('该步骤之后的全部内容')}
        </div>
        <div>
          <b>{t('新对话的名字')}</b>：{t('{name}（副本）', { name: title })}
        </div>
      </div>
      <p>{t('原来的对话不会被改动，可以随时回来查看。')}</p>
      {error !== null && <div className="sserror">{error}</div>}
      <div className="page-actions">
        <button className="btn" onClick={() => navigate(sessionId === undefined ? '/' : `/sessions/${sessionId}/replay`)}>
          {t('取消')}
        </button>
        <button className="btn primary" disabled={busy || boundary === null} onClick={() => void fork()}>
          {busy ? t('正在创建…') : t('从这里重新开始')}
        </button>
      </div>
    </main>
  )
}
