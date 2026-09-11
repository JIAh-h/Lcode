import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from '../components/toast.ts'

/**
 * P5 设置（按 Codex 布局 1:1 移植 webapp 原型）：
 * 顶部「← 返回工作台」+ 搜索框；左侧面包栏（分组导航）；右侧对应分区内容。
 * 分区：个人（常规/外观/键盘快捷键/账户）· 模型 · 权限（权限预设/工作区信任）· 记忆与历史（历史与保留/导出）。
 */

/* ───────── 通用小件 ───────── */

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <button className={'switch' + (on ? ' on' : '')} onClick={onToggle} />
}

function SwRow({ label, desc, init = false }: { label: string; desc: string; init?: boolean }) {
  const [on, setOn] = useState(init)
  return (
    <div className="srow">
      <div className="sl">{label}</div>
      <div className="sr">
        <div className="swrow">
          <Switch on={on} onToggle={() => setOn(!on)} />
          <span className="swd">{desc}</span>
        </div>
      </div>
    </div>
  )
}

function Seg({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o} className={o === value ? 'on' : ''} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  )
}

function SaveBar() {
  const [ok, setOk] = useState(false)
  return (
    <div className="savebar">
      <button
        className="btn primary"
        onClick={() => {
          setOk(true)
          toast('已保存（mock）')
        }}
      >
        保存
      </button>
      {ok && <span className="okmsg">✓ 已保存</span>}
    </div>
  )
}

/* ───────── 分区：常规 ───────── */

function GeneralSection() {
  const [lang, setLang] = useState('中文（简体）')
  return (
    <>
      <h2>常规</h2>
      <div className="sub">基础行为。改动即时生效。</div>
      <div className="sect">
        <div className="sh2">界面语言</div>
        <div className="srow">
          <div className="sl">语言</div>
          <div className="sr">
            <Seg options={['中文（简体）', 'English']} value={lang} onChange={setLang} />
            <span className="src">切换后立即生效，不影响对话内容。</span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">启动</div>
        <div className="srow">
          <div className="sl">启动时</div>
          <div className="sr">
            <div className="field">
              <select defaultValue="打开上次的工作区">
                <option>打开上次的工作区</option>
                <option>进入首页</option>
                <option>打开指定文件夹…</option>
              </select>
            </div>
          </div>
        </div>
        <SwRow label="自动检查更新" desc="每周在后台检查新版本，仅提示，不自动安装" init />
        <SwRow label="崩溃后自动恢复" desc="下次启动时恢复中断的对话并显著标注补记" init />
      </div>
      <div className="sect">
        <div className="sh2">隐私</div>
        <SwRow label="匿名使用统计" desc="只上报功能使用计数，不含任何代码与对话内容" />
      </div>
      <SaveBar />
    </>
  )
}

/* ───────── 分区：外观 ───────── */

const ACCENTS = ['#2563EB', '#7C3AED', '#0D9488', '#D97706']

function AppearanceSection() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [accent, setAccent] = useState('#2563EB')
  const [cb, setCb] = useState(document.documentElement.dataset.cb === 'on')
  const [fs, setFs] = useState('标准')
  return (
    <>
      <h2>外观</h2>
      <div className="sub">主题与显示。此处的改动与菜单「视图 → 切换主题」联动。</div>
      <div className="sect">
        <div className="sh2">主题</div>
        <div className="srow">
          <div className="sl">外观</div>
          <div className="sr">
            <Seg
              options={['浅色', '深色', '跟随系统']}
              value={theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}
              onChange={(v) => {
                setTheme(v === '深色' ? 'dark' : 'light')
                if (v !== '跟随系统') document.documentElement.dataset.theme = v === '深色' ? 'dark' : 'light'
              }}
            />
          </div>
        </div>
        <div className="srow">
          <div className="sl">强调色</div>
          <div className="sr">
            <div className="swatches">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className={'swatch' + (accent === c ? ' on' : '')}
                  style={{ background: c }}
                  onClick={() => {
                    setAccent(c)
                    document.documentElement.style.setProperty('--accent', c)
                    toast('强调色已切换（演示，重启后还原）')
                  }}
                />
              ))}
            </div>
            <span className="src">用于链接、选中态与运行状态指示。</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl">色盲友好 diff</div>
          <div className="sr">
            <div className="swrow">
              <Switch
                on={cb}
                onToggle={() => {
                  const next = !cb
                  setCb(next)
                  document.documentElement.dataset.cb = next ? 'on' : 'off'
                }}
              />
              <span className="swd">增删行改用蓝/橙区分（对红绿色盲更友好）</span>
            </div>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">显示</div>
        <div className="srow">
          <div className="sl">界面字号</div>
          <div className="sr">
            <Seg
              options={['小', '标准', '大']}
              value={fs}
              onChange={(v) => {
                setFs(v)
                document.documentElement.dataset.fs = v === '小' ? 'sm' : v === '大' ? 'lg' : ''
              }}
            />
          </div>
        </div>
        <div className="srow">
          <div className="sl">等宽字体</div>
          <div className="sr">
            <div className="field">
              <select defaultValue="JetBrains Mono">
                <option>JetBrains Mono</option>
                <option>SF Mono</option>
                <option>Consolas</option>
                <option>系统默认</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/* ───────── 分区：键盘快捷键 ───────── */

