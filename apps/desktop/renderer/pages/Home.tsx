import { useState } from 'react'
import type { DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from '../components/toast.ts'

/**
 * P1 首页（文档 19 §3.1，布局对齐 Codex）。
 * 首次启动直接到这里——问候语 + 能力卡片 + 输入框，整体垂直居中。
 * 未选择项目时输入框上方是「选择项目」：可选左侧已有项目、新建项目（系统文件夹选择框）、或直接把文件夹拖进窗口。
 * 模型配置在「设置 → 模型」；未配模型时，发出第一条消息后才提示（不阻断输入）。
 */

type Proj = { name: string; path: string }

/** 左侧已有的项目（与侧栏分组一致；后续接入真实数据源） */
const EXISTING_PROJECTS = ['web-app', 'api-server']

/** 能力卡片：点击把示例任务填入输入框（沿用原型的可点击设计） */
const CARDS: { ic: string; title: string; desc: string; preset: string }[] = [
  { ic: '⌕', title: '探索并理解代码', desc: '只读，不会改动任何文件', preset: '帮我梳理这个项目的结构和主要功能' },
  { ic: '✎', title: '构建新功能或工具', desc: '读取、编辑、运行，改动前先给你看', preset: '我想构建一个新功能：' },
  { ic: '✓', title: '审查代码并提出建议', desc: '找出问题与隐患，给出修改建议', preset: '审查一下最近的改动，指出问题与风险' },
  { ic: '⚒', title: '修复问题与失败', desc: '跑测试、看日志、定位并修掉', preset: '现在有报错/测试不过，帮我定位原因' },
]

export function HomePage() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [proj, setProj] = useState<Proj | null>(null)
  const [pickOpen, setPickOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const submit = () => {
    if (text.trim().length === 0) return
    navigate('/sessions/demo-1')
  }

  const pickExisting = (name: string) => {
    setProj({ name, path: '~/' + name })
    setPickOpen(false)
  }

  const pickFolder = async () => {
    setPickOpen(false)
    const path = await window.lcode.chooseFolder()
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path
    setProj({ name, path })
    toast(`已选择项目：${name}`)
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
      toast('未能识别拖入内容的路径，请改为点击「选择项目」')
      return
    }
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path
    setProj({ name, path })
    toast(`已选择项目：${name}`)
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
            我们应该在 <em>{proj.name}</em> 中做些什么？
          </>
        ) : (
          '我们要构建什么？'
        )}
      </h1>
      <div className="hcards">
        {CARDS.map((c) => (
          <div
            key={c.title}
            className="hcard"
            title="点击填入示例任务"
            onClick={() => setText(c.preset)}
          >
            <div className="ic">{c.ic}</div>
            <h3>{c.title}</h3>
            <p>{c.desc}</p>
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
                  title="取消选择，重新选择项目"
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
              <span className="pickwrap">
                <button className="proj pick" onClick={() => setPickOpen(!pickOpen)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                  选择项目
                </button>
                {pickOpen && (
                  <div className="pickmenu">
                    <div className="picklab">已有项目</div>
                    {EXISTING_PROJECTS.map((n) => (
                      <a key={n} onClick={() => pickExisting(n)}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M2.5 4.5A1.5 1.5 0 014 3h2l1.5 2H12a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5v-7z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                          />
                        </svg>
                        {n}
                      </a>
                    ))}
                    <hr />
                    <a
                      onClick={() => {
                        void pickFolder()
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      新建项目（选择文件夹…）
                    </a>
                    <div className="pickhint">也可以把文件夹直接拖进窗口</div>
                  </div>
                )}
              </span>
            )}
          </div>
          <textarea
            placeholder={proj ? '描述一个任务，或直接问个问题…' : '描述一个任务，或先在上方选择项目…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            }}
          />
          <div className="cinbar">
            <button className="tbtn">＋</button>
            <button className="tbtn">权限：标准 ▾</button>
            <button className="tbtn">Deepseek-V4.1 ▾</button>
            <button className="send" title="发送" onClick={submit}>
              ↑
            </button>
          </div>
        </div>
      </div>
      {dragOver && <div className="dropmask">松开以打开该文件夹</div>}
    </main>
  )
}
