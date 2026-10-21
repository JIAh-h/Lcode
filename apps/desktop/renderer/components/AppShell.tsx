import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { t } from '../i18n/index.ts'
import { toast } from './toast.ts'
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

function sessionApi(): { list(input?: unknown): Promise<{ items: readonly SessionMeta[] }> } | undefined {
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

function stateColor(status: SessionMeta['status']): string {
  if (status === 'busy' || status === 'waiting-approval') return 'var(--state-running)'
  if (status === 'error') return 'var(--state-error)'
  return 'var(--state-idle)'
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState<string | null>(null)
  const [sessions, setSessions] = useState<readonly SessionMeta[]>([])
  const barRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(1)

  const refreshSessions = useCallback(async () => {
    const api = sessionApi()
    if (api === undefined) return
    try {
      const result = await api.list()
      setSessions(result.items)
    } catch {
      setSessions([])
    }
  }, [])

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
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, SessionMeta[]>()
    for (const session of sessions) {
      const name = workspaceName(session.workspace)
      const group = groups.get(name) ?? []
      group.push(session)
      groups.set(name, group)
    }
    return [...groups.entries()]
  }, [sessions])

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
        { hr: true },
        { label: t('关闭会话'), kbd: '⌃W', run: act(() => navigate('/')) },
        { hr: true },
        { label: t('退出'), kbd: '⌃Q', run: act(() => window.close()) },
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
            <div className="shead">{t('工作区')}</div>
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
            {sessionGroups.map(([name, items]) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  flex: 1,
                }}
              >
                <div className="sgroup">{name}</div>
                <div className="slist">
                  {items.map((it) => (
                    <NavLink
                      key={it.session_id}
                      to={`/sessions/${it.session_id}`}
                      className={({ isActive }) => 'sitem' + (isActive ? ' on' : '')}
                    >
                      <i className="st" style={{ background: stateColor(it.status) }} />
                      {it.title || t('未命名会话')}
                      <span className="cnt">{it.last_seq < 0 ? t('空会话') : t('{n} 条记录', { n: it.last_seq + 1 })}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
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
