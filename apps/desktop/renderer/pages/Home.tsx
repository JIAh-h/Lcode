import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ComposerBar, type ComposerSendInput } from '../components/ComposerBar.tsx'
import { toast } from '../components/toast.ts'
import { t } from '../i18n/index.ts'
import { notifySessionChanged, sessionBridge } from '../store/sessionBridge.ts'
import type { AgentPresetId } from '../store/agentPresetSync.ts'
import { agentPresetLabel, chooseAgentPreset, listAgentPresets, type AgentPresetOption } from '../store/agentPresetSync.ts'
import { PopMenu } from '../components/PopMenu.tsx'

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
  /** 新会话的 Agent 模式：standard（默认）或 creator（多一个 run_code） */
  const [agentPreset, setAgentPreset] = useState<AgentPresetId>('standard')
  const [agentPresets, setAgentPresets] = useState<readonly AgentPresetOption[]>([])
  /*
   * 待信任确认的提交（docs/12 工作区信任）。
   *
   * 非 null 时弹出信任确认框：用户点「信任」→ 写信任并继续创建会话；
   * 点「保持只读」→ 不写信任、照常创建（只读下模型只能读，写/执行被策略拦）。
   * 修复：之前信任框在进会话页之后才弹，而消息已经发出去了——模型先跑起来，
   * 用户还没做信任决定。
   */
  const [pendingTrust, setPendingTrust] = useState<{
    readonly path: string
    readonly title: string
    readonly value: string
    readonly attachments: readonly { readonly path: string }[]
    readonly skills: readonly string[]
    readonly images: readonly unknown[]
    readonly asRouter: boolean
    readonly agentPreset: AgentPresetId
    /** 「信任」按钮用它写信任状态；undefined = 桥未暴露（按钮退化为只读继续） */
    readonly trustSet: ((i: unknown) => Promise<unknown>) | undefined
  } | null>(null)
  /** submit 时保存的桥引用：确认框的回调晚于 submit 执行，闭包里的 api 可能已过期 */
  const trustApiRef = useRef<{
    readonly session: { create(i: unknown): Promise<{ session_id: string }> }
    readonly agent: { send(i: unknown): Promise<unknown> }
  } | null>(null)
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

  /*
   * 「选择项目」只列**已信任**的工作区（docs/12 工作区信任）。
   *
   * 之前从会话记录取 workspace 去重、不做任何过滤——于是一次性的临时目录
   * 也会永远留在列表里（实测积压了一堆 ws-probe-* / Temp 下的目录）。
   * 只留已信任的：用过的临时目录若被「保持只读」跳过，自然不再出现；
   * 归档工作区在设置页撤销信任后也从这里消失。
   *
   * 并行取信任清单与会话列表：两个请求都很轻，不必串行。
   */
  useEffect(() => {
    const api = sessionBridge()
    const trustApi = window.lcode?.workspaceTrust
    if (api === undefined) return
    void Promise.all([
      api.list(),
      trustApi?.list().catch(() => []) ?? Promise.resolve([]),
    ])
      .then(([result, trustedRaw]) => {
        /*
         * **路径形状必须先统一再比对**（实测踩过两个坑）：
         * 1. 字段名：信任清单是 `path`（workspace-trust.ts），不是 `workspace`；
         * 2. 分隔符：信任清单存反斜杠（`D:\li\X`），会话记录存正斜杠（`D:/li/X`）——
         *    直接 `Set.has()` 永远匹配不上，列表会恒为空。
         * 统一成正斜杠 + 小写（Windows 不区分大小写）后再比。
         */
        const normalize = (input: string): string => input.replaceAll('\\', '/').toLowerCase()
        const trusted = new Set<string>()
        for (const item of Array.isArray(trustedRaw) ? trustedRaw : []) {
          if (typeof item !== 'object' || item === null) continue
          const row = item as { path?: unknown }
          if (typeof row.path === 'string') trusted.add(normalize(row.path))
        }
        const seen = new Set<string>()
        const next: Proj[] = []
        for (const item of result.items) {
          if (item.workspace === null || seen.has(item.workspace)) continue
          if (!trusted.has(normalize(item.workspace))) continue
          seen.add(item.workspace)
          const name = item.workspace.split(/[\\/]/).filter(Boolean).pop() || item.workspace
          next.push({ name, path: item.workspace })
        }
        setProjects(next)
      })
      .catch(() => setProjects([]))
  }, [])

  /* 可选模式清单（设置页里标记为"可选"的那些） */
  useEffect(() => {
    let alive = true
    void listAgentPresets().then((result) => {
      if (!alive) return
      setAgentPresets(result.presets.filter((item) => item.available))
      if (result.current?.preset !== undefined) setAgentPreset(result.current.preset)
    })
    return () => {
      alive = false
    }
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

  /** 查某路径的信任状态：'trusted' / 'untrusted' / 'unknown'（拿不到桥时按未知处理） */
  const trustStateFor = async (path: string): Promise<'trusted' | 'untrusted' | 'unknown'> => {
    try {
      const api = (globalThis as unknown as {
        lcode?: { workspaceTrust?: { list(): Promise<unknown> } }
      }).lcode
      if (api?.workspaceTrust === undefined) return 'unknown'
      const value = await api.workspaceTrust.list()
      const entries = Array.isArray(value) ? value : []
      const hit = entries.find(
        (item) => typeof item === 'object' && item !== null &&
          (item as { workspace?: unknown }).workspace === path,
      ) as { trusted?: unknown } | undefined
      if (hit === undefined) return 'untrusted'
      return hit.trusted === true ? 'trusted' : 'untrusted'
    } catch {
      // 查询失败不阻断建会话：进会话页后仍会弹信任确认（原有兜底）
      return 'unknown'
    }
  }

  const submit = async ({ attachments, skills, images }: ComposerSendInput) => {
    const value = text.trim()
    if (value.length === 0 && images.length === 0 && attachments.length === 0) return
    const api = (
      globalThis as unknown as {
        lcode?: {
          session?: { create(i: unknown): Promise<{ session_id: string }> }
          agent?: { send(i: unknown): Promise<unknown> }
          workspaceTrust?: {
            list(): Promise<unknown>
            set(i: unknown): Promise<unknown>
          }
        }
      }
    ).lcode
    if (api?.session === undefined || api.agent === undefined) {
      toast(t('当前环境没有主进程桥，无法新建对话'))
      return
    }
    // 确认框的回调晚于本函数执行，把桥引用存到 ref 里避免闭包过期
    trustApiRef.current = { session: api.session, agent: api.agent }
    // 信任桥单独存：确认框「信任」按钮需要它
    const trustSet = api.workspaceTrust?.set.bind(api.workspaceTrust)
    /*
     * **信任前置检查**（修复：新建会话弹了信任框、模型却已开始回复）。
     *
     * 旧流程：session.create → agent.send → 进工作区页才弹信任框。
     * 信任框是纯展示层判断，不阻断任何东西——于是模型已经跑起来了。
     *
     * 现在：选了项目且未信任时，**先弹确认、后创建会话**。
     * 「信任」→ 写信任 → 照常创建并发消息；「保持只读」→ 照常创建并发消息
     * （只读下模型只能读，写/执行会被策略拦——这与进入会话页后确认的行为一致）。
     */
    if (proj !== null) {
      const trust = await trustStateFor(proj.path)
      if (trust === 'untrusted') {
        const title = (value.split('\n')[0] ?? '').slice(0, 40)
        // pendingTrust 里带 trustSet：确认框「信任」按钮要用它写信任状态
        setPendingTrust({
          path: proj.path, title, value, attachments, skills, images, asRouter, agentPreset,
          trustSet,
        })
        return
      }
    }
    void startSession({
      attachments, skills, images,
      titleBase: value.split('\n')[0] ?? '',
      api: { session: api.session, agent: api.agent },
    })
  }

  /*
   * 真正创建会话并发首句。从 submit 拆出来是因为信任确认也可能走到这里：
   * 用户点「信任」或「保持只读」之后，从这里继续，不再重复检查。
   */
  const startSession = async (input: {
    readonly attachments: readonly { readonly path: string }[]
    readonly skills: readonly string[]
    readonly images: readonly unknown[]
    readonly titleBase: string
    readonly api: {
      readonly session: { create(i: unknown): Promise<{ session_id: string }> }
      readonly agent: { send(i: unknown): Promise<unknown> }
    }
  }): Promise<void> => {
    try {
      const title =
        input.titleBase.slice(0, 40) ||
        (input.attachments.length > 0
          ? (input.attachments[0]?.path.split(/[\\/]/).filter(Boolean).pop() ?? t('附件'))
          : t('图片'))
      // 没选项目就不带 cwd：会话会进入侧栏「最近任务」，不隐式绑定当前目录
      const created = await input.api.session.create({
        ...(proj === null ? {} : { cwd: proj.path }),
        title,
        ...(asRouter ? { role: 'router' } : {}),
        // Agent 模式在创建时确定：creator 多一个 run_code，用来写脚本 / 造插件（docs/30 §6）
        ...(agentPreset === 'standard' ? {} : { preset: agentPreset }),
      })
      // 首句**在这里就发出去**：用户已经表达完了意图，没必要进去再发一次
      await input.api.agent.send({
        session_id: created.session_id,
        text: text,
        ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
        ...(input.skills.length === 0 ? {} : { skills: input.skills }),
        ...(input.images.length === 0 ? {} : { images: input.images }),
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
        {/*
         * 项目 + 模式：**输入框外的一行**。
         *
         * 放在 `.cin` 里面（旧布局）会把"这次在哪个目录做/用哪套工具"和"要说什么"
         * 混成一体，视觉上像输入框的一部分。这两件事都属于"这一轮的前提"，
         * 独立成行更好懂，也不会把气泡边框撑成两段。
         */}
        <div className="hinputmeta">
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
          {/*
           * Agent 模式：与项目选择同一行、同在输入框外，用下拉呈现。
           *
           * 用下拉而不是并排 chip：模式将来可能不止两个（DSH 就有四个），
           * 平铺会把这一行撑成一排按钮，和"选择项目"抢注意力。
           */}
          {agentPresets.length > 1 ? (
            <PopMenu
              buttonClass="proj pick"
              trigger={
                <>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M8 1.8l1.6 3.9 4.2.35-3.2 2.75.98 4.1L8 10.8l-3.58 2.1.98-4.1L2.2 6.05l4.2-.35L8 1.8z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {agentPresetLabel(agentPreset)}
                  <span className="pm-chev" aria-hidden="true">▾</span>
                </>
              }
              title="Agent 模式"
              header="用哪套工具干活"
              width={280}
              items={agentPresets.map((item) => ({
                id: item.id,
                label: item.name,
                hint: item.description,
                checked: item.id === agentPreset,
              }))}
              onSelect={(id) => {
                const next = id as AgentPresetId
                if (next === agentPreset) return
                setAgentPreset(next)
                // 记住选择：下次新建会话按这个默认走（与设置页那个值同源）
                void chooseAgentPreset(next).catch(() => undefined)
              }}
            />
          ) : null}
        </div>
        <div className="cin">
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
      {/*
       * 信任确认框（docs/12 工作区信任）：**在创建会话之前**弹出。
       * 与会话页里那个同款；确认后从 startSession 继续完整流程。
       * 「保持只读」不写信任——只读下模型只能读，写/执行被策略拦。
       */}
      {pendingTrust !== null && (
        <div className="dropmask" style={{ zIndex: 60 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal" style={{ width: 500 }}>
            <div className="mh">
              <h3 style={{ margin: 0 }}>{t('信任此文件夹？')}</h3>
            </div>
            <div className="mb" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span>{t('未信任的文件夹只能读取。信任后，模型可以在此文件夹中修改文件并执行命令。')}</span>
              <span className="src mono">{pendingTrust.path}</span>
            </div>
            <div className="mf" style={{ justifyContent: 'flex-end' }}>
              <button
                className="btn"
                onClick={() => {
                  const pending = pendingTrust
                  setPendingTrust(null)
                  // 「保持只读」不写信任：只读下模型只能读，写/执行被策略拦
                  const api = trustApiRef.current
                  if (api === null) return
                  void startSession({
                    attachments: pending.attachments,
                    skills: pending.skills,
                    images: pending.images,
                    titleBase: pending.title,
                    api,
                  })
                }}
              >
                {t('保持只读')}
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const pending = pendingTrust
                  setPendingTrust(null)
                  // 先写信任再建会话：这样模型的第一个请求就运行在已信任的目录里
                  pending.trustSet?.({ workspace: pending.path, trusted: true }).catch(() => undefined)
                  const api = trustApiRef.current
                  if (api === null) return
                  void startSession({
                    attachments: pending.attachments,
                    skills: pending.skills,
                    images: pending.images,
                    titleBase: pending.title,
                    api,
                  })
                }}
              >
                {t('信任此文件夹')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
