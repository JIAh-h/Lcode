import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChipGroup, Seg, Select, Switch, SwitchRow, TextArea, TextInput } from '../components/controls.tsx'
import { toast } from '../components/toast.ts'
import { setLocale, t, useLocale } from '../i18n/index.ts'
import { useUiPrefs } from '../store/uiPrefs.ts'
import { choosePermissionPreset, syncPermissionPresetFromMain } from '../store/permissionSync.ts'
import type { PermissionPresetState } from '../store/permissionSync.ts'
import { chooseDefaultModel, syncModelsFromMain } from '../store/modelSync.ts'
import { workspaceTrustBridge } from '../store/sessionBridge.ts'
import type { PermissionPreset } from '../store/uiPrefs.ts' // 模型条目类型 ModelEntry 也定义在 store/uiPrefs

/**
 * P5 设置（按 Codex 布局 1:1 移植 webapp 原型）：
 * 顶部「← 返回工作台」+ 搜索框；左侧面包栏（分组导航）；右侧对应分区内容。
 * 分区：个人（常规/外观/键盘快捷键/账户）· 模型 · 权限（权限预设/工作区信任）· 记忆与历史（历史与保留/导出）。
 */

/* ───────── 通用小件 ───────── */
/* Switch / SwitchRow / Seg / ChipGroup / Select / TextInput / TextArea
   已收敛到公共组件 `components/controls.tsx`，此处不再自建。 */

function SaveBar() {
  const [ok, setOk] = useState(false)
  return (
    <div className="savebar">
      <button
        className="btn primary"
        onClick={() => {
          setOk(true)
          toast(t('已保存（mock）'))
        }}
      >
        {t('保存')}
      </button>
      {ok && <span className="okmsg">✓ {t('已保存')}</span>}
    </div>
  )
}

/* ───────── 分区：常规 ───────── */

/** 语言选项：展示用各语言的自称（切到英文时「中文（简体）」仍显示中文，是通行做法） */
const LANG_OPTIONS = ['中文（简体）', 'English'] as const

