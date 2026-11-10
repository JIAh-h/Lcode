import { useCallback, useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'

/**
 * 编排状态条（docs/26 §6 / §5.4）。
 *
 * ## 它解决的两个问题
 *
 * 1. **看不见**：Router 派出去的 worker 在后台跑，用户不知道它派了几个、还在不在跑。
 *    没有这个条，用户只会在几分钟后突然收到一条汇报，不知道中间发生了什么。
 * 2. **停不下来**：`orchestration.cancel(taskId)` 早就实现了，但没有出口——
 *    派出去的任务收不回来，这不能上线。
 *
 * ## 为什么只显示"在途"，不显示已完成
 *
 * 已完成的通过 Router 的汇报进入对话流（那是可回放的），状态条只负责"现在还在跑的"。
 * 两者混在一起会让用户分不清"这条是历史还是正在进行"。
 */

interface WorkerView {
  readonly taskId: string
  readonly workerSessionId: string
  readonly state: 'running' | 'settled'
  readonly task: string
  readonly outcome?: 'completed' | 'failed' | 'cancelled' | undefined
  readonly preview?: boolean | undefined
}

interface OrchestrationBridge {
  workers(input: unknown): Promise<unknown>
  cancelWorker(input: unknown): Promise<unknown>
}

function bridge(): OrchestrationBridge | undefined {
  return (globalThis as unknown as { lcode?: { orchestration?: OrchestrationBridge } }).lcode?.orchestration
}

export function OrchestrationBar({ sessionId }: { readonly sessionId: string }) {
  const [workers, setWorkers] = useState<readonly WorkerView[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (api === undefined) return
    try {
      const result = (await api.workers({ routerSessionId: sessionId })) as { workers?: readonly WorkerView[] } | null
      setWorkers(result?.workers ?? [])
    } catch {
      // 会话可能不是 Router，或主进程还没装配好：保持上一次结果即可
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    // 在途状态变化快，但要克制：2s 一次足够看出"还在不在跑"，又不会持续刷 IPC
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const running = workers.filter((worker) => worker.state === 'running')
  const previews = workers.filter((worker) => worker.preview === true)
  if (workers.length === 0) return null

  const cancel = (taskId: string): void => {
    const api = bridge()
    if (api === undefined) return
    setBusy(taskId)
    void api
      .cancelWorker({ taskId })
      .then(() => refresh())
      .catch(() => undefined)
      .finally(() => setBusy(null))
  }

  return (
    <div className="orchbar">
      <button
        type="button"
        className="orchchip"
        aria-expanded={open}
        title={t('编排状态：这里能看到 Router 派出去的 worker')}
        onClick={() => setOpen(!open)}
      >
        <span className="orchdot" aria-hidden="true" />
        <span>{t('worker {n}', { n: running.length })}</span>
        {previews.length > 0 && <span className="orchpreview">{t('预演 {n}', { n: previews.length })}</span>}
      </button>
      {open && (
        <div className="orchpop" role="tooltip">
          <div className="orchpop-head">{t('在途 worker')}</div>
          {running.length === 0 && previews.length === 0 && <div className="orchpop-empty">{t('没有在跑的 worker')}</div>}
          {workers.map((worker) => (
            <div className="orchrow" key={worker.taskId}>
              <span className="orchrow-task" title={worker.task}>
                {worker.task}
              </span>
              <span className={`orchrow-state ${worker.state === 'running' ? 'live' : ''}`}>
                {worker.preview === true
                  ? t('预演')
                  : worker.state === 'running'
                    ? t('运行中')
                    : worker.outcome === 'completed'
                      ? t('已完成')
                      : worker.outcome === 'cancelled'
                        ? t('已取消')
                        : t('失败')}
              </span>
              {worker.state === 'running' && worker.preview !== true && (
                <button
                  type="button"
                  className="mini"
                  disabled={busy === worker.taskId}
                  title={t('取消这个 worker 的当前回合（不影响 Router）')}
                  onClick={() => cancel(worker.taskId)}
                >
                  {t('取消')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
