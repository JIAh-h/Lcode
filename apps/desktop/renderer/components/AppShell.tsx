import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { t } from '../i18n/index.ts'
import { toast } from './toast.ts'
import { PopMenu } from './PopMenu.tsx'
import { SessionActionsMenu } from './SessionActionsMenu.tsx'
import { sessionBridge } from '../store/sessionBridge.ts'
import type { SessionMeta } from '../store/sessionBridge.ts'

/**
 * 桌面外壳（按 webapp 原型 1:1 移植）：
 * 菜单栏（Lcode + 文件/编辑/视图/帮助 下拉菜单）+ 侧栏（新对话/打开文件夹 + 项目分组会话树 + 底部账户）。
 * 设置页（/settings）按 Codex 布局全宽呈现：隐藏主侧栏，由 SettingsPage 自带面包栏。
 */

type MItem = { hr: true } | { label: string; kbd?: string; run: () => void }
function isHr(it: MItem): it is { hr: true } {
  return (it as { hr: true }).hr === true
}

/** 侧栏本地视图状态（主进程 `userData/sidebar.json`） */
interface SidebarState {
  readonly pinnedWorkspaces: readonly string[]
  readonly archivedWorkspaces: readonly string[]
  readonly pinnedSessions: readonly string[]
  readonly collapsedWorkspaces: readonly string[]
}
const EMPTY_SIDEBAR: SidebarState = {
  pinnedWorkspaces: [],
  archivedWorkspaces: [],
  pinnedSessions: [],
  collapsedWorkspaces: [],
}

