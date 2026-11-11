import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ComposerBar, type ComposerSendInput } from '../components/ComposerBar.tsx'
import { toast } from '../components/toast.ts'
import { t } from '../i18n/index.ts'
import { notifySessionChanged, sessionBridge } from '../store/sessionBridge.ts'

/**
 * P1 首页（文档 19 §3.1，布局对齐 Codex）。
 * 首次启动直接到这里——问候语 + 能力卡片 + 输入框，整体垂直居中。
 * 未选择项目时输入框上方是「选择项目」：可选左侧已有项目、新建项目（系统文件夹选择框）、或直接把文件夹拖进窗口。
 * 模型配置在「设置 → 模型」；未配模型时，发出第一条消息后才提示（不阻断输入）。
 */

type Proj = { name: string; path: string }

/** 能力卡片：点击把示例任务填入输入框（沿用原型的可点击设计） */
const CARDS: { ic: string; title: string; desc: string; preset: string }[] = [
  {
    ic: '⌕',
    title: '探索并理解代码',
    desc: '只读，不会改动任何文件',
    preset: '帮我梳理这个项目的结构和主要功能',
  },
  {
    ic: '✎',
    title: '构建新功能或工具',
    desc: '读取、编辑、运行，改动前先给你看',
    preset: '我想构建一个新功能：',
  },
  {
    ic: '✓',
    title: '审查代码并提出建议',
    desc: '找出问题与隐患，给出修改建议',
    preset: '审查一下最近的改动，指出问题与风险',
  },
  {
    ic: '⚒',
    title: '修复问题与失败',
    desc: '跑测试、看日志、定位并修掉',
    preset: '现在有报错/测试不过，帮我定位原因',
  },
]

