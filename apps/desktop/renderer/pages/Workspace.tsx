import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from '../components/toast.ts'

/**
 * P2 工作台（按 webapp 原型 §552-747 1:1 移植）。
 * 结构：本地标题行（面包屑 + 搜索/回放/面板开关）+ 中间会话栏（whead → 用户消息 → 过程卡/总结卡 → 输入框）
 * + 右栏「变更 / 文件」面板（288px，可整体隐藏）。
 * 两种状态：任务进行中（实时过程 + 等待确认条）/ 任务已完成（过程记录 + 最终总结卡），顶部 seg 切换。
 */

type Tab = 'changes' | 'files'

/* ───────── 过程行（.op） ───────── */

function OpRow({
  ic,
  verb,
  arg,
  meta,
  variant,
  ds,
  children,
  onRun,
}: {
  ic: string
  verb: string
  arg?: string
  meta?: string
  variant?: 'dim' | 'stage' | 'now' | 'clickable'
  ds?: { add: string; del: string }
  children?: ReactNode
  onRun?: () => void
}) {
  const [open, setOpen] = useState(false)
  if (variant === 'stage') {
    return (
      <div className="op stage">
        <span className="txt">{verb}</span>
      </div>
    )
  }
  return (
    <>
      <div
        className={'op' + (variant ? ' ' + variant : '')}
        onClick={variant === 'clickable' ? () => setOpen(!open) : onRun}
      >
        <span className="ic">{ic}</span>
        <span className={'verb' + (variant === 'now' ? ' shimmer' : '')}>{verb}</span>
        {arg && <span className="arg">{arg}</span>}
        {ds && (
          <span className="ds">
            <span className="add">+{ds.add}</span> <span className="del">−{ds.del}</span>
          </span>
        )}
        {meta && <span className="meta">{meta}</span>}
      </div>
      {variant === 'clickable' && open && <div className="opdetail open">{children}</div>}
    </>
  )
}

/* ───────── 过程卡（.ops） ───────── */

function OpsCard({
  live,
  head,
  children,
}: {
  live?: boolean
  head: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className={'ops' + (live ? ' live' : '') + (open ? ' open' : '')}>
      <div className="ohead" onClick={() => setOpen(!open)}>
        <div className="oic">⚙</div>
        <div className="ot">{head}</div>
        <svg className="ochev" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M4 2.5l4 3.5-4 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {open && <div className="obody">{children}</div>}
    </div>
  )
}

/** 只读文件详情 diff */
function ReadDiff({ file }: { file: string }) {
  return (
    <div className="diff">
      <div className="dh">{file} · 只读</div>
      <div className="dl ctx">
        <span className="ln">1</span>import {'{ z }'} from 'zod'
      </div>
      <div className="dl ctx">
        <span className="ln">2</span>
      </div>
      <div className="dl ctx">
        <span className="ln">3</span>export function parse(raw) {'{'}
      </div>
      <div className="dl ctx">
        <span className="ln">4</span> const parsed = JSON.parse(raw)
      </div>
      <div className="dmore">还有 28 行（已折叠）</div>
    </div>
  )
}

