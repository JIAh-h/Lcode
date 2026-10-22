import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { SessionEvent } from '@lcode/session'
import { ComposerBar, withAttachments, type Attachment } from '../components/ComposerBar.tsx'
import { ContextBar } from '../components/ContextBar.tsx'
import { SessionStream } from '../components/SessionStream.tsx'
import { SessionActionsMenu } from '../components/SessionActionsMenu.tsx'
import { TaskPanel } from '../components/TaskPanel.tsx'
import { toast } from '../components/toast.ts'
import { t } from '../i18n/index.ts'
import { agentBridge, notifySessionChanged, planBridge, sessionBridge, workspaceInfoBridge, workspaceTrustBridge, type QueuedMessage, type SessionContextUsage, type SessionMeta, type WorkspaceGitInfo } from '../store/sessionBridge.ts'

type Tab = 'changes' | 'files' | 'tasks'
type Change = {
  readonly path: string
  readonly kind: string
  readonly additions: number
  readonly deletions: number
  readonly seq: number
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** IPC 只保留 message，错误码会在序列化时丢掉，所以按稳定文案判断 */
function isSessionGone(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('ES-SESSION_NOT_FOUND') || message.includes('会话不存在或日志缺失')
}

function changesFrom(events: readonly SessionEvent[]): readonly Change[] {
  const changes: Change[] = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const data = record(event.data)
    const meta = record(data?.['meta'])
    const raw = meta?.['changes']
    if (meta?.['card'] !== 'diff' || !Array.isArray(raw)) continue
    for (const value of raw) {
      const item = record(value)
      if (typeof item?.['path'] !== 'string' || typeof item['kind'] !== 'string') continue
      changes.push({
        path: item['path'],
        kind: item['kind'],
        additions: typeof item['additions'] === 'number' ? item['additions'] : 0,
        deletions: typeof item['deletions'] === 'number' ? item['deletions'] : 0,
        seq: event.seq,
      })
    }
  }
  return changes
}

function planActiveFrom(events: readonly SessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if (event.type === 'plan/mode') active = event.data.active
  }
  return active
}

function planReadyFrom(events: readonly SessionEvent[]): boolean {
  let active = false
  let ready = false
  for (const event of events) {
    if (event.type === 'plan/mode') {
      active = event.data.active
      if (active) ready = false
    }
    if (active && event.type === 'plan/proposed') ready = true
  }
  return active && ready
}

function workspaceTrustFrom(events: readonly SessionEvent[]): { readonly workspace: string; readonly trusted: boolean } | null {
  let current: { readonly workspace: string; readonly trusted: boolean } | null = null
  for (const event of events) {
    if (event.type === 'workspace/trust') current = event.data
  }
  return current
}

/** 主操作只由持久会话边界派生，避免流式 UI 本地状态卡在“运行中”。 */
function primaryActionFrom(events: readonly SessionEvent[]): 'send' | 'pause' | 'resume' {
  const boundary = [...events].reverse().find((event) => event.type === 'turn/start' || event.type === 'turn/end')
  if (boundary?.type === 'turn/start') return 'pause'
  if (boundary?.type === 'turn/end' && boundary.data.reason === 'cancelled') return 'resume'
  return 'send'
}

