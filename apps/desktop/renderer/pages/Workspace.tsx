import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { PlanArtifact, SessionEvent, TodoItem } from '@lcode/session'
import { ComposerBar, type ComposerSendInput } from '../components/ComposerBar.tsx'
import { ContextBar } from '../components/ContextBar.tsx'
import { CompactionDialog } from '../components/CompactionDialog.tsx'
import { PlanReviewDialog } from '../components/PlanReviewDialog.tsx'
import { SessionStream } from '../components/SessionStream.tsx'
import { TurnStatusBar } from '../components/TurnStatusBar.tsx'
import { FileTree, type FileMarker } from '../components/FileTree.tsx'
import { SessionActionsMenu } from '../components/SessionActionsMenu.tsx'
import { PanelSplitter, useResizablePanel } from '../components/PanelSplitter.tsx'
import { TaskPanel } from '../components/TaskPanel.tsx'
import { toast } from '../components/toast.ts'
import { t } from '../i18n/index.ts'
import { agentBridge, notifySessionChanged, planBridge, sessionBridge, workspaceInfoBridge, workspaceTrustBridge, type GitDiffResult, type GitStatusFile, type QueuedMessage, type SessionContextUsage, type SessionMeta, type WorkspaceGitInfo, type WorkspaceGitStatus } from '../store/sessionBridge.ts'
import { agentPresetLabel, getAgentPreset } from '../store/agentPresetSync.ts'
import type { AgentPresetId } from '../store/agentPresetSync.ts'

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