function SearchDiff() {
  return (
    <div className="diff">
      <div className="dh">搜索 “parse(” · 11 处，显示 3 处</div>
      <div className="dl ctx">
        <span className="ln"> </span>src/api/orders.ts:42 const order = parse(body)
      </div>
      <div className="dl ctx">
        <span className="ln"> </span>src/api/users.ts:18 const user = parse(body)
      </div>
      <div className="dl ctx">
        <span className="ln"> </span>src/jobs/sync.ts:77 const payload = parse(buf.toString())
      </div>
    </div>
  )
}

/* ───────── 最终总结卡（.reply） ───────── */

function FinalReply({ onOpenPanel }: { onOpenPanel: (tab: Tab) => void }) {
  return (
    <div className="reply">
      <div className="rhead">
        <div className="ravatar">L</div>
        <div className="rname">Lcode</div>
        <span className="rmark">
          <span className="ok">✓ 任务完成</span>· 用时 2 分 4 秒
        </span>
      </div>
      <div className="rbody">
        <h4>parse.ts 已切换为结构化解析，测试全部通过</h4>
        <ul>
          <li>
            <a className="filelink">utils/parse.ts</a> — 手写校验换成 <code>zod</code> schema，
            <code>parse()</code> 现在返回强类型结果
          </li>
          <li>
            <a className="filelink">utils/__tests__/parse.test.ts</a> — 新增 4 个用例，覆盖正常输入、缺字段、错误类型
          </li>
          <li>
            4 个调用方（<code>orders.ts</code>、<code>users.ts</code> 等）无需改动——返回值结构与之前一致
          </li>
        </ul>
        <h4>验证</h4>
        <p>
          <code>pnpm vitest run utils</code> 通过（14 个用例，0 失败），连续两次运行均通过。
        </p>
        <h4>需要你知道的</h4>
        <p>
          有一个类型定义文件在工作区外面（<code>~/shared/types/order.d.ts</code>），我按你的确认做了修改。这次确认只管了那一次。
        </p>
      </div>
      <div className="racts">
        <button className="ract" onClick={() => onOpenPanel('changes')}>
          🗂 查看本轮所有产物 <span className="n">(6)</span> ›
        </button>
        <button className="ract" onClick={() => onOpenPanel('changes')}>
          📝 查看本轮所有变更 <span className="n">(4)</span> ›
        </button>
      </div>
      <div className="rfoot">
        <button className="micon" title="复制" onClick={() => toast('已复制总结（mock）')}>
          ⧉
        </button>
        <button className="micon" title="赞" onClick={() => toast('已收到（mock）')}>
          👍
        </button>
        <button className="micon" title="踩" onClick={() => toast('已收到（mock）')}>
          👎
        </button>
        <button className="micon" title="朗读" onClick={() => toast('朗读（mock）')}>
          🔊
        </button>
        <button className="micon" title="更多" onClick={() => toast('更多操作（mock）')}>
          ⋯
        </button>
        <span className="tok">
          共消耗 12.4k tokens<span className="dotsep"></span>
          <span className="mdl">◆ Deepseek-V4.1-Flash</span>
        </span>
      </div>
    </div>
  )
}

/* ───────── 右栏：变更 / 文件 ───────── */

const CHANGES: { fn: string; add: string; del: string; diff: ReactNode }[] = [
  {
    fn: 'utils/parse.ts',
    add: '13',
    del: '2',
    diff: (
      <div className="diff">
        <div className="dl ctx">
          <span className="ln">3</span>export function parse(raw) {'{'}
        </div>
        <div className="dl del">
          <span className="ln">4</span>- const parsed = JSON.parse(raw)
        </div>
        <div className="dl add">
          <span className="ln">4</span>+ const parsed = OrderSchema.parse(JSON.parse(raw))
        </div>
        <div className="dl ctx">
          <span className="ln">5</span> return parsed
        </div>
      </div>
    ),
  },
  {
    fn: 'utils/__tests__/parse.test.ts',
    add: '22',
    del: '0',
    diff: (
      <div className="diff">
        <div className="dh">新文件 · 22 行</div>
        <div className="dl add">
          <span className="ln">1</span>+import {'{ describe, it, expect }'} from 'vitest'
        </div>
        <div className="dmore">共 22 行新增</div>
      </div>
    ),
  },
  {
    fn: 'src/api/orders.ts',
    add: '3',
    del: '1',
    diff: (
      <div className="diff">
        <div className="dl ctx">
          <span className="ln">42</span>const order = parse(body)
        </div>
        <div className="dl add">
          <span className="ln">43</span>+if (!order.ok) return badRequest(order.issues)
        </div>
      </div>
    ),
  },
  {
    fn: 'package.json',
    add: '1',
    del: '1',
    diff: (
      <div className="diff">
        <div className="dl del">
          <span className="ln"> </span>-"zod": "^3.22.0"
        </div>
        <div className="dl add">
          <span className="ln"> </span>+"zod": "^3.23.8"
        </div>
      </div>
    ),
  },
]

function RightPanel({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const [openFile, setOpenFile] = useState<string | null>(CHANGES[0]?.fn ?? null)
  return (
    <aside className="right">
      <div className="rtabs">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          变更
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          文件
        </button>
      </div>
      {tab === 'changes' ? (
        <div className="rpanel">
          <div className="rscope">
            <span className="chip">本轮 · 第 2 轮</span> 4 个文件改动
          </div>
          {CHANGES.map((c) => (
            <div className={'fitem' + (openFile === c.fn ? ' open' : '')} key={c.fn}>
              <div className="frow" onClick={() => setOpenFile(openFile === c.fn ? null : c.fn)}>
                <span className="fn">{c.fn}</span>
                <span className="fs">
                  <span className="add">+{c.add}</span> <span className="del">−{c.del}</span>
                </span>
              </div>
              <div className="fdiff">{c.diff}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rpanel">
          <div className="rscope">
            <span className="chip">工作区</span> web-app
          </div>
          {['📁 src/', '📁 utils/', 'package.json', 'README.md'].map((f) => (
            <div className="fitem" key={f}>
              <div className="frow" onClick={() => toast('演示：打开文件')}>
                <span className="fn">{f}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

/* ───────── 页面 ───────── */

export function WorkspacePage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<'run' | 'done'>('run')
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('changes')
  const [text, setText] = useState('')

  const openPanel = (t: Tab) => {
    setTab(t)
    setPanelOpen(true)
  }

  return (
    <div className="workspace">
      {/* 本地标题行（原型 P2 titlebar：面包屑 + 搜索/回放/面板开关） */}
      <div className="wstitlebar">
        <span className="wscumb">web-app / 把 parse.ts 换成结构化解析</span>
        <span className="wsp" />
        <button className="ticon" title="搜索会话" onClick={() => toast('演示：搜索会话')}>
          ⌕
        </button>
        <button className="ticon" title="回放时间轴" onClick={() => navigate(`/sessions/${sessionId ?? 'demo-1'}/replay`)}>
          ⏱
        </button>
        <button
          className={'ptoggle' + (panelOpen ? ' on' : '')}
          title="显示/隐藏面板"
          aria-pressed={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="10" y="2.5" width="4.5" height="11" rx="1" fill="currentColor" opacity=".28" stroke="none" />
          </svg>
        </button>
      </div>
      <div className="wsrow">
        <div className="mid">
        <div className="stream">
          <div className="col">
            <div className="whead">
              <h2>把 parse.ts 换成结构化解析</h2>
              <span className="meta">{state === 'run' ? '整个任务 · 进行中' : '整个任务 · 已完成'}</span>
              {state === 'run' ? (
                <span className="live">
                  <i></i>运行中
                </span>
              ) : null}
              <span className="p2seg seg">
                <button className={state === 'run' ? 'on' : ''} onClick={() => setState('run')}>
                  任务进行中
                </button>
                <button className={state === 'done' ? 'on' : ''} onClick={() => setState('done')}>
                  任务已完成
                </button>
              </span>
            </div>

            <div className="umsg">把 utils/parse.ts 里的手写 JSON 解析换成结构化解析，并补一个测试。</div>

            {state === 'run' ? (
              <>
                <OpsCard
                  live
                  head={
                    <>
                      <b className="elapsed">正在工作…</b> <span>已进行 2 分 4 秒</span> · 5 个操作
                    </>
                  }
                >
                  <OpRow ic="✦" verb="深度思考" meta="3s" variant="dim" />
                  <OpRow ic="📄" verb="读取文件" arg="utils/parse.ts" meta="42ms" variant="clickable">
                    <ReadDiff file="utils/parse.ts" />
                  </OpRow>
                  <OpRow ic="⌕" verb="搜索" arg="parse(" meta="4 个文件" variant="clickable">
                    <SearchDiff />
                  </OpRow>
                  <OpRow ic="✦" verb="已定位 4 处调用方，都按“什么都可能返回”写的，我一起改。" variant="stage" />
                  <OpRow ic="✎" verb="修改文件" arg="utils/parse.ts" ds={{ add: '13', del: '2' }} meta="8ms" />
                  <OpRow
                    ic="✎"
                    verb="修改文件"
                    arg="utils/__tests__/parse.test.ts"
                    ds={{ add: '22', del: '0' }}
                    meta="6ms"
                  />
                  <OpRow ic="▶" verb="运行命令" arg="pnpm vitest run utils" meta="运行中…" variant="now" />
                </OpsCard>
                <div className="pending">
                  <span className="ptag">等待确认</span>
                  <span className="ptxt">要改一个工作区外面的文件</span>
                  <button onClick={() => navigate(`/sessions/${sessionId ?? 'demo-1'}/ask`)}>去确认</button>
                </div>
              </>
            ) : (
              <>
                <OpsCard head={<><b>过程记录</b> · 2 轮 · 14 个操作 · 用时 2 分 4 秒</>}>
                  <OpRow ic="✦" verb="深度思考" meta="3s" variant="dim" />
                  <OpRow ic="📄" verb="读取文件" arg="utils/parse.ts" meta="42ms" />
                  <OpRow ic="⌕" verb="搜索" arg="parse(" meta="4 个文件" />
                  <OpRow ic="✦" verb="已定位 4 处调用方，都按“什么都可能返回”写的，我一起改。" variant="stage" />
                  <OpRow ic="✎" verb="修改文件" arg="utils/parse.ts" ds={{ add: '13', del: '2' }} meta="8ms" />
                  <OpRow
                    ic="✎"
                    verb="修改文件"
                    arg="utils/__tests__/parse.test.ts"
                    ds={{ add: '22', del: '0' }}
                    meta="6ms"
                  />
                  <OpRow ic="▶" verb="运行命令" arg="pnpm vitest run utils" meta="14 通过 · 2.1s" />
                  <OpRow ic="✦" verb="改完了，测试也过了；但类型定义在工作区外面，需要你确认。" variant="stage" />
                  <OpRow
                    ic="✎"
                    verb="修改文件"
                    arg="~/shared/types/order.d.ts"
                    ds={{ add: '6', del: '2' }}
                    meta="已确认"
                  />
                  <OpRow ic="▶" verb="运行命令" arg="pnpm vitest run utils" meta="14 通过 · 1.8s" />
                </OpsCard>
                <FinalReply onOpenPanel={openPanel} />
              </>
            )}
          </div>
        </div>
        <div className="cinput">
          <div className="cin">
            <textarea
              placeholder="继续交代任务，或补充新的要求…（运行中也可以输入，会在下一步生效）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                  setText('')
                  toast('已发送（mock）')
                }
              }}
            />
            <div className="cinbar">
              <button className="tbtn">＋</button>
              <button className="tbtn">权限：标准 ▾</button>
              <button className="tbtn">Deepseek-V4.1 ▾</button>
              <button
                className="send"
                title="发送"
                onClick={() => {
                  if (!text.trim()) return
                  setText('')
                  toast('已发送（mock）')
                }}
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 右栏：变更 / 文件（面板开关在标题行） */}
        {panelOpen && <RightPanel tab={tab} setTab={setTab} />}
      </div>
    </div>
  )
}