function RightPanel({
  tab,
  setTab,
  changes,
  workspace,
  sessionId,
}: {
  readonly tab: Tab
  readonly setTab: (tab: Tab) => void
  readonly changes: readonly Change[]
  readonly workspace: string | null
  readonly sessionId: string
}) {
  const [openFile, setOpenFile] = useState<string | null>(changes[0]?.path ?? null)
  const files = [...new Set(changes.map((change) => change.path))]
  return (
    <aside className="right">
      <div className="rtabs">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          {t('变更')}
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          {t('文件')}
        </button>
        <button className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>
          {t('任务')}
        </button>
      </div>
      {tab === 'tasks' ? <TaskPanel sessionId={sessionId} /> : tab === 'changes' ? (
        <div className="rpanel">
          <div className="rscope">
            <span className="chip">{t('事件投影')}</span> {t('{n} 个文件改动', { n: files.length })}
          </div>
          {changes.length === 0 && <div className="pickhint">{t('当前会话还没有记录文件变更')}</div>}
          {changes.map((change) => (
            <div className={'fitem' + (openFile === change.path ? ' open' : '')} key={`${change.seq}-${change.path}`}>
              <div className="frow" onClick={() => setOpenFile(openFile === change.path ? null : change.path)}>
                <span className="fn">{change.path}</span>
                <span className="fs">
                  <span className="add">+{change.additions}</span> <span className="del">-{change.deletions}</span>
                </span>
              </div>
              {openFile === change.path && <pre className="fdiff mono">{JSON.stringify(change, null, 2)}</pre>}
            </div>
          ))}
        </div>
      ) : (
        <div className="rpanel">
          <div className="rscope">
            <span className="chip">{t('工作区')}</span> {workspace ?? t('未设置')}
          </div>
          {files.length === 0 && <div className="pickhint">{t('当前会话还没有文件记录')}</div>}
          {files.map((file) => (
            <div className="fitem" key={file}>
              <div className="frow">
                <span className="fn">{file}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

export function WorkspacePage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('changes')
  const [text, setText] = useState('')
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [queued, setQueued] = useState<readonly QueuedMessage[]>([])
  const [readOnlyConfirmedFor, setReadOnlyConfirmedFor] = useState<string | null>(null)
  /** 回退重发会就地截断日志：本页那份事件副本必须整体重读，否则右栏还挂着已撤回的变更 */
  const [reloadEpoch, setReloadEpoch] = useState(0)
  /** 输入框状态栏：上下文占用与 Git 信息 */
  const [usage, setUsage] = useState<SessionContextUsage | null>(null)
  const [gitInfo, setGitInfo] = useState<WorkspaceGitInfo | null>(null)
  const [usageEpoch, setUsageEpoch] = useState(0)
  const [compacting, setCompacting] = useState(false)

  useEffect(() => {
    if (sessionId === undefined) return
    const api = sessionBridge()
    if (api === undefined) return
    let alive = true
    let ready = false
    const buffered: SessionEvent[] = []
    const stop = api.onEvent((payload) => {
      const item = record(payload)
      if (!alive || item?.['session_id'] !== sessionId || !record(item['event'])) return
      const event = item['event'] as SessionEvent
      if (!ready) buffered.push(event)
      else setEvents((prev) => (prev.some((current) => current.seq === event.seq) ? prev : [...prev, event]))
      // 轮结束 / 压缩事务结束都会改变表面或 system 占用：刷新状态栏
      if (event.type === 'turn/end' || event.type === 'compaction/end') setUsageEpoch((n) => n + 1)
    })
    void api
      .open(sessionId)
      .then((opened) => {
        if (!alive) return
        setMeta(opened.meta)
        if (opened.meta.deleted_at !== null) {
          // 归档（软删）的会话不属于工作台：切到同工作区的活跃会话；
          // 一个都没有就打开该工作区的新建会话页。否则继续发送会写进一个侧栏看不到的会话。
          void (async () => {
            const bridge = sessionBridge()
            try {
              if (bridge !== undefined) {
                const workspace = opened.meta.workspace
                const siblings = await bridge.list({
                  ...(workspace === null || workspace === '' ? {} : { workspace }),
                  limit: 50,
                })
                const next = siblings.items.find(
                  (item) => item.session_id !== sessionId && item.deleted_at === null,
                )
                if (next !== undefined) {
                  toast(t('该会话已归档，已切换到同工作区的其他会话'))
                  navigate(`/sessions/${next.session_id}`, { replace: true })
                  return
                }
              }
            } catch {
              // 列表拿不到就回落到新建会话页
            }
            toast(t('该会话已归档，已为你打开该工作区的新会话'))
            const workspace = opened.meta.workspace
            navigate('/', {
              replace: true,
              ...(workspace === null || workspace === '' ? {} : { state: { cwd: workspace } }),
            })
          })()
          return
        }
        const merged = [...opened.events, ...buffered].sort((a, b) => a.seq - b.seq)
        setEvents(merged.filter((event, index) => index === 0 || event.seq !== merged[index - 1]!.seq))
        ready = true
      })
      .catch((err: unknown) => {
        if (!alive) return
        if (isSessionGone(err)) {
          // 路由可能指向刚被永久归档（或从别处删除）的会话：回首页，不留一个死页面
          navigate('/', { replace: true })
          toast(t('这个会话已不存在，可能已被永久归档'))
          return
        }
        toast(err instanceof Error ? err.message : t('打开会话失败'))
      })
    return () => {
      alive = false
      stop()
    }
  }, [sessionId, reloadEpoch])

  const changes = useMemo(() => changesFrom(events), [events])
  const planActive = useMemo(() => planActiveFrom(events), [events])
  const planReady = useMemo(() => planReadyFrom(events), [events])
  const workspaceTrust = useMemo(() => workspaceTrustFrom(events), [events])
  const composerAction = useMemo(() => primaryActionFrom(events), [events])
  const agentRunning = composerAction === 'pause'

  // 状态栏：上下文占用。轮结束、压缩结束、发送成功后各刷新一次（不逐 chunk 轮询）。
  useEffect(() => {
    if (sessionId === undefined) return
    const api = sessionBridge()
    if (api === undefined) return
    let alive = true
    void api
      .contextUsage(sessionId)
      .then((next) => {
        if (alive) setUsage(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [sessionId, usageEpoch, composerAction])

  useEffect(() => {
    const workspace = meta?.workspace
    if (workspace === null || workspace === undefined || workspace === '') {
      setGitInfo(null)
      return
    }
    const bridge = workspaceInfoBridge()
    if (bridge === undefined) return
    let alive = true
    void bridge
      .gitInfo(workspace)
      .then((info) => {
        if (alive) setGitInfo(info)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [meta?.workspace, reloadEpoch])

  const compactContext = (): void => {
    if (sessionId === undefined || compacting) return
    const api = sessionBridge()
    if (api === undefined) return
    setCompacting(true)
    void api
      .compact(sessionId)
      .then((result) => {
        setUsageEpoch((n) => n + 1)
        if (result.status === 'compacted') {
          toast(t('已压缩上下文：{before} → {after} 字符', { before: result.originalChars, after: result.summaryChars }))
        } else if (result.status === 'not-beneficial') {
          toast(t('这段历史已经很短，没有可省的'))
        } else {
          toast(t('当前没有可安全压缩的范围'))
        }
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : t('压缩上下文失败'))
      })
      .finally(() => setCompacting(false))
  }

  const refreshQueue = (): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) return
    void api.queue.list({ session_id: sessionId }).then(({ items }) => setQueued(items)).catch(() => setQueued([]))
  }

  useEffect(() => {
    refreshQueue()
  // 队列不是持久事件；只在轮边界刷新，避免每个流式 chunk 都触发 IPC。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentRunning, events.filter((event) => event.type === 'turn/start' || event.type === 'turn/end').map((event) => event.seq).join(',')])
  const send = (attachments: readonly Attachment[] = []) => {
    const value = text.trim()
    if (value === '' || sessionId === undefined) return
    if (meta?.deleted_at !== null && meta?.deleted_at !== undefined) {
      toast(t('该会话已归档，无法发送'))
      return
    }
    const api = agentBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法发送'))
      return
    }
    setText('')
    void api
      .send({ session_id: sessionId, text: withAttachments(value, attachments) })
      .then(() => {
        refreshQueue()
        notifySessionChanged()
        setUsageEpoch((n) => n + 1)
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : t('发送失败'))
      })
  }

  const runPrimaryAction = (): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法发送'))
      return
    }
    if (composerAction === 'pause') {
      void api.cancel(sessionId).catch((err: unknown) => {
        toast(err instanceof Error ? err.message : t('暂停失败'))
      })
      return
    }
    if (composerAction === 'resume') {
      void api.resume(sessionId).then(() => notifySessionChanged()).catch((err: unknown) => {
        toast(err instanceof Error ? err.message : t('继续失败'))
      })
      return
    }
    send()
  }

  const planAction = (): void => {
    if (sessionId === undefined) return
    const api = planBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法切换计划模式'))
      return
    }
    const action = planActive ? api.confirm({ session_id: sessionId }) : api.enter({ session_id: sessionId })
    void action.then(() => {
      if (planActive) toast(t('计划已确认，开始执行'))
      notifySessionChanged()
    }).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : t('切换计划模式失败'))
    })
  }

  const guideQueued = (queueId: string): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法引导任务'))
      return
    }
    void api.queue.guide({ session_id: sessionId, queue_id: queueId }).then(({ guided }) => {
      if (guided) toast(t('已加入当前任务，将在下一步生效'))
      else toast(t('该消息已开始处理，无法再转为引导'))
      refreshQueue()
      notifySessionChanged()
    }).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : t('引导失败'))
    })
  }

  const editQueued = (queueId: string, value: string): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) return
    void api.queue.edit({ session_id: sessionId, queue_id: queueId, text: value }).then(({ updated }) => {
      if (!updated) toast(t('该消息已开始处理，无法编辑'))
      refreshQueue()
    }).catch((err: unknown) => toast(err instanceof Error ? err.message : t('编辑失败')))
  }

  const removeQueued = (queueId: string): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) return
    void api.queue.remove({ session_id: sessionId, queue_id: queueId }).then(() => refreshQueue()).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : t('移除失败'))
    })
  }

  const clearQueued = (): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) return
    void api.queue.clear({ session_id: sessionId }).then(({ removed }) => {
      if (removed > 0) toast(t('已关闭待发送队列'))
      refreshQueue()
    }).catch((err: unknown) => toast(err instanceof Error ? err.message : t('关闭队列失败')))
  }

  const trustWorkspace = (): void => {
    if (sessionId === undefined || workspaceTrust === null) return
    const api = workspaceTrustBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法更新工作区信任'))
      return
    }
    void api.set({ workspace: workspaceTrust.workspace, trusted: true, session_id: sessionId }).then(() => {
      setReadOnlyConfirmedFor(sessionId)
      toast(t('已信任此文件夹'))
    }).catch((err: unknown) => toast(err instanceof Error ? err.message : t('更新工作区信任失败')))
  }

  if (sessionId === undefined) return null
  const workspaceLabel =
    meta?.workspace === null || meta?.workspace === undefined || meta.workspace === ''
      ? t('未设置工作区')
      : (meta.workspace.split(/[\\/]/).filter(Boolean).pop() ?? meta.workspace)
  const shouldConfirmTrust = workspaceTrust !== null && !workspaceTrust.trusted && readOnlyConfirmedFor !== sessionId
  return (
    <div className="workspace">
      <div className="wstitlebar">
        <span className="wscumb">
          {workspaceLabel} / {meta?.title || t('未命名会话')}
        </span>
        <SessionActionsMenu
          session={{ session_id: sessionId, title: meta?.title ?? '' }}
          buttonClass="wstitleact"
          onRenamed={(title) => setMeta((prev) => (prev === null ? prev : { ...prev, title }))}
          onRemoved={() => navigate('/')}
        />
        <span className="wsp" />
        <button className="ticon" title={t('回放时间轴')} onClick={() => navigate(`/sessions/${sessionId}/replay`)}>
          ⏱
        </button>
        <button
          className={'ptoggle' + (panelOpen ? ' on' : '')}
          title={t('显示/隐藏面板')}
          aria-pressed={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="10" y="2.5" width="4.5" height="11" rx="1" fill="currentColor" opacity=".28" />
          </svg>
        </button>
      </div>
      <div className="wsrow">
        <div className="mid">
          <div className="stream">
            <div className="col">
              <SessionStream
                sessionId={sessionId}
                onRewound={() => setReloadEpoch((n) => n + 1)}
              />
            </div>
          </div>
          <div className="cinput">
            <div className="cin">
              {workspaceTrust !== null && !workspaceTrust.trusted ? (
                <div className="workspace-untrusted" role="status">
                  <span>{t('此工作区未受信任：当前只能读取文件，写入和命令已被禁用。')}</span>
                  <button title={t('授予此文件夹写入和命令执行权限')} onClick={trustWorkspace}>{t('信任此文件夹')}</button>
                </div>
              ) : null}
              <ComposerBar
                value={text}
                onChange={setText}
                onSend={send}
                primaryAction={composerAction}
                onPrimaryAction={runPrimaryAction}
                sendTitle="发送"
                placeholder={t(planActive ? '只读探索中：描述你希望先了解什么…' : '继续交代任务，或补充新的要求…（运行中也可以输入，会在下一步生效）')}
                planActive={planActive}
                planReady={planReady}
                onPlanAction={planAction}
                queued={queued}
                onGuideQueued={guideQueued}
                onEditQueued={editQueued}
                onRemoveQueued={removeQueued}
                onClearQueued={clearQueued}
                footer={
                  <ContextBar
                    workspace={meta?.workspace ?? null}
                    branch={gitInfo?.branch ?? null}
                    mode={gitInfo?.mode ?? 'local'}
                    usage={usage}
                    compacting={compacting}
                    running={agentRunning}
                    onCompact={compactContext}
                    onOpenSettings={() => navigate('/settings', { state: { sec: 'providers' } })}
                  />
                }
              />
            </div>
          </div>
        </div>
        {panelOpen && <RightPanel tab={tab} setTab={setTab} changes={changes} workspace={meta?.workspace ?? null} sessionId={sessionId} />}
      </div>
      {shouldConfirmTrust ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="workspace-trust-title">
          <div className="modal" style={{ width: 500 }}>
            <div className="mh">
              <h3 id="workspace-trust-title" style={{ margin: 0 }}>{t('信任此文件夹？')}</h3>
            </div>
            <div className="mb" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span>{t('未信任的文件夹只能读取。信任后，模型可以在此文件夹中修改文件并执行命令。')}</span>
              <span className="src mono">{workspaceTrust.workspace}</span>
            </div>
            <div className="mf" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setReadOnlyConfirmedFor(sessionId)}>{t('保持只读')}</button>
              <button className="btn primary" onClick={trustWorkspace}>{t('信任此文件夹')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