export function HomePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [text, setText] = useState('')
  const [proj, setProj] = useState<Proj | null>(null)
  const [pickOpen, setPickOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [projects, setProjects] = useState<Proj[]>([])
  /**
   * 是否把这次新会话建成**编排调度会话**（Router，docs/26 §3.3）。
   *
   * 默认关闭：日常任务还是单会话，编排是按需启用的能力。
   * 勾上之后模型可以派发 worker，但它自己**没有执行工具**（不能改文件、不能跑命令）。
   */
  const [asRouter, setAsRouter] = useState(false)
  /**
   * 勾选编排会话时，输入区显示的应该是 **Router 自己的模型**（设置里那一栏），
   * 而不是"新对话默认模型"——后者只有 worker 用。不显示的话，用户在勾选后
   * 完全看不出这次会用哪个模型。
   */
  const [routerModel, setRouterModel] = useState<{ provider: string; model: string } | undefined>(undefined)

  useEffect(() => {
    if (!asRouter || routerModel !== undefined) return
    const orch = (globalThis as unknown as { lcode?: { orchestration?: { get(): Promise<unknown> } } }).lcode?.orchestration
    if (orch === undefined) return
    void orch
      .get()
      .then((value) => {
        const stored = value as { routerModel?: { provider?: string; model?: string } | null } | null
        const m = stored?.routerModel
        if (m !== null && m !== undefined && typeof m.provider === 'string' && typeof m.model === 'string') {
          setRouterModel({ provider: m.provider, model: m.model })
        }
      })
      .catch(() => undefined)
  }, [asRouter, routerModel])
  const pickRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const state = location.state as { cwd?: unknown } | null
    if (typeof state?.cwd === 'string' && state.cwd !== '') {
      const name = state.cwd.split(/[\\/]/).filter(Boolean).pop() || state.cwd
      setProj({ name, path: state.cwd })
    }
  }, [location.key, location.state])

  useEffect(() => {
    const api = sessionBridge()
    if (api === undefined) return
    void api
      .list()
      .then((result) => {
        const seen = new Set<string>()
        const next: Proj[] = []
        for (const item of result.items) {
          if (item.workspace === null || seen.has(item.workspace)) continue
          seen.add(item.workspace)
          const name = item.workspace.split(/[\\/]/).filter(Boolean).pop() || item.workspace
          next.push({ name, path: item.workspace })
        }
        setProjects(next)
      })
      .catch(() => setProjects([]))
  }, [])

  /* 点击「选择项目」弹窗外部、或按 Esc 时收起（与 AppShell 菜单栏同一套交互） */
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPickOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  /**
   * 提交任务：**真的建一个会话**，然后进工作台。
   *
   * 之前这里是 `navigate('/sessions/demo-1')`——一个写死的会话 id，
   * 于是无论说什么都进同一个空壳（工作台里显示的还是一张与输入无关的假总结卡）。
   */
  const submit = async ({ attachments, skills, images }: ComposerSendInput) => {
    const value = text.trim()
    if (value.length === 0 && images.length === 0 && attachments.length === 0) return
    const api = (
      globalThis as unknown as {
        lcode?: {
          session?: { create(i: unknown): Promise<{ session_id: string }> }
          agent?: { send(i: unknown): Promise<unknown> }
        }
      }
    ).lcode
    if (api?.session === undefined || api.agent === undefined) {
      toast(t('当前环境没有主进程桥，无法新建对话'))
      return
    }
    try {
      // 标题取首行前若干字（列表里要能认出这是哪次对话）；真正的命名/重命名是后续的事
      const title =
        (value.split('\n')[0] ?? '').slice(0, 40) ||
        (attachments.length > 0
          ? (attachments[0]?.path.split(/[\\/]/).filter(Boolean).pop() ?? t('附件'))
          : t('图片'))
      // 没选项目就不带 cwd：会话会进入侧栏「最近任务」，不隐式绑定当前目录
      const created = await api.session.create({
        ...(proj === null ? {} : { cwd: proj.path }),
        title,
        ...(asRouter ? { role: 'router' } : {}),
      })
      // 首句**在这里就发出去**：用户已经表达完了意图，没必要进去再发一次
      await api.agent.send({
        session_id: created.session_id,
        text: value,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(skills.length === 0 ? {} : { skills }),
        ...(images.length === 0 ? {} : { images }),
      })
      notifySessionChanged()
      navigate(`/sessions/${created.session_id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : t('新建对话失败'))
    }
  }

  const pickExisting = (project: Proj) => {
    setProj(project)
    setPickOpen(false)
  }

  const pickFolder = async () => {
    setPickOpen(false)
    const path = await window.lcode.chooseFolder(t('选择项目文件夹'))
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path
    setProj({ name, path })
    toast(t('已选择项目：{name}', { name }))
  }

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    let path = ''
    try {
      path = window.lcode.pathForFile(file)
    } catch {
      path = ''
    }
    if (!path) {
      toast(t('未能识别拖入内容的路径，请改为点击「选择项目」'))
      return
    }
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path
    setProj({ name, path })
    toast(t('已选择项目：{name}', { name }))
  }

  return (
    <main
      className={'home' + (dragOver ? ' droptarget' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="mark">
        L<span>code</span>
      </div>
      <h1>
        {proj ? (
          <>
            {t('我们应该在')} <em>{proj.name}</em>
            {t('中做些什么？')}
          </>
        ) : (
          t('我们要构建什么？')
        )}
      </h1>
      <div className="hcards">
        {CARDS.map((c) => (
          <div key={c.title} className="hcard" title={t('点击填入示例任务')} onClick={() => setText(t(c.preset))}>
            <div className="ic">{c.ic}</div>
            <h3>{t(c.title)}</h3>
            <p>{t(c.desc)}</p>
          </div>
        ))}
      </div>
      <div className="hinput">
        <div className="cin">
          <div className="projrow">
            {proj ? (
              <span className="proj" title={proj.path}>
                📁 {proj.name}
                <button
                  className="projx"
                  title={t('取消选择，重新选择项目')}
                  onClick={() => {
                    setProj(null)
                    setPickOpen(false)
                  }}
                >
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ) : (
              <span className="pickwrap" ref={pickRef}>
                <button className="proj pick" onClick={() => setPickOpen(!pickOpen)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                  {t('选择项目')}
                </button>
                {pickOpen && (
                  <div className="pickmenu">
                    <div className="picklab">{t('已有项目')}</div>
                    {projects.map((project) => (
                      <a key={project.path} onClick={() => pickExisting(project)}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                          />
                        </svg>
                        {project.name}
                      </a>
                    ))}
                    {projects.length === 0 && <div className="pickhint">{t('还没有打开过项目')}</div>}
                    <hr />
                    <a
                      onClick={() => {
                        void pickFolder()
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      {t('新建项目（选择文件夹…）')}
                    </a>
                    <div className="pickhint">{t('也可以把文件夹直接拖进窗口')}</div>
                  </div>
                )}
              </span>
            )}
          </div>
          <ComposerBar
            value={text}
            onChange={setText}
            onSend={submit}
            placeholder={proj ? t('描述一个任务，或直接问个问题…') : t('描述一个任务；不选择项目时会放进「最近任务」…')}
            orchestrationModel={asRouter ? routerModel : undefined}
          />
          {/*
           * 编排调度会话（docs/26 §3.3）。
           *
           * 放在输入框下方而不是项目行：它改的是"这次会话做什么"，与"在哪个目录做"是两件事。
           * 文案直接说清代价——Router 自己没有执行能力，用户才不会以为它是"更强的会话"。
           */}
          <label className="orchestratetoggle" title={t('勾选后这次会话只做调度：可以派发 worker，但不能自己改文件或执行命令')}>
            <input type="checkbox" checked={asRouter} onChange={(e) => setAsRouter(e.target.checked)} />
            <span>{t('作为编排调度会话（可派发 worker，自己不执行）')}</span>
          </label>
          {/*
           * 判据提示（docs/26 §9.3）。
           *
           * 为什么必须写：勾选之后 Router 连"帮我看看这个函数干嘛的"都会派 worker 去做——
           * 这是对的（Router 不读仓库），但用户不知道，会觉得"这么点事也要起一个会话"。
           * 与其放宽权限让 Router 自己读（会退化成普通会话），不如把判据说清楚。
           */}
          <div className="orchestratehint">
            {t('需要拆分或并行的任务用它；单点问答用普通会话更省。')}
            {asRouter && (
              <span className="orchestratehint-warn">
                {t('已勾选：接下来读代码、跑命令类的问题都会派给 worker 执行，由一个独立会话完成。')}
              </span>
            )}
          </div>
        </div>
      </div>
      {dragOver && <div className="dropmask">{t('松开以打开该文件夹')}</div>}
    </main>
  )
}
