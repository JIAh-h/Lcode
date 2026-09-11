import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { toast } from './toast.ts'

/**
 * 桌面外壳（按 webapp 原型 1:1 移植）：
 * 菜单栏（Lcode + 文件/编辑/视图/帮助 下拉菜单）+ 侧栏（新对话/打开文件夹 + 项目分组会话树 + 底部账户）。
 * 设置页（/settings）按 Codex 布局全宽呈现：隐藏主侧栏，由 SettingsPage 自带面包栏。
 */

type MItem = { hr: true } | { label: string; kbd?: string; run: () => void }
function isHr(it: MItem): it is { hr: true } {
  return (it as { hr: true }).hr === true
}

const SESSION_GROUPS = [
  {
    name: 'web-app',
    items: [
      { to: '/sessions/demo-1', title: '把 parse.ts 换成结构化解析', state: 'var(--state-running)', count: '14 步' },
      { to: '/sessions/demo-2', title: '看一下这个项目主要是做什么的', state: 'var(--state-idle)', count: '已完成' },
    ],
  },
  {
    name: 'api-server',
    items: [
      { to: '/sessions/demo-3', title: '给订单接口补测试', state: 'var(--state-idle)', count: '已完成' },
      { to: '/sessions/demo-4', title: '修登录态过期不跳转', state: 'var(--state-error)', count: '中断' },
    ],
  },
]

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(1)

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
      toast(ok ? `已执行「${name}」` : '当前没有可编辑的目标')
    })

  const toggleTheme = act(() => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题')
  })

  const zoomBy = (delta: number | null) =>
    act(() => {
      zoomRef.current = delta === null ? 1 : Math.min(1.5, Math.max(0.7, zoomRef.current + delta))
      document.body.style.zoom = String(zoomRef.current)
      toast(`缩放 ${Math.round(zoomRef.current * 100)}%`)
    })

  const toggleFullscreen = act(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  })

  const toggleSide = act(() => {
    document.body.classList.toggle('noside')
    toast(document.body.classList.contains('noside') ? '侧边栏已隐藏' : '侧边栏已显示')
  })

  const goSettingsSec = (sec: string) => act(() => navigate('/settings', { state: { sec } }))

  const MENUS: { id: string; label: string; items: MItem[] }[] = [
    {
      id: 'file',
      label: '文件',
      items: [
        { label: '新对话', kbd: '⌃N', run: act(() => navigate('/')) },
        { label: '新建临时对话', kbd: '⌃⇧N', run: say('已开启临时对话——关闭后不会保留在历史里（mock）') },
        { label: '新建窗口', run: say('演示：新建窗口') },
        { hr: true },
        { label: '打开文件夹…', kbd: '⌃O', run: say('演示：打开文件夹（桌面版弹出系统选择框）') },
        { hr: true },
        { label: '关闭会话', kbd: '⌃W', run: say('已关闭当前会话（mock）') },
        { hr: true },
        { label: '退出', kbd: '⌃Q', run: act(() => window.close()) },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { label: '撤销', kbd: '⌃Z', run: editCmd('undo', '撤销') },
        { label: '重做', kbd: '⌃⇧Z', run: editCmd('redo', '重做') },
        { hr: true },
        { label: '剪切', kbd: '⌃X', run: editCmd('cut', '剪切') },
        { label: '复制', kbd: '⌃C', run: editCmd('copy', '复制') },
        { label: '粘贴', kbd: '⌃V', run: editCmd('paste', '粘贴') },
        { hr: true },
        { label: '全选', kbd: '⌃A', run: editCmd('selectAll', '全选') },
        { hr: true },
        { label: '设置…', kbd: '⌃,', run: act(() => navigate('/settings')) },
      ],
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { label: '切换侧边栏', kbd: '⌃B', run: toggleSide },
        { label: '切换变更/文件面板', kbd: '⌃J', run: say('工作台右侧面板开关在标题栏（演示）') },
        { hr: true },
        { label: '工作台', run: act(() => navigate('/sessions/demo-1')) },
        { label: '回放时间轴', kbd: '⌃R', run: act(() => navigate('/sessions/demo-1/replay')) },
        { hr: true },
        { label: '切换深色/浅色主题', run: toggleTheme },
        { hr: true },
        { label: '放大', kbd: '⌃⇧=', run: zoomBy(0.1) },
        { label: '缩小', kbd: '⌃-', run: zoomBy(-0.1) },
        { label: '实际大小', kbd: '⌃0', run: zoomBy(null) },
        { hr: true },
        { label: '切换全屏', kbd: 'F11', run: toggleFullscreen },
        { hr: true },
        { label: '状态与异常', run: act(() => navigate('/sessions/demo-1/error')) },
        { label: '崩溃恢复（演示入口）', run: act(() => navigate('/sessions/demo-1/recovery')) },
      ],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { label: '文档', run: say('演示：打开 Lcode 文档（桌面版跳转官网）') },
        { label: '显示键盘快捷键', kbd: '⌃/', run: goSettingsSec('keys') },
        { hr: true },
        { label: '故障排除', run: say('doctor 检查完成：运行环境正常 · 3 项全部通过（mock）') },
        { label: '反馈…', run: say('感谢反馈！演示版暂不收集反馈内容') },
        { hr: true },
        { label: '检查更新…', run: say('当前已是最新版本 v1.0.0（mock）') },
        { label: '关于 Lcode', run: say('Lcode v1.0.0 · 本地优先的 AI 编码工作台') },
      ],
    },
  ]

  const isSettings = pathname.startsWith('/settings')

  return (
    <div className="shell">
      <div className="menubar" ref={barRef}>
        {/* 侧栏收起/展开（WorkBuddy 排版：左上角第一个位置是面板开关，其后紧跟菜单） */}
        {!isSettings && (
          <button className="mtoggle" title="收起/显示左侧栏" aria-label="收起/显示左侧栏" onClick={toggleSide}>
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
            <div className="shead">工作区</div>
            <nav className="snav">
              <a className="new" href="#/" onClick={(e) => { e.preventDefault(); navigate('/') }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                新对话
              </a>
              <a href="#" onClick={(e) => { e.preventDefault(); toast('演示：打开文件夹') }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
                打开文件夹…
              </a>
            </nav>
            {SESSION_GROUPS.map((g) => (
              <div key={g.name} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
                <div className="sgroup">{g.name}</div>
                <div className="slist">
                  {g.items.map((it) => (
                    <NavLink
                      key={it.to}
                      to={it.to}
                      className={({ isActive }) => 'sitem' + (isActive ? ' on' : '')}
                    >
                      <i className="st" style={{ background: it.state }} />
                      {it.title}
                      <span className="cnt">{it.count}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
            <div className="acct">
              <div className="av">J</div>
              <div>
                <div className="nm">jiahao</div>
                <div className="em">本地用户</div>
              </div>
              <button className="ticon" title="设置（Ctrl+,）" onClick={() => navigate('/settings')}>
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