const KEY_ROWS: [string, string][] = [
  ['新对话', '⌃ N'],
  ['打开设置', '⌃ ,'],
  ['显示/隐藏面板', '⌃ B'],
  ['进入回放', '⌃ R'],
  ['发送消息', 'Enter'],
  ['换行', 'Shift + Enter'],
]

function KeysSection() {
  return (
    <>
      <h2>键盘快捷键</h2>
      <div className="sub">演示版暂不支持改键，点击「修改」会给出提示。</div>
      <div className="sect">
        <div className="sh2">全局</div>
        {KEY_ROWS.map(([desc, combo]) => (
          <div className="krow" key={desc}>
            <span className="kdesc">{desc}</span>
            <span className="kcombo">
              <span className="kbd">{combo}</span>
            </span>
            <button className="kedit" onClick={() => toast('演示版：暂不支持自定义快捷键')}>
              修改
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

/* ───────── 分区：账户 ───────── */

function AccountSection() {
  const [name, setName] = useState('jiahao')
  return (
    <>
      <h2>账户</h2>
      <div className="sub">Lcode 默认使用本地账户，数据不出本机。</div>
      <div className="sect">
        <div className="sh2">资料</div>
        <div className="srow">
          <div className="sl">头像与名称</div>
          <div className="sr">
            <div className="fbox" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div className="avatarlg">J</div>
              <div className="field" style={{ flex: 1 }}>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
          </div>
        </div>
        <div className="srow">
          <div className="sl">登录方式</div>
          <div className="sr">
            <span className="src">
              本地账户 · 无需登录。<b>接入团队版</b>后可同步设置与会话（未接入）。
            </span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">数据位置</div>
        <div className="trow">
          <span className="tp">~/lcode</span>
          <span className="tm">会话、设置与回放数据</span>
          <button onClick={() => toast('已在文件夹中显示（模拟）')}>在文件夹中显示</button>
        </div>
        <div className="trow">
          <span className="tp">~/lcode/sessions</span>
          <span className="tm">JSONL 会话日志</span>
          <button onClick={() => toast('已在文件夹中显示（模拟）')}>在文件夹中显示</button>
        </div>
      </div>
      <div className="savebar">
        <button className="btn danger" onClick={() => toast('已退出本地账户（模拟）——演示环境不会真的清除数据')}>
          退出本地账户
        </button>
      </div>
    </>
  )
}

/* ───────── 分区：模型（WorkBuddy 风格：列表 + 添加模型弹窗） ───────── */

type ModelEntry = { name: string; src: string }

/** 眼睛图标：默认闭眼（密文），点击后睁眼（明文）——i-on=闭眼眉毛，i-off=睁眼 */
const EYE_CLOSED = (
  <svg className="i-on" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 9.5c2.8 3.8 6.2 5.7 10 5.7s7.2-1.9 10-5.7" />
    <path d="M4.6 13.6 3 15.8" />
    <path d="M8.6 15.4 7.7 18" />
    <path d="M12 16.1v2.7" />
    <path d="M15.4 15.4l.9 2.6" />
    <path d="M19.4 13.6 21 15.8" />
  </svg>
)
const EYE_OPEN = (
  <svg className="i-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

/** 长度快捷 chips：单选；再点已选项取消 → 回到「默认」 */
function Chips({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="mmlab">
        {label} <em>（不选则使用该模型默认值）</em>
      </span>
      <div className="tokchips">
        {options.map((o) => (
          <button
            key={o || 'default'}
            type="button"
            className={value === o ? 'on' : ''}
            onClick={() => onChange(o === '' || value === o ? '' : o)}
          >
            {o === '' ? '默认' : o}
          </button>
        ))}
      </div>
    </div>
  )
}

function AddModelModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string, src: string) => void }) {
  const [provider, setProvider] = useState('自定义')
  const [base, setBase] = useState('')
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [showKey, setShowKey] = useState(false) // 默认密文（闭眼）
  const [inTok, setInTok] = useState('')
  const [outTok, setOutTok] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  const save = () => {
    if (!name.trim()) {
      toast('请先填写模型名称')
      nameRef.current?.focus()
      return
    }
    onSave(name.trim(), provider)
  }

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" style={{ width: 640 }}>
        <div className="mh">
          <h3 style={{ margin: 0 }}>添加模型</h3>
          <div className="msp" />
          <button className="ticon" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="mb" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="mmfield">
            <span className="mmlab">
              供应商 <em>（仅支持 OpenAI 兼容协议）</em>
            </span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option>自定义</option>
              <option>DeepSeek</option>
              <option>OpenAI</option>
              <option>Ollama（本地）</option>
            </select>
          </label>
          <label className="mmfield">
            <span className="mmlab">接口地址</span>
            <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1/chat/completions" />
          </label>
          <label className="mmfield">
            <span className="mmlab">API Key</span>
            <span className="mmkey">
              <span className="mmkeybox">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="输入你的 API Key"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className={'mmeye' + (showKey ? ' off' : '')}
                  title={showKey ? '隐藏' : '显示'}
                  onClick={() => setShowKey(!showKey)}
                >
                  {EYE_CLOSED}
                  {EYE_OPEN}
                </button>
              </span>
              <button className="btn" onClick={() => toast('连接正常（模拟）· 120ms')}>
                测试连接
              </button>
            </span>
          </label>
          <label className="mmfield">
            <span className="mmlab">模型名称</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入模型参数值，例如 gpt-4o 或 openai/gpt-4o"
            />
          </label>
          <div style={{ display: 'flex', gap: 18 }}>
            <Chips label="输入" options={['', '32K', '64K', '128K', '256K']} value={inTok} onChange={setInTok} />
            <Chips label="输出" options={['', '8K', '16K', '32K', '64K']} value={outTok} onChange={setOutTok} />
          </div>
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelSection() {
  const [models, setModels] = useState<ModelEntry[]>([
    { name: 'DeepSeek-V4 Pro', src: '深度求索' },
    { name: 'deepseek-v4-flash', src: '自定义' },
  ])
  const [defModel, setDefModel] = useState('DeepSeek-V4 Pro')
  const [modalOpen, setModalOpen] = useState(false)
  return (
    <>
      <h2>模型</h2>
      <div className="sub">新对话默认使用的模型，以及你自己添加的自定义模型。改动即时生效，不影响已经开着的对话。</div>
      <div className="sect">
        <div className="sh2">默认模型</div>
        <div className="srow">
          <div className="sl">新对话使用</div>
          <div className="sr">
            <Seg options={['DeepSeek-V4 Pro', 'deepseek-v4-flash', 'Ollama · qwen3']} value={defModel} onChange={setDefModel} />
            <span className="src">会话里也可以临时切换，只影响那个对话。</span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">
          自定义模型{' '}
          <button className="mini" onClick={() => setModalOpen(true)}>
            ＋ 添加模型
          </button>
        </div>
        <div className="mnote">
          配置一份 OpenAI 兼容的接口即可。添加后会自动写入本地 <code className="mono">~/.lcode/models.json</code>
          ，不会上传。
        </div>
        {models.length === 0 ? (
          <div className="mnote">还没有自定义模型。点右上「＋ 添加模型」，填一份接口地址和 API Key 就能用。</div>
        ) : (
          <div className="modelList">
            {models.map((m, i) => (
              <div className="mrow" key={m.name + i}>
                <span className="mic">◆</span>
                <span className="mnm">{m.name}</span>
                <span className="msrc">{m.src}</span>
                <span className="macts">
                  <button title="编辑" onClick={() => toast(`演示：编辑模型「${m.name}」`)}>
                    ✎
                  </button>
                  <button
                    title="删除"
                    onClick={() => {
                      setModels(models.filter((_, ix) => ix !== i))
                      toast(`已删除「${m.name}」（mock）`)
                    }}
                  >
                    🗑
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {modalOpen && (
        <AddModelModal
          onClose={() => setModalOpen(false)}
          onSave={(name, src) => {
            setModels([...models, { name, src }])
            setModalOpen(false)
            toast(`已添加模型「${name}」（mock）`)
          }}
        />
      )}
    </>
  )
}

/* ───────── 分区：权限预设 ───────── */

const PERM_PILLS = [
  { id: 'ro', ic: 'RO', pn: '只读', pd: '不会改动任何文件，适合让 AI 先看代码' },
  { id: 'std', ic: 'ST', pn: '标准', pd: '工作区内自动执行；改工作区外、跑有风险的命令前先问' },
  { id: 'full', ic: 'FU', pn: '完全', pd: '不再询问。只建议在容器/沙箱里使用' },
]

function PermSection() {
  const [cur, setCur] = useState('std')
  return (
    <>
      <h2>权限预设</h2>
      <div className="sub">决定 Lcode 什么时候需要问你。改动即时生效。</div>
      <div className="sect">
        <div className="sh2">预设</div>
        <div className="srow">
          <div className="sr" style={{ gap: 10 }}>
            {PERM_PILLS.map((p) => (
              <div key={p.id} className={'pill' + (cur === p.id ? ' on' : '')} onClick={() => setCur(p.id)}>
                <div className="pic">{p.ic}</div>
                <div>
                  <div className="pn">{p.pn}</div>
                  <div className="pd">{p.pd}</div>
                </div>
                <span className={'st2' + (cur === p.id ? ' ok' : '')}>{cur === p.id ? '当前' : '　'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">细则</div>
        <SwRow label="工作区外文件每次都问" desc="没有「记住选择」；一次确认只管一次" init />
        <SwRow label="危险命令额外确认" desc="rm -rf、git push --force 等始终二次确认" init />
        <div className="srow">
          <div className="sl">始终要求确认的命令</div>
          <div className="sr">
            <div className="field">
              <textarea defaultValue={'rm -rf\ngit push --force\nsudo …'} />
            </div>
          </div>
        </div>
      </div>
      <SaveBar />
    </>
  )
}

/* ───────── 分区：工作区信任 ───────── */

function TrustSection() {
  const [trusted, setTrusted] = useState([
    { path: '~/code/web-app', files: '1,284 个文件', at: '2026-08-02 信任' },
    { path: '~/code/api-server', files: '862 个文件', at: '2026-07-18 信任' },
  ])
  return (
    <>
      <h2>工作区信任</h2>
      <div className="sub">受信任的文件夹会记住权限设定；不信任的文件夹以只读打开。</div>
      <div className="sect">
        <div className="sh2">
          已信任的文件夹{' '}
          <button className="mini" onClick={() => toast('演示：选择文件夹')}>
            ＋ 添加文件夹
          </button>
        </div>
        {trusted.map((t, i) => (
          <div className="trow" key={t.path}>
            <span className="tp">{t.path}</span>
            <span className="tm">
              {t.files} · {t.at}
            </span>
            <button
              onClick={() => {
                setTrusted(trusted.filter((_, ix) => ix !== i))
                toast('已移除信任（mock）')
              }}
            >
              移除
            </button>
          </div>
        ))}
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">提示</span>
        <span>打开不受信任的文件夹时，Lcode 会以只读模式启动，明确确认后才会获得写权限。</span>
      </div>
    </>
  )
}

/* ───────── 分区：历史与保留 ───────── */

function HistorySection() {
  const [storage, setStorage] = useState([
    { label: '会话记录', size: '128 MB' },
    { label: '回放快照', size: '96 MB' },
    { label: '模型响应缓存', size: '512 MB' },
    { label: '日志', size: '24 MB' },
  ])
  return (
    <>
      <h2>历史与保留</h2>
      <div className="sub">会话记录与回放数据都保存在本机，可随时清理。</div>
      <div className="sect">
        <div className="sh2">保留策略</div>
        <div className="srow">
          <div className="sl">会话记录</div>
          <div className="sr">
            <div className="field">
              <select defaultValue="保留 90 天">
                <option>永久保留</option>
                <option>保留 1 年</option>
                <option>保留 90 天</option>
                <option>保留 30 天</option>
              </select>
            </div>
          </div>
        </div>
        <div className="srow">
          <div className="sl">回放快照</div>
          <div className="sr">
            <div className="field">
              <select defaultValue="跟随会话">
                <option>跟随会话</option>
                <option>保留 30 天</option>
                <option>保留 7 天</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">空间占用</div>
        {storage.map((s, i) => (
          <div className="trow" key={s.label}>
            <span className="tp">{s.label}</span>
            <span className="tm">{s.size}</span>
            <button
              onClick={() => {
                setStorage(storage.map((x, ix) => (ix === i ? { ...x, size: '0 MB' } : x)))
                toast(`已清理「${s.label}」（mock）`)
              }}
            >
              清理
            </button>
          </div>
        ))}
      </div>
      <SaveBar />
    </>
  )
}

/* ───────── 分区：导出 ───────── */

function ExportSection() {
  const [fmt, setFmt] = useState('JSONL')
  return (
    <>
      <h2>导出</h2>
      <div className="sub">把会话导出为通用格式，便于归档或在其他工具里分析。</div>
      <div className="sect">
        <div className="sh2">导出设置</div>
        <div className="srow">
          <div className="sl">格式</div>
          <div className="sr">
            <Seg options={['JSONL', 'Markdown', 'HTML']} value={fmt} onChange={setFmt} />
            <span className="src">JSONL 保留全部事件（含过程与回放）；Markdown/HTML 只含对话正文。</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl">范围</div>
          <div className="sr">
            <div className="field">
              <select defaultValue="当前会话">
                <option>当前会话</option>
                <option>当前工作区的全部会话</option>
                <option>全部会话</option>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div className="savebar">
        <button className="btn primary" onClick={() => toast('已导出到 ~/Downloads/lcode-export.jsonl（模拟）')}>
          导出…
        </button>
      </div>
    </>
  )
}

/* ───────── 导航定义 + 页面骨架（Codex 布局） ───────── */

const SECTIONS: { g?: string; id?: string; label?: string }[] = [
  { g: '个人' },
  { id: 'general', label: '常规' },
  { id: 'appearance', label: '外观' },
  { id: 'keys', label: '键盘快捷键' },
  { id: 'account', label: '账户' },
  { g: '模型' },
  { id: 'providers', label: '模型' },
  { g: '权限' },
  { id: 'perm', label: '权限预设' },
  { id: 'trust', label: '工作区信任' },
  { g: '记忆与历史' },
  { id: 'history', label: '历史与保留' },
  { id: 'export', label: '导出' },
]

function SectionBody({ id }: { id: string }) {
  switch (id) {
    case 'general':
      return <GeneralSection />
    case 'appearance':
      return <AppearanceSection />
    case 'keys':
      return <KeysSection />
    case 'account':
      return <AccountSection />
    case 'providers':
      return <ModelSection />
    case 'perm':
      return <PermSection />
    case 'trust':
      return <TrustSection />
    case 'history':
      return <HistorySection />
    case 'export':
      return <ExportSection />
    default:
      return null
  }
}

export function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const initialSec = (location.state as { sec?: string } | null)?.sec ?? 'providers'
  const [cur, setCur] = useState(initialSec)
  const [query, setQuery] = useState('')

  /* 菜单「帮助 → 显示键盘快捷键」等入口带 sec 跳转过来时切换分区 */
  useEffect(() => {
    const sec = (location.state as { sec?: string } | null)?.sec
    if (sec) setCur(sec)
  }, [location.state])

  const back = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  const q = query.trim().toLowerCase()
  const itemVisible = (label: string) => q === '' || label.toLowerCase().includes(q)
  /* 分组头只在其下（到下一个分组头为止）有可见项时显示 */
  const navNodes: ReactNode[] = []
  SECTIONS.forEach((s, i) => {
    if (s.g) {
      let hasVisibleChild = false
      for (let j = i + 1; j < SECTIONS.length; j++) {
        const x = SECTIONS[j]
        if (!x || x.g) break
        if (x.label && itemVisible(x.label)) {
          hasVisibleChild = true
          break
        }
      }
      if (hasVisibleChild) {
        navNodes.push(
          <div className="g" key={'g-' + s.g}>
            {s.g}
          </div>,
        )
      }
    } else if (s.id && s.label && itemVisible(s.label)) {
      navNodes.push(
        <a key={s.id} className={cur === s.id ? 'on' : ''} onClick={() => setCur(s.id!)}>
          {s.label}
        </a>,
      )
    }
  })

  return (
    <div className="setwrap">
      <nav className="setnav">
        <button className="setback" onClick={back}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          返回工作台
        </button>
        <input className="setsearch" placeholder="搜索设置…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {navNodes}
      </nav>
      <main className="setmain">
        <div className="setcol">
          <SectionBody id={cur} />
        </div>
      </main>
    </div>
  )
}