function GeneralSection() {
  const locale = useLocale()
  const [startup, setStartup] = useState('打开上次的工作区')
  return (
    <>
      <h2>{t('常规')}</h2>
      <div className="sub">{t('基础行为。改动即时生效。')}</div>
      <div className="sect">
        <div className="sh2">{t('界面语言')}</div>
        <div className="srow">
          <div className="sl">{t('语言')}</div>
          <div className="sr">
            <Seg
              options={LANG_OPTIONS}
              value={locale === 'en-US' ? 'English' : '中文（简体）'}
              onChange={(v) => setLocale(v === 'English' ? 'en-US' : 'zh-CN')}
            />
            <span className="src">{t('切换后立即生效，不影响对话内容。')}</span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">{t('启动')}</div>
        <div className="srow">
          <div className="sl">{t('启动时')}</div>
          <div className="sr">
            <div className="field">
              <Select
                value={startup}
                onChange={setStartup}
                options={['打开上次的工作区', '进入首页', '打开指定文件夹…']}
              />
            </div>
          </div>
        </div>
        <SwitchRow label="自动检查更新" desc="每周在后台检查新版本，仅提示，不自动安装" init />
        <SwitchRow label="崩溃后自动恢复" desc="下次启动时恢复中断的对话并显著标注补记" init />
      </div>
      <div className="sect">
        <div className="sh2">{t('隐私')}</div>
        <SwitchRow label="匿名使用统计" desc="只上报功能使用计数，不含任何代码与对话内容" />
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
  const [mono, setMono] = useState('JetBrains Mono')
  return (
    <>
      <h2>{t('外观')}</h2>
      <div className="sub">{t('主题与显示。此处的改动与菜单「视图 → 切换主题」联动。')}</div>
      <div className="sect">
        <div className="sh2">{t('主题')}</div>
        <div className="srow">
          <div className="sl">{t('外观')}</div>
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
          <div className="sl">{t('强调色')}</div>
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
                    toast(t('强调色已切换（演示，重启后还原）'))
                  }}
                />
              ))}
            </div>
            <span className="src">{t('用于链接、选中态与运行状态指示。')}</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl">{t('色盲友好 diff')}</div>
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
              <span className="swd">{t('增删行改用蓝/橙区分（对红绿色盲更友好）')}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">{t('显示')}</div>
        <div className="srow">
          <div className="sl">{t('界面字号')}</div>
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
          <div className="sl">{t('等宽字体')}</div>
          <div className="sr">
            <div className="field">
              <Select
                value={mono}
                onChange={setMono}
                options={['JetBrains Mono', 'SF Mono', 'Consolas', '系统默认']}
              />
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
      <h2>{t('键盘快捷键')}</h2>
      <div className="sub">{t('演示版暂不支持改键，点击「修改」会给出提示。')}</div>
      <div className="sect">
        <div className="sh2">{t('全局')}</div>
        {KEY_ROWS.map(([desc, combo]) => (
          <div className="krow" key={desc}>
            <span className="kdesc">{t(desc)}</span>
            <span className="kcombo">
              <span className="kbd">{combo}</span>
            </span>
            <button className="kedit" onClick={() => toast(t('演示版：暂不支持自定义快捷键'))}>
              {t('修改')}
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
      <h2>{t('账户')}</h2>
      <div className="sub">{t('Lcode 默认使用本地账户，数据不出本机。')}</div>
      <div className="sect">
        <div className="sh2">{t('资料')}</div>
        <div className="srow">
          <div className="sl">{t('头像与名称')}</div>
          <div className="sr">
            <div className="fbox" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div className="avatarlg">J</div>
              <div className="field" style={{ flex: 1 }}>
                <TextInput value={name} onChange={setName} />
              </div>
            </div>
          </div>
        </div>
        <div className="srow">
          <div className="sl">{t('登录方式')}</div>
          <div className="sr">
            <span className="src">
              {t('本地账户 · 无需登录。')}<b>{t('接入团队版')}</b>{t('后可同步设置与会话（未接入）。')}
            </span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">{t('数据位置')}</div>
        <div className="trow">
          <span className="tp">~/lcode</span>
          <span className="tm">{t('会话、设置与回放数据')}</span>
          <button onClick={() => toast(t('已在文件夹中显示（模拟）'))}>{t('在文件夹中显示')}</button>
        </div>
        <div className="trow">
          <span className="tp">~/lcode/sessions</span>
          <span className="tm">{t('JSONL 会话日志')}</span>
          <button onClick={() => toast(t('已在文件夹中显示（模拟）'))}>{t('在文件夹中显示')}</button>
        </div>
      </div>
      <div className="savebar">
        <button className="btn danger" onClick={() => toast(t('已退出本地账户（模拟）——演示环境不会真的清除数据'))}>
          {t('退出本地账户')}
        </button>
      </div>
    </>
  )
}

/* ───────── 分区：模型（WorkBuddy 风格：列表 + 添加模型弹窗） ───────── */

/* 模型条目的类型由 store/uiPrefs 统一提供（`ModelEntry`），此处不再本地声明 */

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
/**
 * 供应商预设（对应文档 18 §2 的 L5「适配器组合基座」）：
 * 内置供应商的 baseUrl 来自适配器默认值，**用户不需要填**；
 * 只有「自定义」没有默认值，才需要用户提供地址。
 *
 * 端点取值来源（不自己编）：
 * - OpenAI `https://api.openai.com/v1` —— 文档 18 §5 解析链路示例
 * - Ollama `http://127.0.0.1:11434` —— 文档 18 §9.1
 * - DeepSeek `https://api.deepseek.com` —— DeepSeek 官方 API 文档（OpenAI 兼容 base_url）
 */
interface ProviderPreset {
  readonly id: string
  /** 适配器默认 baseUrl；`null` = 必须用户填写（自定义） */
  readonly baseUrl: string | null
  /** 是否需要凭据。本地模型不需要，见文档 18 §9.1 */
  readonly needsKey: boolean
  /** 模型名示例，用于占位提示 */
  readonly modelHint: string
}

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: '自定义', baseUrl: null, needsKey: true, modelHint: '例如 gpt-4o 或 openai/gpt-4o' },
  { id: 'DeepSeek', baseUrl: 'https://api.deepseek.com', needsKey: true, modelHint: '例如 deepseek-flash 或 deepseek-v4-pro' },
  { id: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, modelHint: '例如 gpt-4o' },
  { id: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434', needsKey: false, modelHint: '例如 qwen3-coder' },
]