/** 当前计划模式下最新提交、尚未确认的计划。 */
function pendingPlanFrom(events: readonly SessionEvent[]): { readonly seq: number; readonly plan: PlanArtifact } | undefined {
  let active = false
  let latest: { readonly seq: number; readonly plan: PlanArtifact } | undefined
  for (const event of events) {
    if (event.type === 'plan/mode') {
      active = event.data.active
      if (active) latest = undefined
    } else if (active && event.type === 'plan/proposed') {
      latest = { seq: event.seq, plan: event.data.plan }
    }
  }
  return active ? latest : undefined
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

function gitStatusLabel(file: GitStatusFile): string {
  switch (file.kind) {
    case 'untracked': return '?'
    case 'conflicted': return '!'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'added': return 'A'
    case 'deleted': return 'D'
    default: return 'M'
  }
}

function gitStateText(file: GitStatusFile): string {
  if (file.untracked) return t('未跟踪')
  if (file.conflicted) return t('冲突')
  if (file.staged && file.unstaged) return t('已暂存 + 未暂存')
  if (file.staged) return t('已暂存')
  return t('未暂存')
}

function GitDiffView({ result }: { readonly result: GitDiffResult }) {
  if (result.parts.length === 0) return <div className="gdiff"><div className="gdiff-note">{t('没有可显示的文本差异')}</div></div>
  return (
    <div className="gdiff">
      {result.parts.map((part, index) => (
        <div className="gdiff-part" key={`${part.staged}-${index}`}>
          {result.untracked ? (
            <div className="gdiff-parthead">{t('新文件')}</div>
          ) : result.parts.length > 1 ? (
            <div className="gdiff-parthead">{part.staged ? t('已暂存') : t('未暂存')}</div>
          ) : null}
          {part.binary ? (
            <div className="gdiff-note">{t('二进制文件，无法显示文本差异')}</div>
          ) : part.lines.length === 0 ? (
            <div className="gdiff-note">{t('没有可显示的文本差异')}</div>
          ) : (
            <div className="gdiff-body">
              {part.lines.map((line, lineIndex) => (
                line.kind === 'meta' ? (
                  <div className="gline meta" key={lineIndex}>{line.text}</div>
                ) : (
                  <div className={`gline ${line.kind}`} key={lineIndex}>
                    <span className="old">{line.oldLine ?? ''}</span>
                    <span className="new">{line.newLine ?? ''}</span>
                    <span className="mark">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}</span>
                    <span className="code">{line.text}</span>
                  </div>
                )
              ))}
              {part.truncated ? <div className="gdiff-note">{t('差异过大，已截断')}</div> : null}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function GitFileRow({ workspace, file }: { readonly workspace: string; readonly file: GitStatusFile }) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next || diff !== null || loading) return
    const bridge = workspaceInfoBridge()
    if (bridge === undefined) return
    setLoading(true)
    setError(null)
    void bridge.gitDiff({
      workspace,
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      staged: file.staged,
      unstaged: file.unstaged,
      untracked: file.untracked,
    })
      .then(setDiff)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('读取文件差异失败')))
      .finally(() => setLoading(false))
  }

  return (
    <div className={'gitfile-wrap' + (open ? ' open' : '')}>
      <div
        className="gitfile"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
      >
        <span className={`gitbadge ${file.kind}`}>{gitStatusLabel(file)}</span>
        <span className="gitpath mono" title={file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}>
          {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
        </span>
        <span className="gitstate">{gitStateText(file)}</span>
        {file.additions === undefined && file.deletions === undefined ? null : (
          <span className="gitnums">
            <span className="add">+{file.additions ?? 0}</span>{' '}
            <span className="del">-{file.deletions ?? 0}</span>
          </span>
        )}
        <span className="gitchev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </div>
      {open ? (
        loading ? <div className="gdiff-note">{t('正在读取差异…')}</div>
          : error !== null ? <div className="gdiff-note gdiff-error">{error}</div>
            : diff !== null ? <GitDiffView result={diff} /> : null
      ) : null}
    </div>
  )
}

function RightPanel({
  tab,
  setTab,
  changes,
  workspace,
  sessionId,
  gitStatus,
  gitBusy,
  filesEpoch,
  onRefreshGit,
  width,
}: {
  readonly tab: Tab
  readonly setTab: (tab: Tab) => void
  readonly changes: readonly Change[]
  readonly workspace: string | null
  readonly sessionId: string
  readonly gitStatus: WorkspaceGitStatus | null
  readonly gitBusy: boolean
  readonly filesEpoch: number
  readonly onRefreshGit: () => void
  readonly width: number
}) {
  const [openFile, setOpenFile] = useState<string | null>(changes[0]?.path ?? null)
  const changedFileCount = useMemo(() => new Set(changes.map((change) => change.path)).size, [changes])
  const markers = useMemo(() => {
    const map = new Map<string, FileMarker>()
    for (const file of gitStatus?.files ?? []) map.set(file.path, { kind: file.kind, label: gitStatusLabel(file) })
    return map
  }, [gitStatus])
  return (
    <aside className="right" style={{ width }}>
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
            <span className="chip">{t('事件投影')}</span> {t('{n} 个文件改动', { n: changedFileCount })}
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

          <div className="rscope gitscope">
            <span className="chip">{t('Git 工作区')}</span>
            <span className="gitsummary">
              {gitStatus === null
                ? (workspace === null || workspace === '' ? t('未设置工作区') : t('正在读取 Git 状态…'))
                : !gitStatus.isRepo
                  ? t('不是 Git 仓库')
                  : gitStatus.total === 0
                    ? t('工作区没有未提交变更')
                    : t('{branch} · {n} 个未提交文件', { branch: gitStatus.branch ?? t('detached'), n: gitStatus.total })}
            </span>
            <button className="mini gitrefresh" disabled={gitBusy || workspace === null || workspace === ''} onClick={onRefreshGit}>
              {gitBusy ? t('刷新中…') : t('刷新')}
            </button>
          </div>
          {gitStatus !== null && gitStatus.isRepo && gitStatus.files.length > 0 ? (
            <div className="gitfiles">
              {gitStatus.files.map((file) => (
                <GitFileRow key={`${file.path}-${file.raw}`} workspace={workspace ?? ''} file={file} />
              ))}
              {gitStatus.truncated ? (
                <div className="gitmore">{t('只显示前 {shown} / 共 {total} 个文件', { shown: gitStatus.files.length, total: gitStatus.total })}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rpanel">
          {workspace === null || workspace === '' ? (
            <div className="pickhint">{t('未设置工作区')}</div>
          ) : (
            <FileTree workspace={workspace} markers={markers} epoch={filesEpoch} />
          )}
        </div>
      )}
    </aside>
  )
}

export function WorkspacePage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [panelOpen, setPanelOpen] = useState(true)
  const rightPanel = useResizablePanel({
    storageKey: 'lcode.layout.rightWidth',
    defaultWidth: 288,
    minWidth: 220,
    side: 'right',
    label: t('调整右侧栏宽度'),
    onCollapse: () => {
      setPanelOpen(false)
      toast(t('右侧面板已收起'))
    },
  })
  const [tab, setTab] = useState<Tab>('changes')
  const [text, setText] = useState('')
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [queued, setQueued] = useState<readonly QueuedMessage[]>([])
  /** 会话是否处于"上翻离开底部"状态（「回到底部」按钮放进输入框上方的状态条） */
  const [jumpVisible, setJumpVisible] = useState(false)
  const jumpRef = useRef<(() => void) | null>(null)
  const [readOnlyConfirmedFor, setReadOnlyConfirmedFor] = useState<string | null>(null)
  /** 回退重发会就地截断日志：本页那份事件副本必须整体重读，否则右栏还挂着已撤回的变更 */
  const [reloadEpoch, setReloadEpoch] = useState(0)
  /** 输入框状态栏：上下文占用与 Git 信息 */
  const [usage, setUsage] = useState<SessionContextUsage | null>(null)
  const [gitInfo, setGitInfo] = useState<WorkspaceGitInfo | null>(null)
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [gitEpoch, setGitEpoch] = useState(0)
  const [usageEpoch, setUsageEpoch] = useState(0)
  const [compactOpen, setCompactOpen] = useState(false)
  const [contextOpenSignal, setContextOpenSignal] = useState(0)
  const [retrySignal, setRetrySignal] = useState(0)

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
      // 轮结束 / 压缩事务 / 屏蔽标记都会改变下一次请求的表面：刷新状态栏
      if (event.type === 'turn/end' || event.type === 'compaction/end' || event.type === 'compaction/undo' || event.type === 'context/turn-marker') {
        setUsageEpoch((n) => n + 1)
      }
      if (event.type === 'turn/end') setGitEpoch((n) => n + 1)
      if (event.type === 'tool/result') {
        const meta = record(record(event.data)?.['meta'])
        if (meta?.['card'] === 'diff') setGitEpoch((n) => n + 1)
      }
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
  /** 最近一次 todo_write 的整表快照（last-write-wins）：输入框上方的任务清单条 */
  const todos = useMemo(() => {
    let latest: readonly TodoItem[] = []
    for (const event of events) if (event.type === 'todo/write') latest = event.data.todos
    return latest
  }, [events])
  const planActive = useMemo(() => planActiveFrom(events), [events])
  const planReady = useMemo(() => planReadyFrom(events), [events])
  const pendingPlan = useMemo(() => pendingPlanFrom(events), [events])
  const workspaceTrust = useMemo(() => workspaceTrustFrom(events), [events])
  const composerAction = useMemo(() => primaryActionFrom(events), [events])
  const agentRunning = composerAction === 'pause'

  /*
   * 计划提交后自动弹确认框。
   *
   * 时机选在**本轮结束后**：submit_plan 是工具调用，先落 plan/proposed；
   * 若立刻弹窗，用户会在模型还在收尾时被打断。关掉后同一份计划不再自动重弹，
   * 状态 chip 里仍保留「开始执行」。
   */
  const [reviewPlanSeq, setReviewPlanSeq] = useState<number | null>(null)
  const dismissedPlanSeq = useRef<number | null>(null)
  const [agentPreset, setAgentPreset] = useState<AgentPresetId | null>(null)
  useEffect(() => {
    void getAgentPreset()
      .then((state) => setAgentPreset(state?.preset ?? null))
      .catch(() => setAgentPreset(null))
  }, [sessionId])
  useEffect(() => {
    dismissedPlanSeq.current = null
    setReviewPlanSeq(null)
  }, [sessionId])
  useEffect(() => {
    if (!planActive || pendingPlan === undefined) {
      setReviewPlanSeq(null)
      return
    }
    if (agentRunning) return
    if (pendingPlan.seq === dismissedPlanSeq.current) return
    setReviewPlanSeq(pendingPlan.seq)
  }, [planActive, pendingPlan, agentRunning])

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
      setGitStatus(null)
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

  const refreshGitStatus = useCallback((manual = false): void => {
    const workspace = meta?.workspace
    const bridge = workspaceInfoBridge()
    if (workspace === null || workspace === undefined || workspace === '' || bridge === undefined) {
      setGitStatus(null)
      return
    }
    setGitBusy(true)
    void bridge.gitStatus(workspace)
      .then((status) => {
        setGitStatus(status)
        setGitInfo({ isRepo: status.isRepo, branch: status.branch, mode: status.mode })
      })
      .catch((error: unknown) => {
        if (manual) toast(error instanceof Error ? error.message : t('读取 Git 状态失败'))
      })
      .finally(() => setGitBusy(false))
  }, [meta?.workspace])

  useEffect(() => {
    if (meta?.workspace === null || meta?.workspace === undefined || meta?.workspace === '') {
      setGitStatus(null)
      return
    }
    refreshGitStatus(false)
  }, [meta?.workspace, reloadEpoch, gitEpoch, refreshGitStatus])

  useEffect(() => {
    const refresh = (): void => { refreshGitStatus(false) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refreshGitStatus])

  useEffect(() => {
    if (!panelOpen || tab !== 'changes') return
    const timer = setInterval(() => refreshGitStatus(false), 8_000)
    return () => clearInterval(timer)
  }, [panelOpen, tab, refreshGitStatus])

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
  const send = ({ attachments, skills, images }: ComposerSendInput) => {
    const value = text.trim()
    if ((value === '' && images.length === 0 && attachments.length === 0) || sessionId === undefined) return
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
      .send({
        session_id: sessionId,
        text: value,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(skills.length === 0 ? {} : { skills }),
        ...(images.length === 0 ? {} : { images }),
      })
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
    }
  }

  const planAction = (): void => {
    if (sessionId === undefined) return
    const api = planBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法切换计划模式'))
      return
    }
    const wasActive = planActive
    const action = wasActive ? api.confirm({ session_id: sessionId }) : api.enter({ session_id: sessionId })
    void action.then(() => {
      if (wasActive) toast(t('计划已确认，开始执行'))
      else toast(t('已进入计划模式：只读探索，确认计划后才会改动'))
      notifySessionChanged()
    }).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : t('切换计划模式失败'))
    })
  }

  const cancelPlan = (): void => {
    if (sessionId === undefined) return
    const api = planBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法切换计划模式'))
      return
    }
    void api.cancel({ session_id: sessionId }).then(() => {
      toast(t('已退出计划模式'))
      notifySessionChanged()
    }).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : t('切换计划模式失败'))
    })
  }

  const reviewPlan = pendingPlan !== undefined && reviewPlanSeq === pendingPlan.seq ? pendingPlan : undefined
  const laterPlan = (): void => {
    if (reviewPlan !== undefined) dismissedPlanSeq.current = reviewPlan.seq
    setReviewPlanSeq(null)
  }
  const confirmPlan = (): void => {
    if (reviewPlan !== undefined) dismissedPlanSeq.current = reviewPlan.seq
    setReviewPlanSeq(null)
    planAction()
  }

  const guideQueued = (queueId: string, mode: 'soft' | 'interrupt' = 'soft'): void => {
    if (sessionId === undefined) return
    const api = agentBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法引导任务'))
      return
    }
    void api.queue.guide({ session_id: sessionId, queue_id: queueId, mode }).then(({ guided }) => {
      if (guided) toast(mode === 'interrupt' ? t('已打断当前步骤，消息立即生效') : t('已加入当前任务，将在下一步生效'))
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
        <span className="wstitleactions">
          <SessionActionsMenu
            session={{ session_id: sessionId, title: meta?.title ?? '' }}
            buttonClass="wstitleact"
            onRenamed={(title) => setMeta((prev) => (prev === null ? prev : { ...prev, title }))}
            onRemoved={() => navigate('/')}
          />
          {agentPreset === null ? null : (
            <span className="wspreset" title={t('Agent 预设（设置 → Agent 预设）')}>{agentPresetLabel(agentPreset)}</span>
          )}
        </span>
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
                retrySignal={retrySignal}
                onJumpChange={setJumpVisible}
                jumpRef={jumpRef}
              />
            </div>
          </div>
          {/* 会话区与输入框之间的常驻状态条：本轮芯片 + 回到底部 */}
          <div className="turnstrip">
            <TurnStatusBar todos={todos} changes={changes} />
            {jumpVisible ? (
              <button
                type="button"
                className="jumpbottom"
                title={t('回到底部')}
                aria-label={t('回到底部')}
                onClick={() => jumpRef.current?.()}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v9M4.2 8.2L8 12l3.8-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
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
                onPlanCancel={cancelPlan}
                queued={queued}
                onGuideQueued={guideQueued}
                onEditQueued={editQueued}
                onRemoveQueued={removeQueued}
                onClearQueued={clearQueued}
                usedTokens={usage?.usedTokens ?? 0}
                contextWindowTokens={usage?.contextWindowTokens ?? null}
                onCompact={sessionId === undefined ? undefined : () => setCompactOpen(true)}
                onSlashCommand={(name, _args) => {
                  if (sessionId === undefined) return false
                  if (name === 'compact') {
                    setCompactOpen(true)
                    return true
                  }
                  if (name === 'context') {
                    setContextOpenSignal((n) => n + 1)
                    return true
                  }
                  if (name === 'retry') {
                    setRetrySignal((n) => n + 1)
                    return true
                  }
                  if (name === 'export') {
                    const api = sessionBridge()
                    if (api === undefined) return false
                    void api
                      .export({ session_id: sessionId, format: 'bundle' })
                      .then((result) => toast(t('已导出到 {path}（SHA-256 {hash}）', { path: result.path, hash: result.sha256.slice(0, 12) })))
                      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('导出会话失败')))
                    return true
                  }
                  return false
                }}
                footer={
                  <ContextBar
                    sessionId={sessionId ?? ''}
                    workspace={meta?.workspace ?? null}
                    branch={gitInfo?.branch ?? null}
                    mode={gitInfo?.mode ?? 'local'}
                    isRepo={gitInfo?.isRepo ?? false}
                    usage={usage}
                    running={agentRunning}
                    openSignal={contextOpenSignal}
                    onChanged={() => setUsageEpoch((n) => n + 1)}
                    onGitChanged={() => setGitEpoch((n) => n + 1)}
                    onCompactRequest={() => setCompactOpen(true)}
                    onOpenSettings={() => navigate('/settings', { state: { sec: 'providers' } })}
                  />
                }
              />
            </div>
          </div>
        </div>
        {panelOpen && (
          <>
            <PanelSplitter side="right" panel={rightPanel} />
            <RightPanel
              tab={tab}
              setTab={setTab}
              changes={changes}
              workspace={meta?.workspace ?? null}
              sessionId={sessionId}
              gitStatus={gitStatus}
              gitBusy={gitBusy}
              filesEpoch={gitEpoch}
              onRefreshGit={() => refreshGitStatus(true)}
              width={rightPanel.width}
            />
          </>
        )}
        {compactOpen && sessionId !== undefined ? (
          <CompactionDialog
            sessionId={sessionId}
            onClose={() => setCompactOpen(false)}
            onChanged={() => setUsageEpoch((n) => n + 1)}
          />
        ) : null}
      </div>
      {reviewPlan !== undefined ? (
        <PlanReviewDialog plan={reviewPlan.plan} onLater={laterPlan} onConfirm={confirmPlan} />
      ) : null}
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
