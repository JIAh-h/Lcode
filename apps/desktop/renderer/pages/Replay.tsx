import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { SessionEvent } from '@lcode/session'
import { t } from '../i18n/index.ts'
import { ToolCard, type ToolCardCall, type ToolCardResult } from '../components/ToolCard.tsx'
import { sessionBridge, type FileCheckpointMeta, type HistorySnapshot, type SessionMeta, type ReplayToolCall } from '../store/sessionBridge.ts'

type Step = {
  readonly turn: number
  readonly step: number
  readonly endSeq: number
}

function stepOf(event: SessionEvent): { turn: number; step: number } | null {
  if (event.type !== 'step/start' && event.type !== 'step/end' && event.type !== 'tool/call') return null
  const data = event.data as { turn?: unknown; step?: unknown }
  return typeof data.turn === 'number' && typeof data.step === 'number' ? { turn: data.turn, step: data.step } : null
}

export function ReplayPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null)
  const [checkpoints, setCheckpoints] = useState<readonly { readonly turn: number; readonly end_seq: number; readonly ended_at: number; readonly reason: string }[]>([])
  const [fileCheckpoints, setFileCheckpoints] = useState<readonly FileCheckpointMeta[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoreMessage, setRestoreMessage] = useState('')
  /** 步骤列表只挂载最近 N 步；长会话里几千个按钮会拖慢首屏 */
  const [stepLimit, setStepLimit] = useState(300)

  useEffect(() => {
    setStepLimit(300)
  }, [sessionId])

  useEffect(() => {
    if (sessionId === undefined) return
    const api = sessionBridge()
    if (api === undefined) return
    let alive = true
    void Promise.all([api.open(sessionId), api.checkpoints({ session_id: sessionId }), api.fileCheckpoints({ session_id: sessionId })]).then(([opened, closed, files]) => {
      if (!alive) return
      setMeta(opened.meta)
      setEvents(opened.events)
      setCheckpoints(closed)
      setFileCheckpoints(files)
    }).catch(() => {
      if (alive) {
        setCheckpoints([])
        setFileCheckpoints([])
      }
    })
    return () => {
      alive = false
    }
  }, [sessionId])

  async function restoreCheckpoint(checkpoint: FileCheckpointMeta): Promise<void> {
    if (sessionId === undefined || restoring !== null) return
    if (!window.confirm(t('确定把工作区恢复到第 {n} 轮的文件状态吗？', { n: checkpoint.turn }))) return
    const api = sessionBridge()
    if (api === undefined) return
    setRestoring(checkpoint.checkpointId)
    setRestoreMessage('')
    try {
      const result = await api.restoreCheckpoint({ session_id: sessionId, checkpoint_id: checkpoint.checkpointId })
      setRestoreMessage(t('已恢复 {n} 个文件，移除 {m} 个后续文件。', { n: result.restoredPaths.length, m: result.removedPaths.length }))
      const [opened, files] = await Promise.all([api.open(sessionId), api.fileCheckpoints({ session_id: sessionId })])
      setEvents(opened.events)
      setMeta(opened.meta)
      setFileCheckpoints(files)
    } catch {
      setRestoreMessage(t('恢复失败，工作区没有被标记为已恢复。'))
    } finally {
      setRestoring(null)
    }
  }

  const provenance = useMemo(() => {
    const found = events.find((item) => item.type === 'session/imported')
    return found !== undefined && found.type === 'session/imported' ? found.data.source : null
  }, [events])

  const steps = useMemo(() => {
    const result: Step[] = []
    for (const event of events) {
      if (event.type !== 'step/end') continue
      const value = stepOf(event)
      if (value !== null) result.push({ ...value, endSeq: event.seq })
    }
    return result
  }, [events])
  /** 10 万事件会话的快照可能有数万条消息；默认只渲染末尾一页，避免一次写几 MB DOM */
  const [showAllMessages, setShowAllMessages] = useState(false)
  useEffect(() => setShowAllMessages(false), [selected, sessionId])
  const messagePreview = useMemo(
    () => (snapshot === null ? [] : snapshot.messages.slice(-20)),
    [snapshot],
  )
  const hiddenSteps = Math.max(0, steps.length - stepLimit)
  const visibleSteps = hiddenSteps === 0 ? steps : steps.slice(hiddenSteps)
  const current = steps.find((step) => `${step.turn}:${step.step}` === selected) ?? steps[steps.length - 1]
  const boundary = current === undefined ? events.length : current.endSeq + 1
  const replayCards = useMemo(() => {
    if (snapshot === null) return []
    return snapshot.toolCalls.map((item: ReplayToolCall) => {
      const resultEvent = events.find((event) => event.type === 'tool/result' && event.data.message.toolCallId === item.call.call_id && event.seq > item.call.seq)
      const call: ToolCardCall = {
        seq: item.call.seq,
        callId: item.call.call_id,
        name: item.call.name,
        arguments: item.call.arguments,
        ...(item.call.card === undefined ? {} : { card: item.call.card }),
      }
      const result: ToolCardResult | undefined = item.result === undefined
        ? undefined
        : {
            message: item.result,
            ...(resultEvent?.type === 'tool/result' && resultEvent.data.meta === undefined ? {} : resultEvent?.type === 'tool/result' ? { meta: resultEvent.data.meta } : {}),
            ...(resultEvent?.type === 'tool/result' && resultEvent.data.error === undefined ? {} : resultEvent?.type === 'tool/result' ? { error: resultEvent.data.error } : {}),
          }
      return { call, result, resultSeq: resultEvent?.type === 'tool/result' ? resultEvent.seq : undefined }
    })
  }, [events, snapshot])

  useEffect(() => {
    if (sessionId === undefined || current === undefined) {
      setSnapshot(null)
      return
    }
    const api = sessionBridge()
    if (api === undefined) return
    let alive = true
    void api
      .history({ session_id: sessionId, up_to_seq: current.endSeq })
      .then((next) => {
        if (alive) setSnapshot(next)
      })
      .catch(() => {
        // 没有模型请求（例如本轮在模型配置校验阶段失败）不是回放页崩溃条件。
        if (alive) setSnapshot(null)
      })
    return () => {
      alive = false
    }
  }, [sessionId, current?.endSeq])

  if (sessionId === undefined) return null
  return (
    <main className="page replay">
      <h2>{t('回放 · {name}', { name: meta?.title || sessionId })}</h2>
      {provenance !== null && (
        <p className="hint" title={provenance.file}>
          {t('导入自 {file} · {bytes} 字节 · SHA-256 {hash} · {time}', {
            file: provenance.file,
            bytes: provenance.bytes,
            hash: provenance.sha256.slice(0, 12),
            time: new Date(provenance.importedAt).toLocaleString(),
          })}
        </p>
      )}
      <div className="replay-layout">
        <div className="replay-list">
          {steps.length === 0 && <div className="pickhint">{t('当前会话还没有完成的步骤')}</div>}
          {hiddenSteps > 0 && (
            <button type="button" className="replay-item" onClick={() => setStepLimit((n) => n * 2)}>
              {t('加载更早的 {n} 步', { n: Math.min(hiddenSteps, stepLimit) })}
            </button>
          )}
          {visibleSteps.map((step) => {
            const key = `${step.turn}:${step.step}`
            return (
              <button
                key={key}
                className={`replay-item${current?.turn === step.turn && current.step === step.step ? ' active' : ''}`}
                onClick={() => setSelected(key)}
              >
                {t('第 {n} 步', { n: step.step })} · {t('第 {n} 轮', { n: step.turn })}
              </button>
            )
          })}
        </div>
        <div className="replay-snapshots">
          <section className="snap checkpoints">
            <h4>{t('已闭合检查点')}</h4>
            {checkpoints.length === 0 ? <div className="pickhint">{t('当前会话还没有可用检查点')}</div> : (
              <div className="checkpoint-list">
                {checkpoints.map((checkpoint) => <span className="checkpoint" key={checkpoint.end_seq}>{t('第 {n} 轮', { n: checkpoint.turn })} · {checkpoint.reason}</span>)}
              </div>
            )}
            {fileCheckpoints.length > 0 && <div className="checkpoint-list file-checkpoints">
              {fileCheckpoints.map((checkpoint) => <div className="checkpoint-row" key={checkpoint.checkpointId}>
                <span className="checkpoint">{t('第 {n} 轮', { n: checkpoint.turn })} · {checkpoint.files.length} {t('个文件')}</span>
                <button className="btn" disabled={restoring !== null || checkpoint.partial} onClick={() => void restoreCheckpoint(checkpoint)}>
                  {restoring === checkpoint.checkpointId ? t('恢复中…') : t('恢复到此状态')}
                </button>
              </div>)}
            </div>}
            {restoreMessage !== '' && <div className="pickhint">{restoreMessage}</div>}
          </section>
          <section className="snap">
            <h4>{t('系统提示（当时的确切内容）')}</h4>
            <pre className="mono">{snapshot === null ? t('该步骤没有记录模型请求') : JSON.stringify(snapshot.header, null, 2)}</pre>
          </section>
          <section className="snap">
            <h4>{t('工具调用')}</h4>
            {replayCards.length === 0 ? <div className="pickhint">{t('该步骤没有工具调用')}</div> : (
              <div className="replay-cards">
                {replayCards.map((item) => <ToolCard key={item.call.callId} sessionId={sessionId} call={item.call} result={item.result} resultSeq={item.resultSeq} />)}
              </div>
            )}
          </section>
          <section className="snap">
            <h4>{t('决策记录')}</h4>
            <pre className="mono">{snapshot === null || snapshot.decisions.length === 0 ? t('该步骤没有权限决策记录') : JSON.stringify(snapshot.decisions, null, 2)}</pre>
          </section>
          <section className="snap">
            <h4>{snapshot === null ? t('模型可见消息') : t('模型可见消息（{n} 条）', { n: snapshot.messages.length })}</h4>
            <pre className="mono">
              {snapshot === null || snapshot.messages.length === 0
                ? t('该步骤没有可见消息')
                : JSON.stringify(showAllMessages ? snapshot.messages : messagePreview, null, 2)}
            </pre>
            {snapshot !== null && snapshot.messages.length > messagePreview.length ? (
              <button className="btn mini" onClick={() => setShowAllMessages((value) => !value)}>
                {showAllMessages
                  ? t('收起完整快照')
                  : t('展开全部 {n} 条', { n: snapshot.messages.length })}
              </button>
            ) : null}
          </section>
        </div>
      </div>
      <div className="page-actions">
        <button
          className="btn primary"
          disabled={current === undefined}
          onClick={() =>
            navigate(`/sessions/${sessionId}/fork`, {
              state: { boundary, step: current?.step ?? 0, title: meta?.title },
            })
          }
        >
          {t('从第 {n} 步重新开始', { n: current?.step ?? 0 })}
        </button>
      </div>
    </main>
  )
}
