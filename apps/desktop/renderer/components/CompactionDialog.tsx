import { useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'
import { sessionBridge, type CompactionPreview, type CompactResult } from '../store/sessionBridge.ts'
import { toast } from './toast.ts'

/**
 * 手动压缩确认框：先让用户看到"压哪一段、摘要长什么样、省了多少"，
 * 再决定是否提交。摘要本身要花一次模型调用，所以预览失败时保持原样、不写日志。
 */
export function CompactionDialog({
  sessionId,
  onClose,
  onChanged,
}: {
  readonly sessionId: string
  readonly onClose: () => void
  readonly onChanged: () => void
}) {
  const [keepTurns, setKeepTurns] = useState(2)
  const [preview, setPreview] = useState<CompactionPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestedTurns, setRequestedTurns] = useState(keepTurns)

  useEffect(() => {
    const api = sessionBridge()
    if (api === undefined) {
      setError(t('当前环境没有主进程桥'))
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    void api
      .compactPreview({ session_id: sessionId, keep_recent_turns: requestedTurns })
      .then((next) => {
        if (alive) setPreview(next)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setPreview(null)
        setError(err instanceof Error ? err.message : t('无法生成压缩预览'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [sessionId, requestedTurns])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applying, onClose])

  const apply = (): void => {
    if (preview === null || applying) return
    const api = sessionBridge()
    if (api === undefined) return
    setApplying(true)
    void api
      .compactApply({ session_id: sessionId, preview_id: preview.previewId })
      .then((result: CompactResult) => {
        if (result.status === 'compacted') {
          toast(t('已压缩上下文：{before} → {after} 字符', { before: result.originalChars, after: result.summaryChars }))
          onChanged()
          onClose()
          return
        }
        if (result.status === 'not-beneficial') toast(t('这段历史已经很短，没有可省的'))
        else if (result.status === 'pinned-turn') toast(t('压缩范围碰到了固定轮次，请调整保留轮次'))
        else toast(t('当前没有可安全压缩的范围'))
        onChanged()
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : t('压缩失败'))
      })
      .finally(() => setApplying(false))
  }

  const pinned = preview?.plan.pinnedTurns ?? 0
  const maxKeep = Math.max(1, (preview?.plan.totalTurns ?? 2) - 1)
  const dirty = keepTurns !== requestedTurns
  // 摘要与范围是成对生成的：改了保留轮次必须重新预览，不能拿旧摘要套新区间
  const canApply = preview !== null && !loading && !applying && !dirty && preview.plan.compactedItems > 0

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget && !applying) onClose()
      }}
    >
      <div className="modal" style={{ width: 620 }} role="dialog" aria-modal="true" aria-label={t('压缩上下文')}>
        <div className="mh">
          <h3 style={{ margin: 0 }}>{t('压缩上下文')}</h3>
        </div>
        <div className="mb" style={{ fontSize: 13 }}>
          {loading ? (
            <div className="cmpop-loading"><span className="spin" /> {t('正在生成摘要预览…')}</div>
          ) : error !== null ? (
            <div className="sserror">{error}</div>
          ) : preview !== null ? (
            <>
              <div className="cmpop-rows">
                <div className="cmrow"><span>{t('将压缩')}</span><b>{t('{n} 条消息', { n: preview.plan.compactedItems })}</b></div>
                <div className="cmrow"><span>{t('保留最近')}</span><b>{t('{n} 轮', { n: preview.plan.keptTurns })}</b></div>
                <div className="cmrow"><span>{t('原始长度')}</span><b>{t('{n} 字符', { n: preview.plan.prefixChars })}</b></div>
                <div className="cmrow"><span>{t('摘要长度')}</span><b>{t('{n} 字符', { n: preview.summaryChars })}</b></div>
                <div className="cmrow"><span>{t('固定轮次')}</span><b>{pinned === 0 ? t('无') : t('{n} 轮（不会被压缩）', { n: pinned })}</b></div>
              </div>
              <label className="cmpop-range">
                <span>{t('保留最近轮次')}</span>
                <input
                  type="range"
                  min={1}
                  max={maxKeep}
                  value={Math.min(keepTurns, maxKeep)}
                  onChange={(event) => setKeepTurns(Number(event.currentTarget.value))}
                />
                <b>{keepTurns}</b>
                <button
                  type="button"
                  className="btn mini"
                  disabled={!dirty || loading}
                  onClick={() => setRequestedTurns(keepTurns)}
                >
                  {t('重新生成')}
                </button>
              </label>
              <div className="cmpop-summary">{preview.summary}</div>
              <div className="cmpop-note">
                {t('原始事件仍保留在日志中；应用后会替换当前模型可见的历史。')}
                {preview.plan.pinnedTurns > 0 ? t(' 固定轮次及其后的内容不会进入摘要。') : ''}
              </div>
            </>
          ) : null}
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" disabled={applying} onClick={onClose}>{t('取消')}</button>
          <button className="btn primary" disabled={!canApply} onClick={apply}>
            {applying ? t('正在压缩…') : dirty ? t('请先重新生成预览') : t('应用压缩')}
          </button>
        </div>
      </div>
    </div>
  )
}
