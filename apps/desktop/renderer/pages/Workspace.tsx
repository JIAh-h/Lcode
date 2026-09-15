import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ComposerBar } from '../components/ComposerBar.tsx'
import { SessionStream } from '../components/SessionStream.tsx'
import { toast } from '../components/toast.ts'
import { t } from '../i18n/index.ts'

/**
 * P2 工作台（按 webapp 原型 §552-747 1:1 移植）。
 * 结构：本地标题行（面包屑 + 搜索/回放/面板开关）+ 中间会话栏（whead → 用户消息 → 过程卡/总结卡 → 输入框）
 * + 右栏「变更 / 文件」面板（288px，可整体隐藏）。
 * 两种状态：任务进行中（实时过程 + 等待确认条）/ 任务已完成（过程记录 + 最终总结卡），顶部 seg 切换。
 */

type Tab = 'changes' | 'files'

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
        <div className="dh">{t('新文件 · 22 行')}</div>
        <div className="dl add">
          <span className="ln">1</span>+import {'{ describe, it, expect }'} from 'vitest'
        </div>
        <div className="dmore">{t('共 22 行新增')}</div>
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

function RightPanel({ tab, setTab }: { tab: Tab; setTab: (which: Tab) => void }) {
  const [openFile, setOpenFile] = useState<string | null>(CHANGES[0]?.fn ?? null)
  return (
    <aside className="right">
      <div className="rtabs">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          {t('变更')}
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          {t('文件')}
        </button>
      </div>
      {tab === 'changes' ? (
        <div className="rpanel">
          <div className="rscope">
            <span className="chip">{t('本轮 · 第 2 轮')}</span> {t('4 个文件改动')}
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
            <span className="chip">{t('工作区')}</span> web-app
          </div>
          {['📁 src/', '📁 utils/', 'package.json', 'README.md'].map((f) => (
            <div className="fitem" key={f}>
              <div className="frow" onClick={() => toast(t('演示：打开文件'))}>
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
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('changes')
  const [text, setText] = useState('')
  /** 本轮是否在跑（由会话流回报；用于表达"运行中"的输入语义） */
  const [agentRunning, setAgentRunning] = useState(false)

  /**
   * 发送当前输入。
   *
   * **不把发送成功当作"拿到回复"**：`agents.send` 只返回入队回执（21 §2.2），
   * 本轮的结果由事件流推回来（`SessionStream` 订阅）。所以这里清空输入框后就不管了
   * ——回复会自己出现，运行态由流回报。
   */
  const send = () => {
    const value = text.trim()
    if (value === '' || sessionId === undefined) return
    const api = (globalThis as unknown as { lcode?: { agent?: { send(i: unknown): Promise<unknown> } } }).lcode?.agent
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法发送'))
      return
    }
    setText('')
    void api.send({ session_id: sessionId, text: value }).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : t('发送失败'))
    })
  }

  return (
    <div className="workspace">
      {/* 本地标题行（原型 P2 titlebar：面包屑 + 搜索/回放/面板开关） */}
      <div className="wstitlebar">
        <span className="wscumb">web-app / 把 parse.ts 换成结构化解析</span>
        <span className="wsp" />
        <button className="ticon" title={t('搜索会话')} onClick={() => toast(t('演示：搜索会话'))}>
          ⌕
        </button>
        <button
          className="ticon"
          title={t('回放时间轴')}
          onClick={() => navigate(`/sessions/${sessionId ?? 'demo-1'}/replay`)}
        >
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
            <rect x="10" y="2.5" width="4.5" height="11" rx="1" fill="currentColor" opacity=".28" stroke="none" />
          </svg>
        </button>
      </div>
      <div className="wsrow">
        <div className="mid">
        <div className="stream">
          <div className="col">
            {/* 真实会话流（T5.4）。此前这里是一张写死的总结卡（"parse.ts 已切换为
                结构化解析…"），那是原型阶段的展示壳——它让"工作台有内容"看起来成立，
                但内容与用户说的话毫无关系。 */}
            <SessionStream sessionId={sessionId ?? ''} onSendStateChange={setAgentRunning} />
          </div>
        </div>
        <div className="cinput">
          <div className="cin">
            <ComposerBar
              value={text}
              onChange={setText}
              onSend={send}
              /* 运行中仍然允许输入（引擎在步边界取用，21 §2.2 的 steer）——
                 只是把按钮标题改成「补充要求」，让用户知道这句会在下一步生效 */
              sendTitle={agentRunning ? '补充要求' : '发送'}
              placeholder={t('继续交代任务，或补充新的要求…（运行中也可以输入，会在下一步生效）')}
            />
          </div>
        </div>
      </div>

      {/* 右栏：变更 / 文件（面板开关在标题行） */}
        {panelOpen && <RightPanel tab={tab} setTab={setTab} />}
      </div>
    </div>
  )
}