/** `AddModelModal` 提交的完整内容（**含 API Key**——它由主进程写进凭据存储，不进 settings） */
interface ModelDraft {
  /** 配置条目的显示名（用户自己起的名，如「deepseek-flash」） */
  readonly label: string
  /** 真正发给服务端的模型 id（如 `deepseek-chat`）。缺省回落到 label */
  readonly model?: string
  readonly base_url: string
  readonly api_key: string
  /** 编辑模式带上：配置条目的 id（`custom-xxx`），主进程据此原地更新 */
  readonly id?: string
}

function AddModelModal({
  onClose,
  onSave,
  editing,
}: {
  onClose: () => void
  onSave: (draft: ModelDraft, opts?: { readonly probe?: boolean }) => Promise<void>
  /** 传入即为**编辑**模式：预填现有配置，供应商不可改（id 是它的身份） */
  editing?: CustomModelInfo | undefined
}) {
  const isEdit = editing !== undefined
  const [provider, setProvider] = useState(PROVIDER_PRESETS[0]!.id)
  const [base, setBase] = useState(editing?.base_url ?? '')
  const [key, setKey] = useState('')
  const [name, setName] = useState(editing?.label ?? '')
  /**
   * 服务端模型 id。
   *
   * 与上面的 `name`（显示名）是**两个字段**：显示名可以是「主力模型」，而模型 id 必须是
   * `deepseek-chat` 这种服务端认得的字符串。以前只有一个字段，于是引擎把显示名当模型名
   * 发出去，服务端一律 404——而界面看上去一切正常（实测踩过）。
   *
   * 编辑模式下老配置没有这个字段时，store 会回落成 label，这里同样回落到 label
   * （而不是留空），否则用户点一下保存会把自己的模型名清掉。
   */
  const [modelId, setModelId] = useState(editing?.model ?? editing?.label ?? '')
  const [showKey, setShowKey] = useState(false) // 默认密文（闭眼）
  const [inTok, setInTok] = useState('')
  const [outTok, setOutTok] = useState('')
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  /* 编辑模式下查出"这个引用名到底有没有值"——**只问在不在，不问是什么**（I7） */
  useEffect(() => {
    if (editing === undefined || editing.api_key_ref === '') {
      setKeyPresent(editing === undefined ? null : false)
      return
    }
    let alive = true
    void modelBridge()
      ?.hasCredential(editing.api_key_ref)
      .then((present) => {
        if (alive) setKeyPresent(present)
      })
      .catch(() => {
        if (alive) setKeyPresent(null)
      })
    return () => {
      alive = false
    }
  }, [editing])

  /* 当前供应商的预设：决定要不要填地址、要不要填密钥、模型名怎么举例 */
  const preset = PROVIDER_PRESETS.find((p) => p.id === provider) ?? PROVIDER_PRESETS[0]!
  /** 最终生效的接口地址：内置供应商用适配器默认值，自定义用用户输入 */
  const effectiveBase = preset.baseUrl ?? base.trim()

  /* 供应商一换，地址/密钥/模型名都是**该供应商专属**的，留着会串味（比如把 gpt-4o 存成 DeepSeek 的模型） */
  const changeProvider = (next: string): void => {
    setProvider(next)
    setBase('')
    setKey('')
    setName('')
    setModelId('')
  }

  /** 收集当前表单（校验留给主进程的权威实现，这里只做"别提交空表单"的即时提示） */
  const draft = (): ModelDraft | null => {
    if (!name.trim()) {
      toast(t('请先填写模型名称'))
      nameRef.current?.focus()
      return null
    }
    if (!modelId.trim()) {
      toast(t('请填写要调用的模型名'))
      return null
    }
    if (preset.baseUrl === null && !base.trim()) {
      toast(t('自定义供应商需要填写接口地址'))
      return null
    }
    // 编辑模式：密钥**留空表示不改**（值不在 UI 里，也不该逼用户重填一遍）
    if (preset.needsKey && !isEdit && !key.trim()) {
      toast(t('请填写 API Key'))
      return null
    }
    return {
      label: name.trim(),
      model: modelId.trim(),
      base_url: effectiveBase,
      api_key: key.trim(),
      ...(isEdit ? { id: editing.name } : {}),
    }
  }

  const save = async (): Promise<void> => {
    const input = draft()
    if (input === null) return
    setSaving(true)
    try {
      await onSave(input)
    } finally {
      setSaving(false)
    }
  }

  /**
   * 「测试连接」：**先保存配置再探测**。
   *
   * 为什么不是"拿表单值直接发一个请求"：探测要经过 `ctx.llm` 里的适配器，而适配器是按
   * **已保存的配置**注册的。走"先存后探"这条路，用户看到的结果必然就是"存下来之后能不能用"
   * ——少一次"测试通过但保存后不通"的意外。
   */
  const testConnection = async (): Promise<void> => {
    const input = draft()
    if (input === null) return
    setProbing(true)
    try {
      await onSave(input, { probe: true })
    } finally {
      setProbing(false)
    }
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
          <h3 style={{ margin: 0 }}>{isEdit ? t('编辑模型') : t('添加模型')}</h3>
          <div className="msp" />
          <button className="ticon" title={t('关闭')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="mb" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="mmfield">
            <span className="mmlab">
              {t('供应商')} <em>{t('（仅支持 OpenAI 兼容协议）')}</em>
            </span>
            {/* 编辑模式**不允许改供应商**：配置是按供应商 id 存的，改 id 等于新开一条，
                而用户想要的是'改这个模型的地址/密钥'。要换供应商就删了重加。 */}
            {isEdit ? (
              <div className="mmreadonly">
                <span className="mmfrom">{editing.name}</span>
              </div>
            ) : (
              <Select value={provider} onChange={changeProvider} options={PROVIDER_PRESETS.map((p) => p.id)} />
            )}
          </div>

          {/* 接口地址：**只有「自定义」才出现**——内置供应商的地址由适配器默认值决定（文档 18 §2 L5
              「适配器组合基座」），不需要用户关心，也就不占弹窗版面 */}
          {preset.baseUrl === null && (
            <label className="mmfield">
              <span className="mmlab">{t('接口地址')}</span>
              <TextInput value={base} onChange={setBase} placeholder="https://api.example.com/v1" />
            </label>
          )}

          {/* 凭据：本地模型不需要（文档 18 §9.1「凭据必需：云端必需 / 本地不需要」） */}
          {preset.needsKey ? (
            <label className="mmfield">
              <span className="mmlab">
                API Key
                {/* 编辑模式：**绝不回显密钥值**（它根本不在 UI 里）。
                    只告诉用户'已配置 / 未配置'，留空即表示不改。 */}
                {isEdit && (
                  <em>
                    {keyPresent === true
                      ? t('（已配置，留空则不修改）')
                      : keyPresent === false
                        ? t('（尚未配置）')
                        : t('（留空则不修改）')}
                  </em>
                )}
              </span>
              <span className="mmkey">
                <span className="mmkeybox">
                  <TextInput
                    type={showKey ? 'text' : 'password'}
                    value={key}
                    onChange={setKey}
                    placeholder={isEdit ? t('留空则不修改') : t('输入你的 API Key')}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className={'mmeye' + (showKey ? ' off' : '')}
                    title={showKey ? t('隐藏密钥') : t('显示密钥')}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {EYE_CLOSED}
                    {EYE_OPEN}
                  </button>
                </span>
                <button className="btn" disabled={probing} onClick={() => void testConnection()}>
                  {t('测试连接')}
                </button>
              </span>
            </label>
          ) : (
            <div className="mmfield">
              <span className="mmlab">API Key</span>
              <div className="mmreadonly">
                <span className="mmfrom">{t('本地模型不需要密钥。若没连上，多半是服务没启动')}</span>
                <button className="btn" disabled={probing} onClick={() => void testConnection()}>
                  {t('测试连接')}
                </button>
              </div>
            </div>
          )}
          <label className="mmfield">
            <span className="mmlab">
              {t('模型名称')}
              <em>{t('（接口文档里那个，例如 deepseek-chat）')}</em>
            </span>
            <TextInput
              inputRef={nameRef}
              value={modelId}
              onChange={setModelId}
              placeholder={t(preset.modelHint)}
            />
          </label>
          <label className="mmfield">
            <span className="mmlab">
              {t('显示名称')}
              <em>{t('（列表和模型菜单里显示的名字，可留空）')}</em>
            </span>
            <TextInput value={name} onChange={setName} placeholder={t('例如 主力模型')} />
          </label>
          <div style={{ display: 'flex', gap: 18 }}>
            <ChipGroup
              label="输入"
              hint="（不选则使用该模型默认值）"
              options={['', '32K', '64K', '128K', '256K']}
              value={inTok}
              onChange={setInTok}
            />
            <ChipGroup
              label="输出"
              hint="（不选则使用该模型默认值）"
              options={['', '8K', '16K', '32K', '64K']}
              value={outTok}
              onChange={setOutTok}
            />
          </div>
        </div>
        <div className="mf" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            {t('保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ───────── 桥接：模型配置的 IPC 形状（preload 的 `window.lcode.model`） ───────── */

interface ModelBridge {
  list(): Promise<{ providers: string[]; custom: CustomModelInfo[] }>
  save(input: {
    id?: string
    label: string
    /** 服务端模型 id（缺省回落 label） */
    model?: string
    base_url: string
    api_key: string
  }): Promise<{
    provider: string
    api_key_ref: string
  }>
  remove(name: string): Promise<{ removed: boolean }>
  probe(input: { provider: string; model?: string }): Promise<ProbeResult>
  /** 某个凭据引用**有没有值**（只问在不在，不问是什么——I7） */
  hasCredential(ref: string): Promise<boolean>
  setDefault(input: { provider: string; model: string }): Promise<unknown>
  getDefault(): Promise<{ provider: string; model: string } | null>
}

interface CustomModelInfo {
  readonly name: string
  readonly label: string
  /** 真正发给服务端的模型 id（如 `deepseek-chat`），与 label 是两件事 */
  readonly model: string
  readonly base_url: string
  readonly api_key_ref: string
}

/** 六类归因（18 §8.2 / 19 §6.4）：每类配**独立**文案，不合并成一句"失败" */
type ProbeFailureKind =
  | 'credential-rejected'
  | 'endpoint-unreachable'
  | 'model-not-found'
  | 'timeout'
  | 'provider-not-running'
  | 'not-configured'

type ProbeResult =
  | { readonly ok: true; readonly models: readonly { readonly id: string }[] }
  | { readonly ok: false; readonly failure: { readonly kind: ProbeFailureKind; readonly code: string; readonly message: string } }

/** 归因 → 人话（18 §8.2 的表格逐条对应） */
function probeMessage(result: ProbeResult): string {
  if (result.ok) return t('已连接 · 发现 {n} 个可用模型', { n: result.models.length })
  switch (result.failure.kind) {
    case 'credential-rejected':
      return t('API Key 被拒绝了，请检查是否过期或权限不足')
    case 'endpoint-unreachable':
      return t('连不上这个地址，请检查接口地址或代理设置')
    case 'model-not-found':
      return t('服务端没有这个模型，请检查模型名')
    case 'timeout':
      return t('连接超时，可能是网络或代理问题')
    case 'provider-not-running':
      return t('本地模型服务没有启动')
    default:
      return t('还没有配置凭据，请填写 API Key')
  }
}

function modelBridge(): ModelBridge | undefined {
  return (window as unknown as { lcode?: { model?: ModelBridge } }).lcode?.model
}

function ModelSection() {
  /* 默认模型来自共享状态（`store/uiPrefs`）——composer 里的模型菜单读的是同一份，
     避免"设置改了、输入区还是旧的"这种两份副本互相覆盖（文档 D20）。
     自定义模型清单则走 IPC 读**主进程**（不再是渲染层的内存 mock）。 */
  const prefs = useUiPrefs()
  /** 当前选中项的显示名（`Seg` 的 value 是显示名，而状态里存的是配置条目 id） */
  const defModelLabel = prefs.models.find((m) => m.name === prefs.defaultProvider)?.src ?? ''
  const [modalOpen, setModalOpen] = useState(false)
  /** 正在编辑哪一条；undefined = 新增模式 */
  const [editing, setEditing] = useState<CustomModelInfo | undefined>(undefined)
  /**
   * 关弹窗**必须**连带清掉 editing。
   *
   * 分开设是这类 bug 的经典来源：只  会让  留着，
   * 下次点「＋ 添加模型」如果忘了清，就会以编辑模式打开一个空白表单。
   * 收成一个函数后，就不存在忘了一起清这种可能。
   */
  const closeModal = useCallback(() => {
    setModalOpen(false)
    setEditing(undefined)
  }, [])
  const [custom, setCustom] = useState<CustomModelInfo[]>([])
  const [bridgeError, setBridgeError] = useState<string | null>(null)

  /** 从主进程刷新清单（保存/删除后也调它——单一数据源，不自己拼） */
  /**
   * 设置页自己的清单（本页渲染用）+ 触发一次**全局镜像**同步。
   *
   * 镜像同步走 `syncModelsFromMain({ force: true })`——它和 `App` 挂载时调的是**同一份**
   * 逻辑。这里**不再自己组装** `uiPrefs.models`：两处各写一遍正是"首页显示假模型、
   * 进过设置才对"那个 bug 的来源（一份状态两个初始化点）。
   */
  const refresh = useCallback(async (): Promise<void> => {
    const bridge = modelBridge()
    if (bridge === undefined) {
      setBridgeError(t('当前环境没有主进程桥（开发预览或浏览器里打开时会这样）'))
      return
    }
    try {
      const result = await bridge.list()
      setCustom(result.custom)
      setBridgeError(null)
      await syncModelsFromMain({ force: true })
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <>
      <h2>{t('模型')}</h2>
      <div className="sub">{t('新对话默认使用的模型，以及你自己添加的自定义模型。改动即时生效，不影响已经开着的对话。')}</div>
      {bridgeError !== null && (
        <div className="mnote" style={{ color: 'var(--danger, #C2410C)' }}>
          {t('模型配置暂不可用：')}
          {bridgeError}
        </div>
      )}
      <div className="sect">
        <div className="sh2">{t('默认模型')}</div>
        <div className="srow">
          <div className="sl">{t('新对话使用')}</div>
          <div className="sr">
            <Seg
              options={custom.map((m) => m.label)}
              value={defModelLabel}
              onChange={(v) => {
                // `Seg` 给的是**显示名**，而默认选择要的是配置条目 id + 服务端模型 id。
                // 走 `chooseDefaultModel` 一次做完查表与回写（它也负责写主进程）。
                const picked = custom.find((m) => m.label === v)
                if (picked === undefined) return
                void chooseDefaultModel(picked.name).catch(() => undefined)
              }}
            />
            <span className="src">{t('会话里也可以临时切换，只影响那个对话。')}</span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">
          {t('自定义模型')}{' '}
          <button
            className="mini"
            onClick={() => {
              setEditing(undefined)
              setModalOpen(true)
            }}
          >
            ＋ {t('添加模型')}
          </button>
        </div>
        <div className="mnote">
          {t('配置一份 OpenAI 兼容的接口即可。配置存在本地 ')}
          <code className="mono">~/.lcode/settings.json</code>
          {t('，API Key 存在凭据存储里（两者都只在本机，不会上传）。')}
        </div>
        {custom.length === 0 ? (
          <div className="mnote">{t('还没有自定义模型。点右上「＋ 添加模型」，填一份接口地址和 API Key 就能用。')}</div>
        ) : (
          <div className="modelList">
            {custom.map((m) => (
              <div className="mrow" key={m.name}>
                <span className="mic">◆</span>
                <span className="mnm">{m.label}</span>
                <span className="msrc" title={m.base_url}>
                  {/* 只显示主机名，完整地址放 tooltip——列表里塞长 URL 会挤掉别的列 */}
                  {hostOf(m.base_url)}
                </span>
                <span className="macts">
                  <button
                    title={t('编辑')}
                    onClick={() => {
                      // **两个都要设**：`editing` 决定弹窗的模式（预填 + 锁定供应商），
                      // `modalOpen` 才真的把它渲染出来。只设前者 = 点了没反应。
                      setEditing(m)
                      setModalOpen(true)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    title={t('测试连接')}
                    onClick={() => {
                      void modelBridge()
                        ?.probe({ provider: m.name })
                        .then((r) => toast(probeMessage(r)))
                        .catch(() => toast(t('探测失败')))
                    }}
                  >
                    ⚡
                  </button>
                  <button
                    title={t('删除')}
                    onClick={() => {
                      void modelBridge()
                        ?.remove(m.name)
                        .then(async () => {
                          await refresh()
                          toast(t('已删除「{name}」', { name: m.label }))
                        })
                        .catch((err: unknown) => toast(err instanceof Error ? err.message : t('删除失败')))
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
          editing={editing}
          onClose={closeModal}
          onSave={async (draft, opts) => {
            const bridge = modelBridge()
            if (bridge === undefined) {
              toast(t('当前环境没有主进程桥，无法保存'))
              return
            }
            try {
              const saved = await bridge.save(draft)
              await refresh()
              // 18 §8.2：保存后**必须**立即自检并给可读结果
              const result = await bridge.probe({ provider: saved.provider, model: draft.label })
              toast(probeMessage(result))
              if (result.ok || opts?.probe !== true) closeModal()
            } catch (err) {
              toast(err instanceof Error ? err.message : t('保存失败'))
            }
          }}
        />
      )}
    </>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/* ───────── 分区：权限预设 ───────── */

/** 五个产品层字面量，写死自文档 12 §3.3（底层是 sandbox/mode × approval/policy 的打包） */
const PERM_PILLS: readonly { id: PermissionPreset; ic: string; pd: string }[] = [
  { id: '只读', ic: 'RO', pd: '不会改动任何文件，适合先让它看代码' },
  { id: '标准', ic: 'ST', pd: '受保护时可在工作区执行；沙箱降级时改动前确认' },
  { id: '自动', ic: 'AU', pd: '仅在系统级沙箱可用时自动执行；否则拒绝改动' },
  { id: '完全访问', ic: 'FU', pd: '哪里都能碰，但动手前问你' },
  { id: '无人值守', ic: 'CI', pd: '仅在系统级沙箱可用时用于自动化；否则拒绝改动' },
]

function PermSection() {
  const prefs = useUiPrefs()
  const cur = prefs.permissionPreset
  const [state, setState] = useState<PermissionPresetState | undefined>()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void syncPermissionPresetFromMain().then(setState).catch(() => setState(undefined))
  }, [])
  const selectPreset = (preset: PermissionPreset): void => {
    if (saving || preset === cur) return
    setSaving(true)
    void choosePermissionPreset(preset)
      .then(setState)
      .catch(() => toast(t('权限预设保存失败')))
      .finally(() => setSaving(false))
  }
  return (
    <>
      <h2>{t('权限预设')}</h2>
      <div className="sub">{t('决定 Lcode 什么时候需要问你。改动即时生效。')}</div>
      <div className="sect">
        <div className="sh2">{t('预设')}</div>
        <div className="srow">
          <div className="sr" style={{ gap: 10, flexWrap: 'wrap' }}>
            {PERM_PILLS.map((p) => (
              <button key={p.id} type="button" className={'pill' + (cur === p.id ? ' on' : '')} onClick={() => selectPreset(p.id)} disabled={saving}>
                <div className="pic">{p.ic}</div>
                <div>
                  <div className="pn">{t(p.id)}</div>
                  <div className="pd">{t(p.pd)}</div>
                </div>
                <span className={'st2' + (cur === p.id ? ' ok' : '')}>{cur === p.id ? t('当前') : '　'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">{t('当前生效')}</div>
        <div className="srow">
          <div className="sl">{t('来源')}</div>
          <div className="sr">
            <span className="src">{state?.source === 'user' ? t('本机设置') : t('默认设置')}</span>
            <span className="src">{t('策略在主进程执行；未信任的工作区仍保持只读。')}</span>
          </div>
        </div>
        {state !== undefined && state.audit.length > 0 ? (
          <div className="srow">
            <div className="sl">{t('最近切换')}</div>
            <div className="sr">
              {state.audit.slice(0, 3).map((entry) => <span className="src" key={`${entry.changedAt}-${entry.to}`}>{entry.from} → {entry.to} · {new Date(entry.changedAt).toLocaleString()}</span>)}
            </div>
          </div>
        ) : null}
      </div>
      <div className="sect">
        <div className="sh2">{t('细则')}</div>
        <SwitchRow label="工作区外文件每次都问" desc="没有「记住选择」；一次确认只管一次" init />
        <SwitchRow label="危险命令额外确认" desc="rm -rf、git push --force 等始终二次确认" init />
        <div className="srow">
          <div className="sl">{t('始终要求确认的命令')}</div>
          <div className="sr">
            <div className="field">
              <TextArea defaultValue={'rm -rf\ngit push --force\nsudo …'} rows={4} />
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
  const [trusted, setTrusted] = useState<readonly { readonly path: string; readonly trustedAt: number }[]>([])
  const refresh = (): void => {
    void workspaceTrustBridge()?.list().then((items) => setTrusted(items)).catch(() => setTrusted([]))
  }
  useEffect(refresh, [])
  const addFolder = async (): Promise<void> => {
    const path = await window.lcode.chooseFolder(t('选择项目文件夹'))
    if (!path) return
    const api = workspaceTrustBridge()
    if (api === undefined) {
      toast(t('当前环境没有主进程桥，无法更新工作区信任'))
      return
    }
    await api.set({ workspace: path, trusted: true })
    refresh()
    toast(t('已信任此文件夹'))
  }
  const revoke = (path: string): void => {
    const api = workspaceTrustBridge()
    if (api === undefined) return
    void api.set({ workspace: path, trusted: false }).then(() => {
      refresh()
      toast(t('已移除信任'))
    }).catch((err: unknown) => toast(err instanceof Error ? err.message : t('更新工作区信任失败')))
  }
  return (
    <>
      <h2>{t('工作区信任')}</h2>
      <div className="sub">{t('受信任的文件夹会记住权限设定；不信任的文件夹以只读打开。')}</div>
      <div className="sect">
        <div className="sh2">
          {t('已信任的文件夹')}{' '}
          <button className="mini" onClick={() => void addFolder()}>
            ＋ {t('添加文件夹')}
          </button>
        </div>
        {trusted.map((item) => (
          <div className="trow" key={item.path}>
            <span className="tp">{item.path}</span>
            <span className="tm">
              {new Date(item.trustedAt).toLocaleDateString()}
            </span>
            <button
              onClick={() => revoke(item.path)}
            >
              {t('移除')}
            </button>
          </div>
        ))}
        {trusted.length === 0 && <div className="pickhint">{t('还没有已信任的文件夹')}</div>}
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('提示')}</span>
        <span>{t('打开不受信任的文件夹时，Lcode 会以只读模式启动，明确确认后才会获得写权限。')}</span>
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
  const [keepLogs, setKeepLogs] = useState('保留 90 天')
  const [keepSnapshots, setKeepSnapshots] = useState('跟随会话')
  return (
    <>
      <h2>{t('历史与保留')}</h2>
      <div className="sub">{t('会话记录与回放数据都保存在本机，可随时清理。')}</div>
      <div className="sect">
        <div className="sh2">{t('保留策略')}</div>
        <div className="srow">
          <div className="sl">{t('会话记录')}</div>
          <div className="sr">
            <div className="field">
              <Select
                value={keepLogs}
                onChange={setKeepLogs}
                options={['永久保留', '保留 1 年', '保留 90 天', '保留 30 天']}
              />
            </div>
          </div>
        </div>
        <div className="srow">
          <div className="sl">{t('回放快照')}</div>
          <div className="sr">
            <div className="field">
              <Select
                value={keepSnapshots}
                onChange={setKeepSnapshots}
                options={['跟随会话', '保留 30 天', '保留 7 天']}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">{t('空间占用')}</div>
        {storage.map((s, i) => (
          <div className="trow" key={s.label}>
            <span className="tp">{t(s.label)}</span>
            <span className="tm">{s.size}</span>
            <button
              onClick={() => {
                setStorage(storage.map((x, ix) => (ix === i ? { ...x, size: '0 MB' } : x)))
                toast(t('已清理「{name}」（mock）', { name: t(s.label) }))
              }}
            >
              {t('清理')}
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
  const [scope, setScope] = useState('当前会话')
  return (
    <>
      <h2>{t('导出')}</h2>
      <div className="sub">{t('把会话导出为通用格式，便于归档或在其他工具里分析。')}</div>
      <div className="sect">
        <div className="sh2">{t('导出设置')}</div>
        <div className="srow">
          <div className="sl">{t('格式')}</div>
          <div className="sr">
            <Seg options={['JSONL', 'Markdown', 'HTML']} value={fmt} onChange={setFmt} />
            <span className="src">{t('JSONL 保留全部事件（含过程与回放）；Markdown/HTML 只含对话正文。')}</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl">{t('范围')}</div>
          <div className="sr">
            <div className="field">
              <Select
                value={scope}
                onChange={setScope}
                options={['当前会话', '当前工作区的全部会话', '全部会话']}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="savebar">
        <button className="btn primary" onClick={() => toast(t('已导出到 ~/Downloads/lcode-export.jsonl（模拟）'))}>
          {t('导出…')}
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
  /* 搜索同时匹配中文原文与当前语言的译文，两种语言下都能搜到 */
  const itemVisible = (label: string) =>
    q === '' || label.toLowerCase().includes(q) || t(label).toLowerCase().includes(q)
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
            {t(s.g)}
          </div>,
        )
      }
    } else if (s.id && s.label && itemVisible(s.label)) {
      navNodes.push(
        <a key={s.id} className={cur === s.id ? 'on' : ''} onClick={() => setCur(s.id!)}>
          {t(s.label)}
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
          {t('返回工作台')}
        </button>
        <TextInput className="setsearch" placeholder={t('搜索设置…')} value={query} onChange={setQuery} />
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
