import { useCallback, useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'
import { taskBridge } from '../store/sessionBridge.ts'

type Job = { readonly jobId: string; readonly label: string; readonly status: string }
type Terminal = { readonly terminalId: string; readonly shell: string; readonly cwd: string; readonly exited: boolean }
type TaskSnapshot = { readonly jobs: readonly Job[]; readonly terminals: readonly Terminal[] }

function asSnapshot(value: unknown): TaskSnapshot {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    jobs: Array.isArray(source.jobs) ? source.jobs as readonly Job[] : [],
    terminals: Array.isArray(source.terminals) ? source.terminals as readonly Terminal[] : [],
  }
}

function text(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 当前会话的短生命周期资源观察器。主进程重启后不会假装这些资源可恢复。 */
export function TaskPanel({ sessionId }: { readonly sessionId: string }) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>({ jobs: [], terminals: [] })
  const [selected, setSelected] = useState<{ readonly kind: 'job' | 'terminal'; readonly id: string } | null>(null)
  const [output, setOutput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const api = taskBridge()
    if (api === undefined) return
    try {
      setSnapshot(asSnapshot(await api.list({ session_id: sessionId })))
      setError(null)
    } catch (cause) {
      setError(text(cause))
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const readJob = async (job: Job): Promise<void> => {
    const api = taskBridge()
    if (api === undefined || loading) return
    setLoading(true)
    try {
      const value = await api.readJob({ session_id: sessionId, job_id: job.jobId }) as { output?: unknown }
      setSelected({ kind: 'job', id: job.jobId })
      setOutput(typeof value.output === 'string' ? value.output : '')
      setError(null)
    } catch (cause) {
      setError(text(cause))
    } finally {
      setLoading(false)
    }
  }

  const killJob = async (job: Job): Promise<void> => {
    const api = taskBridge()
    if (api === undefined || loading || (job.status !== 'running' && job.status !== 'stopping')) return
    setLoading(true)
    try {
      await api.killJob({ session_id: sessionId, job_id: job.jobId })
      await refresh()
    } catch (cause) {
      setError(text(cause))
    } finally {
      setLoading(false)
    }
  }

  const readTerminal = async (terminal: Terminal): Promise<void> => {
    const api = taskBridge()
    if (api === undefined || loading) return
    setLoading(true)
    try {
      const value = await api.readTerminal({ session_id: sessionId, terminal_id: terminal.terminalId }) as { data?: unknown }
      setSelected({ kind: 'terminal', id: terminal.terminalId })
      setOutput(typeof value.data === 'string' ? value.data : '')
      setError(null)
    } catch (cause) {
      setError(text(cause))
    } finally {
      setLoading(false)
    }
  }

  const closeTerminal = async (terminal: Terminal): Promise<void> => {
    const api = taskBridge()
    if (api === undefined || loading) return
    setLoading(true)
    try {
      await api.closeTerminal({ session_id: sessionId, terminal_id: terminal.terminalId })
      if (selected?.kind === 'terminal' && selected.id === terminal.terminalId) {
        setSelected(null)
        setOutput('')
      }
      await refresh()
    } catch (cause) {
      setError(text(cause))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rpanel task-panel">
      <div className="rscope">
        <span className="chip">{t('活动任务')}</span>
        <button className="ticon" title={t('刷新')} onClick={() => void refresh()} disabled={loading}>↻</button>
      </div>
      <p className="task-note">{t('后台任务只在当前桌面进程存活；重开后不会恢复。')}</p>
      <section className="task-section">
        <h3>{t('后台作业')}</h3>
        {snapshot.jobs.length === 0 && <div className="pickhint">{t('当前会话没有活动或近期作业')}</div>}
        {snapshot.jobs.map((job) => <div className="task-row" key={job.jobId}>
          <button className="task-main" onClick={() => void readJob(job)} title={t('读取输出')}><span className={`task-state ${job.status}`}>{job.status}</span><span className="task-label">{job.label}</span></button>
          <button className="ticon danger" title={t('停止作业')} onClick={() => void killJob(job)} disabled={loading || (job.status !== 'running' && job.status !== 'stopping')}>■</button>
        </div>)}
      </section>
      <section className="task-section">
        <h3>{t('持久终端')}</h3>
        {snapshot.terminals.length === 0 && <div className="pickhint">{t('当前会话没有打开的终端')}</div>}
        {snapshot.terminals.map((terminal) => <div className="task-row" key={terminal.terminalId}>
          <button className="task-main" onClick={() => void readTerminal(terminal)} title={t('读取终端输出')}><span className={`task-state ${terminal.exited ? 'completed' : 'running'}`}>{terminal.exited ? t('已退出') : terminal.shell}</span><span className="task-label">{terminal.cwd}</span></button>
          <button className="ticon danger" title={t('关闭终端')} onClick={() => void closeTerminal(terminal)} disabled={loading}>×</button>
        </div>)}
      </section>
      {selected !== null && <pre className="task-output mono">{output || t('（暂无新增输出）')}</pre>}
      {error !== null && <div className="toolcard-feedback tool-error">{error}</div>}
    </div>
  )
}