function toggleInList(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function sessionApi():
  | {
      list(input?: { readonly limit?: number; readonly cursor?: string }): Promise<{
        items: readonly SessionMeta[]
        nextCursor?: string | undefined
      }>
    }
  | undefined {
  return (
    globalThis as unknown as {
      lcode?: {
        session?: {
          list(input?: unknown): Promise<{ items: readonly SessionMeta[] }>
        }
      }
    }
  ).lcode?.session
}

function workspaceName(workspace: string | null): string {
  if (workspace === null || workspace === '') return t('未命名工作区')
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState<string | null>(null)
  const [sessions, setSessions] = useState<readonly SessionMeta[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sidebar, setSidebar] = useState<SidebarState>(EMPTY_SIDEBAR)
  const [showArchived, setShowArchived] = useState(false)
  const barRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(1)

  const loadSidebar = useCallback(async () => {
    const value = await window.lcode.getSidebar()
    const record = (value ?? {}) as Partial<SidebarState>
    setSidebar({
      pinnedWorkspaces: record.pinnedWorkspaces ?? [],
      archivedWorkspaces: record.archivedWorkspaces ?? [],
      pinnedSessions: record.pinnedSessions ?? [],
      collapsedWorkspaces: record.collapsedWorkspaces ?? [],
    })
  }, [])

  useEffect(() => {
    void loadSidebar()
    const reload = (): void => void loadSidebar()
    window.addEventListener('lcode:sidebar-changed', reload)
    return () => window.removeEventListener('lcode:sidebar-changed', reload)
  }, [loadSidebar])

  const refreshSessions = useCallback(async () => {
    const api = sessionApi()
    if (api === undefined) return
    try {
      const result = await api.list({ limit: 50 })
      setSessions(result.items)
      setNextCursor(result.nextCursor)
    } catch {
      setSessions([])
      setNextCursor(undefined)
    }
  }, [])
  const loadMoreSessions = useCallback(async () => {
    const api = sessionApi()
    if (api === undefined || nextCursor === undefined || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await api.list({ limit: 50, cursor: nextCursor })
      setSessions((prev) => {
        const seen = new Set(prev.map((item) => item.session_id))
        return [...prev, ...result.items.filter((item) => !seen.has(item.session_id))]
      })
      setNextCursor(result.nextCursor)
    } catch {
      // 保留已加载的部分；下次点击还能重试
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore])

  useEffect(() => {
    void refreshSessions()
    const refresh = () => void refreshSessions()
    window.addEventListener('lcode:session-changed', refresh)
    const disposeBridge = sessionBridge()?.onChanged(() => {
      window.dispatchEvent(new Event('lcode:session-changed'))
    })
    return () => {
      window.removeEventListener('lcode:session-changed', refresh)
      disposeBridge?.()
    }
  }, [refreshSessions])

  /* 点击菜单栏外部时收起全部下拉 */
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  const act = (fn: () => void) => () => {
    setOpen(null)
    fn()
  }
  const say = (msg: string) => act(() => toast(msg))

  const editCmd = (cmd: string, name: string) =>
    act(() => {
      let ok = false
      try {
        ok = document.execCommand(cmd)
      } catch {
        /* ignore */
      }
      toast(ok ? t('已执行「{name}」', { name: t(name) }) : t('当前没有可编辑的目标'))
    })

  const toggleTheme = act(() => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    toast(next === 'dark' ? t('已切换到深色主题') : t('已切换到浅色主题'))
  })

  const zoomBy = (delta: number | null) =>
    act(() => {
      zoomRef.current = delta === null ? 1 : Math.min(1.5, Math.max(0.7, zoomRef.current + delta))
      document.body.style.zoom = String(zoomRef.current)
      toast(t('缩放 {n}%', { n: Math.round(zoomRef.current * 100) }))
    })

  const toggleFullscreen = act(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  })

  const toggleSide = act(() => {
    document.body.classList.toggle('noside')
    toast(document.body.classList.contains('noside') ? t('侧边栏已隐藏') : t('侧边栏已显示'))
  })

  const goSettingsSec = (sec: string) => act(() => navigate('/settings', { state: { sec } }))
  const currentSessionId = pathname.match(/^\/sessions\/([^/]+)/)?.[1]
  const openFolder = act(() => {
    void window.lcode.chooseFolder(t('选择项目文件夹')).then((path) => {
      if (path !== null) navigate('/', { state: { cwd: path } })
    })
  })
  const importSession = act(() => {
    const bridge = sessionBridge()
    if (bridge === undefined) {
      toast(t('当前环境没有主进程桥，无法导入会话'))
      return
    }
    void window.lcode.chooseSessionFile(t('选择要导入的会话文件')).then((path) => {
      if (path === null) return
      void bridge
        .import({ path })
        .then((result) => {
          window.dispatchEvent(new Event('lcode:session-changed'))
          toast(t('已导入会话（{n} 条事件）', { n: result.imported_events }))
          navigate(`/sessions/${result.session_id}`)
        })
        .catch((err: unknown) => toast(err instanceof Error ? err.message : t('导入会话失败')))
    })
  })
  const exportSession = act(() => {
    const bridge = sessionBridge()
    if (bridge === undefined) {
      toast(t('当前环境没有主进程桥，无法导出会话'))
      return
    }
    if (currentSessionId === undefined) {
      toast(t('先打开一个会话再导出'))
      return
    }
    void bridge
      .export({ session_id: currentSessionId, format: 'jsonl' })
      .then((result) => toast(t('已导出到 {path}（SHA-256 {hash}）', { path: result.path, hash: result.sha256.slice(0, 12) })))
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('导出会话失败')))
  })
  const updateSidebar = (next: SidebarState): void => {
    setSidebar(next)
    void window.lcode.setSidebar(next)
  }
  const toggleGroup = (key: string): void => {
    updateSidebar({ ...sidebar, collapsedWorkspaces: toggleInList(sidebar.collapsedWorkspaces, key) })
  }
  /**
   * 「+」只打开该工作区的输入页，**不立刻落会话**。
   * 会话由首页在用户真正发送时创建（Home 的 send 路径）——否则点一下就会
   * 在侧栏留下一个空会话，而模型可能压根没被调用。
   */
  const composeIn = (workspace: string | null): void => {
    if (workspace === null || workspace === '') navigate('/')
    else navigate('/', { state: { cwd: workspace } })
  }
  const onGroupMenu = (key: string, id: string): void => {
    if (id === 'pin') {
      updateSidebar({ ...sidebar, pinnedWorkspaces: toggleInList(sidebar.pinnedWorkspaces, key) })
      return
    }
    if (id === 'archive') {
      updateSidebar({ ...sidebar, archivedWorkspaces: toggleInList(sidebar.archivedWorkspaces, key) })
      toast(t('工作区已归档'))
    }
  }
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, { workspace: string | null; name: string; items: SessionMeta[] }>()
    for (const session of sessions) {
      const key = session.workspace ?? ''
      const group = groups.get(key) ?? { workspace: session.workspace, name: workspaceName(session.workspace), items: [] }
      group.items.push(session)
      groups.set(key, group)
    }
    const pinnedSessions = sidebar.pinnedSessions
    const entries = [...groups.entries()]
      .filter(([key]) => !sidebar.archivedWorkspaces.includes(key))
      .map(([key, group]) => {
        const items = [...group.items].sort((a, b) => {
          const ia = pinnedSessions.indexOf(a.session_id)
          const ib = pinnedSessions.indexOf(b.session_id)
          if (ia === -1 && ib === -1) return 0
          if (ia === -1) return 1
          if (ib === -1) return -1
          return ia - ib
        })
        return [key, { ...group, items }] as const
      })
    const pinnedWorkspaces = sidebar.pinnedWorkspaces
    entries.sort((a, b) => {
      const ia = pinnedWorkspaces.indexOf(a[0])
      const ib = pinnedWorkspaces.indexOf(b[0])
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })
    return entries
  }, [sessions, sidebar])
  const archivedGroups = useMemo(() => {
    const names = new Map<string, string>()
    for (const session of sessions) {
      const key = session.workspace ?? ''
      if (sidebar.archivedWorkspaces.includes(key) && !names.has(key)) names.set(key, workspaceName(session.workspace))
    }
    return sidebar.archivedWorkspaces.map(
      (key) => [key, names.get(key) ?? (key === '' ? t('未命名工作区') : key)] as const,
    )
  }, [sessions, sidebar.archivedWorkspaces])

  /* 菜单文案：标签与提示统一过 t()；`label` 同时用作 key，仍保留中文原文 */
  const MENUS: { id: string; label: string; items: MItem[] }[] = [
    {
      id: 'file',
      label: t('文件'),
      items: [
        { label: t('新对话'), kbd: '⌃N', run: act(() => navigate('/')) },
        { label: t('新建临时对话'), kbd: '⌃⇧N', run: act(() => navigate('/')) },
        { hr: true },
        { label: t('打开文件夹…'), kbd: '⌃O', run: openFolder },
        { label: t('导入会话…'), run: importSession },
        { label: t('导出当前会话…'), run: exportSession },
        { hr: true },
        { label: t('关闭会话'), kbd: '⌃W', run: act(() => navigate('/')) },
        { hr: true },
        { label: t('退出'), kbd: '⌃Q', run: act(() => void window.lcode.requestClose()) },
      ],
    },
    {
      id: 'edit',
      label: t('编辑'),
      items: [
        { label: t('撤销'), kbd: '⌃Z', run: editCmd('undo', '撤销') },
        { label: t('重做'), kbd: '⌃⇧Z', run: editCmd('redo', '重做') },
        { hr: true },
        { label: t('剪切'), kbd: '⌃X', run: editCmd('cut', '剪切') },
        { label: t('复制'), kbd: '⌃C', run: editCmd('copy', '复制') },
        { label: t('粘贴'), kbd: '⌃V', run: editCmd('paste', '粘贴') },
        { hr: true },
        { label: t('全选'), kbd: '⌃A', run: editCmd('selectAll', '全选') },
        { hr: true },
        { label: t('设置…'), kbd: '⌃,', run: act(() => navigate('/settings')) },
      ],
    },
    {
      id: 'view',
      label: t('视图'),
      items: [
        { label: t('切换侧边栏'), kbd: '⌃B', run: toggleSide },
        {
          label: t('切换变更/文件面板'),
          kbd: '⌃J',
          run: say(t('请使用工作台标题栏中的面板按钮')),
        },
        { hr: true },
        {
          label: t('工作台'),
          run: act(() => navigate(currentSessionId === undefined ? '/' : `/sessions/${currentSessionId}`)),
        },
        {
          label: t('回放时间轴'),
          kbd: '⌃R',
          run: act(() => navigate(currentSessionId === undefined ? '/' : `/sessions/${currentSessionId}/replay`)),
        },
        { hr: true },
        { label: t('切换深色/浅色主题'), run: toggleTheme },
        { hr: true },
        { label: t('放大'), kbd: '⌃⇧=', run: zoomBy(0.1) },
        { label: t('缩小'), kbd: '⌃-', run: zoomBy(-0.1) },
        { label: t('实际大小'), kbd: '⌃0', run: zoomBy(null) },
        { hr: true },
        { label: t('切换全屏'), kbd: 'F11', run: toggleFullscreen },
        { hr: true },
        {
          label: t('状态与异常'),
          run: act(() => navigate(currentSessionId === undefined ? '/' : `/sessions/${currentSessionId}/error`)),
        },
        {
          label: t('崩溃恢复（演示入口）'),
          run: act(() => navigate(currentSessionId === undefined ? '/' : `/sessions/${currentSessionId}/recovery`)),
        },
      ],
    },
    {
      id: 'help',
      label: t('帮助'),
      items: [
        {
          label: t('文档'),
          run: say(t('演示：打开 Lcode 文档（桌面版跳转官网）')),
        },
        { label: t('显示键盘快捷键'), kbd: '⌃/', run: goSettingsSec('keys') },
        { hr: true },
        { label: t('故障排除'), run: goSettingsSec('history') },
        { label: t('反馈…'), run: say(t('感谢反馈！演示版暂不收集反馈内容')) },
        { hr: true },
        {
          label: t('检查更新…'),
          run: say(t('当前已是最新版本 v1.0.0（mock）')),
        },
        {
          label: t('关于 Lcode'),
          run: say(t('Lcode v1.0.0 · 本地优先的 AI 编码工作台')),
        },
      ],
    },
  ]

  const isSettings = pathname.startsWith('/settings')

  return (
    <div className="shell">
      <div className="menubar" ref={barRef}>
        {/* 侧栏收起/展开（WorkBuddy 排版：左上角第一个位置是面板开关，其后紧跟菜单） */}
        {!isSettings && (
          <button className="mtoggle" title={t('收起/显示左侧栏')} aria-label={t('收起/显示左侧栏')} onClick={toggleSide}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <rect x="1.5" y="2.5" width="4.5" height="11" rx="1" fill="currentColor" opacity=".28" stroke="none" />
            </svg>
          </button>
        )}
        {MENUS.map((m) => (
          <div className="mwrap" key={m.id}>
            <button
              className={'mi' + (open === m.id ? ' open' : '')}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(open === m.id ? null : m.id)
              }}
              onMouseEnter={() => {
                if (open !== null) setOpen(m.id)
              }}
            >
              {m.label}
            </button>
            <div className={'menu' + (open === m.id ? ' open' : '')}>
              {m.items.map((it, i) =>
                isHr(it) ? (
                  <hr key={i} />
                ) : (
                  <a key={i} onClick={it.run}>
                    {it.label}
                    {it.kbd ? <span className="kbd">{it.kbd}</span> : null}
                  </a>
                ),
              )}
            </div>
          </div>
        ))}
        <div className="msp" />
      </div>
      <div className="body">
        {!isSettings && (
          <aside className="side">
            <div className="side-head">
              <span className="appname">Lcode</span>
              <span className="appver">v0.1.0</span>
            </div>
            <nav className="snav">
              <a
                className="new"
                href="#/"
                onClick={(e) => {
                  e.preventDefault()
                  navigate('/')
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                {t('新对话')}
              </a>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  openFolder()
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
                {t('打开文件夹…')}
              </a>
            </nav>
            <div className="shead">{t('工作区')}</div>
            {/*
              会话树独立滚动：工作区/会话再多也只占侧栏高度，不挤压底部账户区。
              `min-height: 0` 是 flex 子项能真正收缩的前提，缺了它会撑破外框。
            */}
            <div className="stree">
              {sessionGroups.length === 0 && archivedGroups.length === 0 && (
                <div className="sempty">{t('还没有会话')}</div>
              )}
              {sessionGroups.map(([key, group]) => {
                const open = !sidebar.collapsedWorkspaces.includes(key)
                const pinnedGroup = sidebar.pinnedWorkspaces.includes(key)
                return (
                  <div className="sgroup" key={key}>
                    <div className="sgh-row">
                      <button
                        type="button"
                        className="sgh"
                        aria-expanded={open}
                        title={group.name}
                        onClick={() => toggleGroup(key)}
                      >
                        <svg className={`sgc${open ? '' : ' closed'}`} width="12" height="12" viewBox="0 0 16 16" fill="none">
                          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="sgn">{group.name}</span>
                      </button>
                      <span className="sgh-acts">
                        <button
                          type="button"
                          className="sga"
                          title={t('在此工作区新建会话')}
                          onClick={() => composeIn(group.workspace)}
                        >
                          +
                        </button>
                        <PopMenu
                          trigger="⋯"
                          buttonClass="sga"
                          title={t('工作区操作')}
                          items={[
                            { id: 'pin', label: pinnedGroup ? '取消置顶' : '置顶' },
                            { id: 'archive', label: '归档工作区' },
                          ]}
                          onSelect={(id) => onGroupMenu(key, id)}
                        />
                      </span>
                    </div>
                    {open && (
                      <div className="slist">
                        {group.items.map((it) => (
                          <div
                            className={'snrow' + (pathname.startsWith(`/sessions/${it.session_id}`) ? ' on' : '')}
                            key={it.session_id}
                          >
                            <NavLink
                              to={`/sessions/${it.session_id}`}
                              className="sitem"
                              title={it.title || t('未命名会话')}
                            >
                              <span className="sname">{it.title || t('未命名会话')}</span>
                            </NavLink>
                            <SessionActionsMenu session={it} buttonClass="sga sact" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {archivedGroups.length > 0 && (
                <div className="sgroup">
                  <div className="sgh-row">
                    <button
                      type="button"
                      className="sgh"
                      aria-expanded={showArchived}
                      onClick={() => setShowArchived((value) => !value)}
                    >
                      <svg className={`sgc${showArchived ? '' : ' closed'}`} width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="sgn">{t('已归档工作区')}</span>
                    </button>
                  </div>
                  {showArchived && (
                    <div className="slist">
                      {archivedGroups.map(([key, name]) => (
                        <div className="snrow" key={key}>
                          <span className="sitem" title={name}>
                            <span className="sname">{name}</span>
                          </span>
                          <button
                            type="button"
                            className="sga sact"
                            title={t('取消归档')}
                            onClick={() => {
                              updateSidebar({
                                ...sidebar,
                                archivedWorkspaces: sidebar.archivedWorkspaces.filter((item) => item !== key),
                              })
                              toast(t('已取消归档'))
                            }}
                          >
                            ↩
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {nextCursor !== undefined && (
                <button
                  type="button"
                  className="smore"
                  disabled={loadingMore}
                  onClick={() => void loadMoreSessions()}
                >
                  {loadingMore ? t('加载中…') : t('加载更多会话')}
                </button>
              )}
            </div>
            <div className="acct">
              <div className="av">J</div>
              <div>
                <div className="nm">jiahao</div>
                <div className="em">{t('本地用户')}</div>
              </div>
              <button className="ticon" title={t('设置（Ctrl+,）')} onClick={() => navigate('/settings')}>
                ⚙
              </button>
            </div>
          </aside>
        )}
        <main className="content">{children}</main>
      </div>
    </div>
  )
}
