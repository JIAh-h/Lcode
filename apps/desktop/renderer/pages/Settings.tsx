import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CONTEXT_WINDOW_STEP, FALLBACK_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '@lcode/model-api'
import { Seg, Select, Switch, SwitchRow, TextArea, TextInput } from '../components/controls.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { PopMenu } from '../components/PopMenu.tsx'
import { toast } from '../components/toast.ts'
import { setLocale, t, useLocale } from '../i18n/index.ts'
import { useUiPrefs } from '../store/uiPrefs.ts'
import { choosePermissionPreset, syncPermissionPresetFromMain } from '../store/permissionSync.ts'
import type { PermissionPresetState } from '../store/permissionSync.ts'
import { chooseDefaultModel, syncModelsFromMain } from '../store/modelSync.ts'
import { workspaceTrustBridge } from '../store/sessionBridge.ts'
import { chooseAgentPreset, listAgentPresets } from '../store/agentPresetSync.ts'
import type { AgentPresetOption, AgentPresetState } from '../store/agentPresetSync.ts'
import { sessionBridge } from '../store/sessionBridge.ts'
import type { SessionMeta } from '../store/sessionBridge.ts'
import type { TrashEntry } from '../store/sessionBridge.ts'
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

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const combo = (key: string, shift = false): string =>
  IS_MAC ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`

const KEY_ROWS: [string, string][] = [
  ['新对话', combo('N')],
  ['打开文件夹', combo('O')],
  ['关闭会话', combo('W')],
  ['显示/隐藏侧边栏', combo('B')],
  ['进入回放', combo('R')],
  ['打开设置', combo(',')],
  ['显示键盘快捷键', combo('/')],
  ['放大', combo('=')],
  ['缩小', combo('-')],
  ['实际大小', combo('0')],
  ['切换全屏', 'F11'],
  ['发送消息', 'Enter'],
  ['换行', 'Shift + Enter'],
  ['斜杠命令', '/'],
]

function KeysSection() {
  return (
    <>
      <h2>{t('键盘快捷键')}</h2>
      <div className="sub">{t('以下为当前生效的快捷键；复制、粘贴等编辑操作沿用系统默认。')}</div>
      <div className="sect">
        <div className="sh2">{t('全局')}</div>
        {KEY_ROWS.map(([desc, shortcut]) => (
          <div className="krow" key={desc}>
            <span className="kdesc">{t(desc)}</span>
            <span className="kcombo">
              <span className="kbd">{shortcut}</span>
            </span>
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
  /** 输入上下文窗口（tokens）；缺省 = 使用供应商返回的模型上限 */
  readonly context_window_in?: number
  /** 供应商返回的窗口上限（探测缓存） */
  readonly context_window_max?: number
  /** 编辑模式带上：配置条目的 id（`custom-xxx`），主进程据此原地更新 */
  readonly id?: string
}

function formatWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  return `${Math.round(tokens / 1_000)}K`
}

/**
 * 滑块的常用节点：不铺满整条轨道，只给几个"主流窗口"——
 * 1M 上给 200K / 400K / 1M（对齐 Qoder），200K 上给 64K / 128K / 200K。
 * 节点可点，点一下就等于把滑块拖过去。
 */
function windowNodes(maxTokens: number): number[] {
  if (maxTokens >= 1_000_000) return [200_000, 400_000, maxTokens]
  if (maxTokens >= 400_000) return [Math.round(maxTokens * 0.25), Math.round(maxTokens * 0.5), maxTokens]
  if (maxTokens >= 200_000) return [64_000, 128_000, maxTokens]
  if (maxTokens >= 128_000) return [32_000, 64_000, maxTokens]
  return [Math.round(maxTokens / 2), maxTokens]
}

function AddModelModal({
  onClose,
  onSave,
  editing,
}: {
  onClose: () => void
  onSave: (draft: ModelDraft) => Promise<void>
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
  const [ctxWindow, setCtxWindow] = useState<number | null>(editing?.context_window_in ?? null)
  /** 供应商返回的窗口上限；**带模型 id**：换模型后旧值立即失效 */
  const [providerLimit, setProviderLimit] = useState<{ readonly model: string; readonly value: number } | null>(null)
  /** 「测试连接」成功后缓存的可用模型；未保存配置，只用于下拉筛选 */
  const [availableModels, setAvailableModels] = useState<readonly DiscoveredModel[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)
  const modelFieldRef = useRef<HTMLDivElement>(null)
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

  /* 编辑已有模型时向供应商现取窗口上限（`/models/{id}` 或列表字段） */
  useEffect(() => {
    if (editing === undefined) return
    const bridge = modelBridge()
    if (bridge === undefined) return
    let alive = true
    void bridge
      .limits({ provider: editing.name, model: editing.model })
      .then((limits) => {
        if (!alive) return
        const value = limits?.context_window
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          setProviderLimit({ model: editing.model, value })
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [editing])

  /* 模型下拉：点外面或 Esc 关闭 */
  useEffect(() => {
    if (!modelsOpen) return
    const close = (event: MouseEvent): void => {
      if (modelFieldRef.current !== null && !modelFieldRef.current.contains(event.target as Node)) setModelsOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setModelsOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [modelsOpen])

  /* 当前供应商的预设：决定要不要填地址、要不要填密钥、模型名怎么举例 */
  const preset = PROVIDER_PRESETS.find((p) => p.id === provider) ?? PROVIDER_PRESETS[0]!
  /** 最终生效的接口地址：内置供应商用适配器默认值，自定义用用户输入 */
  const effectiveBase = preset.baseUrl ?? base.trim()

  /*
   * 上下文窗口滑块：max 取**供应商返回的模型上限**（`/models/{id}` 的 max_input_tokens、
   * 或列表里的 context_window）。供应商没给就回落到 128K，并在下方标注。
   * 「默认」= 直接吃这个上限，不存数字；只有真的调小了才写 `context_window_in`。
   */
  const providerMax = (() => {
    const selected = modelId.trim()
    if (selected === '') return editing?.context_window_max ?? null
    // 上限只对"查它的那个模型"有效：换了模型就重新查，绝不沿用旧值
    if (providerLimit !== null && providerLimit.model === selected) return providerLimit.value
    if (selected === (editing?.model ?? '')) return editing?.context_window_max ?? null
    return null
  })()
  /*
   * 滑块最大值 = 供应商返回的模型窗口。
   * DashScope 原生目录的 `model_info.context_window`（1M）优先；没有才回落 128K。
   */
  const windowMax = Math.max(providerMax ?? FALLBACK_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW)
  const windowMin = Math.min(MIN_CONTEXT_WINDOW, windowMax)
  const windowValue = Math.min(windowMax, Math.max(windowMin, ctxWindow ?? windowMax))
  const nodes = windowNodes(windowMax).filter((value) => value > windowMin && value <= windowMax)

  const modelQuery = modelId.trim().toLowerCase()
  const filteredModels = modelQuery === ''
    ? availableModels
    : availableModels.filter((model) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(modelQuery))

  const resetDiscovered = (): void => {
    setAvailableModels([])
    setModelsOpen(false)
  }

  /** 查当前模型在供应商那边的窗口上限（未保存配置也能查；列表不带窗口时用它） */
  const refreshLimit = (id: string): void => {
    const bridge = modelBridge()
    if (bridge === undefined || id === '') return
    setProviderLimit(null)
    const typedKey = key.trim()
    const credentialRef = typedKey === '' && isEdit ? editing.api_key_ref : undefined
    void bridge
      .limitsUnsaved({
        base_url: effectiveBase,
        model: id,
        api_key: typedKey,
        ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
      })
      .then((limits) => {
        const value = limits?.context_window
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) setProviderLimit({ model: id, value })
      })
      .catch(() => undefined)
  }

  const selectModel = (model: DiscoveredModel): void => {
    setModelId(model.id)
    // 显示名称默认跟随模型名；用户之后仍可改
    setName(model.name ?? model.id)
    setModelsOpen(false)
    if (model.contextWindow !== undefined) {
      setProviderLimit({ model: model.id, value: model.contextWindow })
      return
    }
    // 列表没带窗口字段（百炼这类）：选中后立刻查这个模型的详情
    refreshLimit(model.id)
  }

  /* 供应商一换，地址/密钥/模型名都是**该供应商专属**的，留着会串味（比如把 gpt-4o 存成 DeepSeek 的模型） */
  const changeProvider = (next: string): void => {
    setProvider(next)
    setBase('')
    setKey('')
    setName('')
    setModelId('')
    setCtxWindow(null)
    setProviderLimit(null)
    resetDiscovered()
  }

  /** 收集当前表单（校验留给主进程的权威实现，这里只做"别提交空表单"的即时提示） */
  const draft = (): ModelDraft | null => {
    if (!modelId.trim()) {
      toast(t('请填写要调用的模型名'))
      nameRef.current?.focus()
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
    const chosen = ctxWindow === null ? null : Math.min(windowMax, Math.max(windowMin, ctxWindow))
    // 等于上限 = 默认，不落数字；只有用户真的调小才写 context_window_in
    const configuredWindow = chosen === null || chosen >= windowMax ? undefined : chosen
    return {
      label: name.trim() === '' ? modelId.trim() : name.trim(),
      model: modelId.trim(),
      base_url: effectiveBase,
      api_key: key.trim(),
      ...(configuredWindow === undefined ? {} : { context_window_in: configuredWindow }),
      ...(providerMax === null ? {} : { context_window_max: providerMax }),
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
    if (preset.baseUrl === null && !base.trim()) {
      toast(t('自定义供应商需要填写接口地址'))
      return
    }
    const canReuseSavedKey = isEdit && editing.api_key_ref !== ''
    if (preset.needsKey && !key.trim() && !canReuseSavedKey) {
      toast(t('请填写 API Key'))
      return
    }
    const bridge = modelBridge()
    if (bridge === undefined) {
      toast(t('当前环境没有主进程桥，无法测试连接'))
      return
    }
    setProbing(true)
    try {
      // 编辑模式留空 Key = 用已保存的凭据；值只在主进程解析
      const credentialRef = key.trim() === '' && isEdit ? editing.api_key_ref : undefined
      const result = await bridge.discover({
        base_url: effectiveBase,
        api_key: key.trim(),
        ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
      })
      if (!result.ok) {
        toast(probeMessage(result))
        return
      }
      setAvailableModels(result.models)
      toast(probeMessage(result))
      nameRef.current?.focus()
      setModelsOpen(result.models.length > 0)
    } catch (err) {
      toast(err instanceof Error ? err.message : t('测试连接失败'))
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
              <TextInput
                value={base}
                onChange={(value) => {
                  setBase(value)
                  resetDiscovered()
                }}
                placeholder="https://api.example.com/v1"
              />
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
                    onChange={(value) => {
                      setKey(value)
                      resetDiscovered()
                    }}
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
          <div className="mmfield" ref={modelFieldRef}>
            <span className="mmlab">
              {t('模型名称')}
              <em>{t('（接口文档里那个，例如 deepseek-chat）')}</em>
            </span>
            <div
              className="modelpick"
              onClick={() => {
                if (availableModels.length > 0) setModelsOpen(true)
              }}
              onBlurCapture={() => {
                // 手打模型 id 时也要跟上供应商上限（没有下拉可用时）
                const id = modelId.trim()
                if (id !== '' && (providerLimit === null || providerLimit.model !== id)) refreshLimit(id)
              }}
            >
              <TextInput
                inputRef={nameRef}
                value={modelId}
                onChange={(value) => {
                  setModelId(value)
                  if (availableModels.length > 0) setModelsOpen(true)
                }}
                onEnter={() => {
                  const first = filteredModels[0]
                  if (modelsOpen && first !== undefined) selectModel(first)
                }}
                placeholder={t(preset.modelHint)}
              />
              {availableModels.length > 0 ? <span className="modelpick-chev">▾</span> : null}
              {modelsOpen ? (
                <div className="modelpick-menu" role="listbox" aria-label={t('可用模型')}>
                  {filteredModels.length === 0 ? (
                    <div className="modelpick-empty">{t('没有匹配的模型')}</div>
                  ) : (
                    filteredModels.slice(0, 100).map((model) => (
                      <button
                        type="button"
                        key={model.id}
                        className="modelpick-item"
                        role="option"
                        aria-selected={model.id === modelId}
                        onClick={(event) => {
                          event.stopPropagation()
                          selectModel(model)
                        }}
                      >
                        <span className="mpi">{model.id}</span>
                        {model.name !== undefined && model.name !== model.id ? (
                          <span className="mpn">{model.name}</span>
                        ) : null}
                        {model.contextWindow !== undefined ? (
                          <span className="mpw">{formatWindowTokens(model.contextWindow)}</span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            {availableModels.length > 0 ? (
              <div className="modelpick-hint">
                {t('已发现 {n} 个可用模型，点击输入框选择', { n: availableModels.length })}
              </div>
            ) : null}
          </div>
          <label className="mmfield">
            <span className="mmlab">
              {t('显示名称')}
              <em>{t('（列表和模型菜单里显示的名字，可留空）')}</em>
            </span>
            <TextInput value={name} onChange={setName} placeholder={t('例如 主力模型')} />
          </label>
          <div className="mmfield">
            <span className="mmlab">
              {t('上下文窗口')}
              <em>{t('（模型输入上限；默认使用该模型的最大值）')}</em>
            </span>
            <div className="ctxwin">
              <div className="ctxwin-head">
                <span className="ctxwin-val">{formatWindowTokens(windowValue)}</span>
                <span className={ctxWindow === null ? 'ctxwin-tag' : 'ctxwin-tag custom'}>
                  {ctxWindow === null ? t('模型默认') : t('自定义')}
                </span>
                {ctxWindow === null ? null : (
                  <button type="button" className="ctxwin-reset" onClick={() => setCtxWindow(null)}>
                    {t('恢复默认')}
                  </button>
                )}
              </div>
              <input
                className="ctxrange"
                type="range"
                min={windowMin}
                max={windowMax}
                step={CONTEXT_WINDOW_STEP}
                value={windowValue}
                aria-label={t('上下文窗口')}
                onChange={(event) => setCtxWindow(Number(event.target.value))}
              />
              <div className="ctxwin-ticks">
                {nodes.map((value) => {
                  const ratio = (value - windowMin) / (windowMax - windowMin)
                  return (
                    <button
                      type="button"
                      key={value}
                      className={'ctxwin-node' + (windowValue === value ? ' on' : '')}
                      style={{ left: `${ratio * 100}%`, transform: value >= windowMax ? 'translateX(-100%)' : 'translateX(-50%)' }}
                      onClick={() => setCtxWindow(value >= windowMax ? null : value)}
                    >
                      {formatWindowTokens(value)}
                    </button>
                  )
                })}
              </div>
              <div className="ctxwin-hint">
                {providerMax === null
                  ? t('供应商没报窗口上限，暂按 128K。')
                  : t('供应商返回的模型上限（{n}）。', { n: formatWindowTokens(providerMax) })}
                {' '}
                {t('点节点切换常用窗口，输出上限用供应商默认值。')}
              </div>
            </div>
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
    context_window_in?: number
    context_window_max?: number
    context_window_out?: number
  }): Promise<{
    provider: string
    api_key_ref: string
    context_window_max?: number | null
  }>
  /** 供应商对单个模型给出的资源上限；拿不到返回空对象 */
  limits(input: { provider: string; model: string }): Promise<{ context_window?: number; max_output_tokens?: number }>
  /** 用未保存的 URL/Key 探测可用模型（测试连接） */
  discover(input: { base_url: string; api_key: string; credential_ref?: string }): Promise<DiscoverResult>
  /** 用未保存的 URL/Key 查单个模型的窗口上限（下拉选中/手填模型 id 后） */
  limitsUnsaved(input: { base_url: string; model: string; api_key: string; credential_ref?: string }): Promise<{ context_window?: number; max_output_tokens?: number }>
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
  readonly context_window_in?: number | undefined
  readonly context_window_max?: number | undefined
  readonly context_window_out?: number | undefined
}

/** 六类归因（18 §8.2 / 19 §6.4）：每类配**独立**文案，不合并成一句"失败" */
type ProbeFailureKind =
  | 'credential-rejected'
  | 'endpoint-unreachable'
  | 'model-not-found'
  | 'timeout'
  | 'provider-not-running'
  | 'not-configured'

type ProbeFailure = {
  readonly kind: ProbeFailureKind
  readonly code: string
  readonly message: string
}

type ProbeResult =
  | { readonly ok: true; readonly models: readonly { readonly id: string }[] }
  | { readonly ok: false; readonly failure: ProbeFailure }

interface DiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
}

type DiscoverResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[] }
  | { readonly ok: false; readonly failure: ProbeFailure }

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
                <span className="mctx" title={t('上下文窗口')}>
                  {formatWindowTokens(m.context_window_in ?? m.context_window_max ?? FALLBACK_CONTEXT_WINDOW)}
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
          onSave={async (draft) => {
            const bridge = modelBridge()
            if (bridge === undefined) {
              toast(t('当前环境没有主进程桥，无法保存'))
              return
            }
            try {
              const saved = await bridge.save(draft)
              await refresh()
              // 18 §8.2：保存后**必须**立即自检并给可读结果（用模型 id，不是显示名）
              const result = await bridge.probe({ provider: saved.provider, model: draft.model ?? draft.label })
              toast(probeMessage(result))
              closeModal()
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

/** 三个产品层字面量，写死自文档 12 §3.3（底层是 sandbox/mode × approval/policy 的打包） */
const PERM_PILLS: readonly { id: PermissionPreset; ic: string; pd: string }[] = [
  { id: '只读', ic: 'RO', pd: '不会改动任何文件，适合先让它看代码' },
  { id: '工作区内修改', ic: 'WS', pd: '可改工作区文件；越界或高风险动作前询问' },
  { id: '完全访问', ic: 'FU', pd: '哪里都能碰，但动手前问你' },
]

interface SandboxStatusView {
  readonly available: boolean
  readonly mechanism: string
  readonly degraded: boolean
  readonly reason?: string | undefined
  readonly providerAvailable?: boolean | undefined
  readonly capabilities: {
    readonly boundaries: Readonly<Record<string, { readonly state: 'enforced' | 'unavailable'; readonly message: string }>>
  }
}

function PermSection() {
  const prefs = useUiPrefs()
  const cur = prefs.permissionPreset
  const [state, setState] = useState<PermissionPresetState | undefined>()
  const [sandbox, setSandbox] = useState<SandboxStatusView | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void syncPermissionPresetFromMain().then(setState).catch(() => setState(undefined))
    void window.lcode.sandbox.status()
      .then((value) => setSandbox(value as SandboxStatusView))
      .catch(() => setSandbox(null))
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
        <div className="sh2">
          {t('系统沙箱')}
          <span className={'ext-tag' + (sandbox !== null && sandbox.degraded === false ? ' on' : '')}>
            {sandbox === null ? t('读取中…') : sandbox.degraded ? t('降级') : t('已启用')}
          </span>
        </div>
        <div className="srow">
          <div className="sl">{t('机制')}</div>
          <div className="sr">
            <span className="src">{sandbox?.mechanism === 'none' || sandbox === null ? t('无（命令在无约束下运行）') : sandbox.mechanism}</span>
          </div>
        </div>
        {sandbox?.reason !== undefined && sandbox.reason !== '' ? (
          <div className="srow">
            <div className="sl">{t('说明')}</div>
            <div className="sr"><span className="src">{sandbox.reason}</span></div>
          </div>
        ) : null}
        {sandbox !== null ? (
          <div className="srow">
            <div className="sl">{t('边界')}</div>
            <div className="sr" style={{ flexWrap: 'wrap' }}>
              {Object.entries(sandbox.capabilities.boundaries).map(([key, boundary]) => (
                <span className="src" key={key}>
                  {t(key === 'filesystem' ? '文件系统' : key === 'network' ? '网络' : '进程')}：{boundary.state === 'enforced' ? t('已约束') : t('未约束')}
                </span>
              ))}
            </div>
          </div>
        ) : null}
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

/* ───────── 分区：技能 ───────── */

interface SkillRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: 'builtin' | 'user' | 'workspace'
}

function SkillsSection() {
  const [skills, setSkills] = useState<readonly SkillRow[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | undefined>()
  const [removing, setRemoving] = useState<SkillRow | null>(null)

  const refresh = (): void => {
    void window.lcode.skills
      .list()
      .then((value) => setSkills(Array.isArray(value) ? value as SkillRow[] : []))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('读取技能失败')))
  }
  useEffect(refresh, [])

  const importSkill = async (kind: 'md' | 'zip'): Promise<void> => {
    const path = kind === 'md'
      ? await window.lcode.chooseSkillMarkdown(t('选择 SKILL.md'))
      : await window.lcode.chooseSkillArchive(t('选择技能 zip'))
    if (!path) return
    setBusy(kind)
    try {
      const result = await window.lcode.skills.import({ path }) as { imported?: { name?: string } }
      refresh()
      toast(t('已导入技能：{name}', { name: result.imported?.name ?? t('未命名技能') }))
    } catch (error) {
      toast(error instanceof Error ? error.message : t('技能导入失败'))
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (): Promise<void> => {
    if (removing === null) return
    setBusy(`remove:${removing.id}`)
    try {
      await window.lcode.skills.remove({ id: removing.id })
      setRemoving(null)
      refresh()
      toast(t('已删除技能：{name}', { name: removing.name }))
    } catch (error) {
      toast(error instanceof Error ? error.message : t('技能删除失败'))
    } finally {
      setBusy(undefined)
    }
  }

  const filtered = skills.filter((skill) => {
    const needle = query.trim().toLowerCase()
    return needle === '' || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)
  })

  return (
    <>
      <h2>{t('技能')}</h2>
      <div className="sub">{t('技能是本地只读的 SKILL.md 指令。可以在提问时从输入区「＋ → 技能」选择，指令作为上下文发送，不会执行代码。')}</div>
      <div className="sect">
        <div className="sh2">
          {t('已安装技能')}
          <span className="sh2-actions">
            <button className="mini" disabled={busy !== undefined} onClick={() => void importSkill('md')}>
              ＋ {busy === 'md' ? t('正在导入…') : t('导入 SKILL.md')}
            </button>
            <button className="mini" disabled={busy !== undefined} onClick={() => void importSkill('zip')}>
              ＋ {busy === 'zip' ? t('正在导入…') : t('导入 zip')}
            </button>
          </span>
        </div>
        {skills.length > 0 ? (
          <div className="srow">
            <div className="sl">{t('搜索技能')}</div>
            <div className="sr">
              <TextInput placeholder={t('按名称或描述筛选…')} value={query} onChange={setQuery} />
            </div>
          </div>
        ) : null}
        {filtered.length > 0 ? (
          <div className="modelList ext-list">
            {filtered.map((skill) => (
              <div className="mrow ext-row" key={`${skill.source}:${skill.id}`}>
                <span className="mic">✦</span>
                <div className="ext-main">
                  <div className="mnm">
                    {skill.name}
                    <span className="ext-tag">
                      {skill.source === 'user' ? t('用户') : skill.source === 'workspace' ? t('工作区') : t('内置')}
                    </span>
                  </div>
                  <div className="msrc ext-desc" title={skill.description}>{skill.description}</div>
                </div>
                {skill.source === 'user' ? (
                  <span className="macts">
                    <button
                      type="button"
                      title={t('删除技能')}
                      aria-label={t('删除技能')}
                      disabled={busy !== undefined}
                      onClick={() => setRemoving(skill)}
                    >
                      ✕
                    </button>
                  </span>
                ) : (
                  <span className="ext-readonly">{t('只读')}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="ext-empty">
            <div className="ext-empty-icon" aria-hidden="true">✦</div>
            <div className="ext-empty-title">{skills.length === 0 ? t('还没有技能') : t('没有匹配的技能')}</div>
            {skills.length === 0 ? (
              <>
                <div className="ext-empty-note">{t('导入 SKILL.md 或含技能目录的 zip，就会出现在这里和输入区「＋」中。')}</div>
                <div className="ext-empty-actions">
                  <button className="btn" disabled={busy !== undefined} onClick={() => void importSkill('md')}>{t('导入 SKILL.md')}</button>
                  <button className="btn" disabled={busy !== undefined} onClick={() => void importSkill('zip')}>{t('导入 zip')}</button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('安全')}</span>
        <span>{t('导入只复制文件到用户技能目录，不会执行技能里的脚本；zip 会校验路径、文件数与解压大小。工作区技能来自当前项目，只读展示。')}</span>
      </div>
      {removing !== null ? (
        <ConfirmDialog
          title={t('删除技能')}
          message={t('会从用户技能目录删除「{name}」及其附加文件，无法恢复。', { name: removing.name })}
          confirmLabel={t('删除')}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  )
}

/* ───────── 分区：网络访问（web 域名白名单） ───────── */

interface WebAllowlistEntryView {
  readonly workspace: string
  readonly domains: readonly string[]
}

interface NetworkAuditEntryView {
  readonly at: number
  readonly sessionId: string
  readonly workspace: string
  readonly tool: string
  readonly domain: string
  readonly decision: 'allowed' | 'denied'
  readonly url?: string
  readonly detail?: string
}

function parseAuditEntries(value: unknown): readonly NetworkAuditEntryView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    if (
      typeof record['at'] !== 'number' ||
      typeof record['sessionId'] !== 'string' ||
      typeof record['workspace'] !== 'string' ||
      typeof record['tool'] !== 'string' ||
      typeof record['domain'] !== 'string' ||
      (record['decision'] !== 'allowed' && record['decision'] !== 'denied')
    ) return []
    return [{
      at: record['at'],
      sessionId: record['sessionId'],
      workspace: record['workspace'],
      tool: record['tool'],
      domain: record['domain'],
      decision: record['decision'],
      ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
      ...(typeof record['detail'] === 'string' ? { detail: record['detail'] } : {}),
    }]
  })
}

function workspaceLabel(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace
}

function NetworkAccessSection() {
  const [entries, setEntries] = useState<readonly WebAllowlistEntryView[]>([])
  const [audit, setAudit] = useState<readonly NetworkAuditEntryView[]>([])
  const [busy, setBusy] = useState<string | undefined>()
  const [clearing, setClearing] = useState(false)

  const loadAllowlist = (): Promise<void> =>
    window.lcode.webAllowlist.list()
      .then((value) => setEntries(Array.isArray(value) ? value as WebAllowlistEntryView[] : []))
      .catch((error: unknown) => { toast(error instanceof Error ? error.message : t('读取网络白名单失败')) })
  const loadAudit = (): Promise<void> =>
    window.lcode.networkAudit.list({ limit: 30 })
      .then((value) => setAudit(parseAuditEntries(value)))
      .catch((error: unknown) => { toast(error instanceof Error ? error.message : t('读取网络审计失败')) })

  useEffect(() => {
    void loadAllowlist()
    void loadAudit()
  }, [])

  const remove = (workspace: string, domain: string): void => {
    const key = `${workspace}|${domain}`
    setBusy(key)
    void window.lcode.webAllowlist.remove({ workspace, domain })
      .then((value) => setEntries(Array.isArray(value) ? value as WebAllowlistEntryView[] : []))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('移除域名失败')))
      .finally(() => setBusy(undefined))
  }

  const prune = (): void => {
    setBusy('prune')
    void window.lcode.webAllowlist.prune()
      .then((value) => {
        const record = value as { entries?: unknown; removed?: unknown } | null
        setEntries(Array.isArray(record?.entries) ? record.entries as WebAllowlistEntryView[] : [])
        const removed = typeof record?.removed === 'number' ? record.removed : 0
        toast(removed === 0 ? t('没有失效工作区') : t('已清理 {n} 个失效工作区', { n: removed }))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('清理失效工作区失败')))
      .finally(() => setBusy(undefined))
  }

  const clearAudit = (): void => {
    setBusy('audit')
    void window.lcode.networkAudit.clear()
      .then(() => {
        setAudit([])
        setClearing(false)
        toast(t('已清空网络审计'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('清空网络审计失败')))
      .finally(() => setBusy(undefined))
  }

  return (
    <>
      <h2>{t('网络访问')}</h2>
      <div className="sub">{t('web 工具调用新域名时会请求审批；批准后按工作区记住，可在这里移除。')}</div>
      <div className="sect">
        <div className="sh2">
          {t('已允许的域名')}
          {entries.length > 0 ? (
            <button className="mini" disabled={busy !== undefined} onClick={prune}>
              {t('清理失效工作区')}
            </button>
          ) : null}
        </div>
        {entries.length === 0 ? (
          <div className="bplug-note">{t('还没有已允许的域名。')}</div>
        ) : entries.map((entry) => (
          <div className="srow" key={entry.workspace}>
            <div className="sl" title={entry.workspace}>{workspaceLabel(entry.workspace)}</div>
            <div className="sr" style={{ flexWrap: 'wrap' }}>
              {entry.domains.map((domain) => (
                <span className="netdomain" key={domain}>
                  {domain}
                  <button
                    type="button"
                    title={t('移除')}
                    disabled={busy === `${entry.workspace}|${domain}`}
                    onClick={() => remove(entry.workspace, domain)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="sect" style={{ marginTop: 16 }}>
        <div className="sh2">
          {t('最近网络请求')}
          {audit.length > 0 ? (
            <button className="mini" disabled={busy !== undefined} onClick={() => setClearing(true)}>
              {t('清空审计')}
            </button>
          ) : null}
        </div>
        {audit.length === 0 ? (
          <div className="bplug-note">{t('还没有网络请求记录。')}</div>
        ) : audit.map((entry, index) => (
          <div className="srow" key={`${entry.at}-${entry.domain}-${index}`}>
            <div className="sl" title={entry.workspace}>
              {new Date(entry.at).toLocaleString()}
            </div>
            <div className="sr">
              <span className="src">
                <b className={entry.decision === 'allowed' ? 'audit-allowed' : 'audit-denied'}>
                  {entry.decision === 'allowed' ? t('已允许') : t('已拒绝')}
                </b>
                {' · '}{entry.tool}{' · '}<span className="mono">{entry.domain}</span>{' · '}{workspaceLabel(entry.workspace)}
              </span>
              {entry.url === undefined ? null : (
                <span className="src mono net-audit-url" title={entry.url}>{entry.url}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('安全')}</span>
        <span>{t('web 工具会拒绝本机、私网与云元数据地址；重定向逐跳校验。')}</span>
      </div>
      {clearing ? (
        <ConfirmDialog
          title={t('清空网络审计')}
          message={t('会删除本机的网络请求审计记录（不会影响会话日志），是否继续？')}
          confirmLabel={t('清空')}
          danger
          onCancel={() => setClearing(false)}
          onConfirm={clearAudit}
        />
      ) : null}
    </>
  )
}

/* ───────── 分区：网页搜索 ───────── */

interface WebSearchStatusView {
  readonly provider: { readonly id: string; readonly label: string; readonly endpointHost: string }
  readonly configured: boolean
  readonly source: string | null
  readonly maxResults: number
}

function credentialSourceLabel(source: string | null): string {
  switch (source) {
    case 'keychain': return t('系统钥匙串')
    case 'file-0600': return t('本机凭据文件')
    case 'env': return t('环境变量')
    case 'lcode-home-env': return t('Lcode Home .env')
    case 'project-env': return t('项目 .env')
    default: return t('未配置')
  }
}

function toWebSearchStatus(value: unknown): WebSearchStatusView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = record['provider']
  if (typeof provider !== 'object' || provider === null) return undefined
  const info = provider as Record<string, unknown>
  if (typeof info['id'] !== 'string' || typeof info['label'] !== 'string' || typeof info['endpointHost'] !== 'string') return undefined
  const maxResults = typeof record['maxResults'] === 'number' ? record['maxResults'] : 5
  return {
    provider: { id: info['id'], label: info['label'], endpointHost: info['endpointHost'] },
    configured: record['configured'] === true,
    source: typeof record['source'] === 'string' ? record['source'] : null,
    maxResults: Math.min(10, Math.max(1, Math.floor(maxResults))),
  }
}

function WebSearchSection() {
  const [status, setStatus] = useState<WebSearchStatusView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [maxResults, setMaxResults] = useState('5')
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | undefined>()
  const [removing, setRemoving] = useState(false)

  const apply = (value: unknown): void => {
    const next = toWebSearchStatus(value)
    if (next === undefined) return
    setStatus(next)
    setMaxResults(String(next.maxResults))
  }

  useEffect(() => {
    void window.lcode.webSearch.status()
      .then(apply)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('读取网页搜索配置失败')))
  }, [])

  const save = (): void => {
    const parsed = Number(maxResults)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      toast(t('每次结果数必须是 1-10 的整数'))
      return
    }
    setBusy('save')
    void window.lcode.webSearch.save({ apiKey, maxResults: parsed })
      .then((value) => {
        apply(value)
        setApiKey('')
        toast(t('已保存'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('保存网页搜索配置失败')))
      .finally(() => setBusy(undefined))
  }

  const test = (): void => {
    setBusy('test')
    void window.lcode.webSearch.test({ apiKey })
      .then((value) => {
        const count = typeof value === 'object' && value !== null && typeof (value as { count?: unknown }).count === 'number'
          ? (value as { count: number }).count
          : 0
        toast(t('连接成功（返回 {count} 条结果）', { count }))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('测试连接失败')))
      .finally(() => setBusy(undefined))
  }

  const remove = (): void => {
    setBusy('remove')
    void window.lcode.webSearch.remove()
      .then((value) => {
        apply(value)
        setRemoving(false)
        toast(t('已移除 Tavily API Key'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('移除 Tavily API Key 失败')))
      .finally(() => setBusy(undefined))
  }

  const host = status?.provider.endpointHost ?? 'api.tavily.com'
  return (
    <>
      <h2>{t('网页搜索')}</h2>
      <div className="sub">{t('让 Agent 具备联网搜索能力。搜索词会发送给 Tavily，结果按不可信内容处理。')}</div>
      <div className="sect">
        <div className="sh2">
          {t('Tavily')}
          <span className="src" style={{ marginLeft: 'auto' }}>
            {status?.configured === true ? `${t('已配置')} · ${credentialSourceLabel(status.source)}` : t('未配置')}
          </span>
        </div>
        <div className="srow">
          <div className="sl">{t('API Key')}</div>
          <div className="sr">
            <div className="field">
              <TextInput
                type="password"
                value={apiKey}
                onChange={setApiKey}
                placeholder={status?.configured === true ? t('已保存；留空则不修改') : 'tvly-...'}
                autoComplete="off"
              />
            </div>
            <span className="src">{t('Key 只保存在本机凭据存储，不会写进设置文件，也不会显示完整值。')}</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl">{t('每次最多结果')}</div>
          <div className="sr">
            <div className="field" style={{ maxWidth: 160 }}>
              <TextInput value={maxResults} onChange={setMaxResults} />
            </div>
            <span className="src">{t('范围 1-10；模型也可以请求更少的结果。')}</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl" />
          <div className="sr">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy !== undefined} onClick={save}>{t('保存')}</button>
              <button className="btn" disabled={busy !== undefined} onClick={test}>{t('测试连接')}</button>
              {status?.configured === true ? (
                <button className="btn danger" disabled={busy !== undefined} onClick={() => setRemoving(true)}>{t('移除 Key')}</button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('网络')}</span>
        <span>{t('搜索端点固定为 {host}；首次搜索仍会按工作区请求网络审批，批准后记住该域名。搜索结果不会自动加入网页抓取白名单；每轮最多 5 次搜索。', { host })}</span>
      </div>
      {removing ? (
        <ConfirmDialog
          title={t('移除网页搜索 Key')}
          message={t('移除后将无法使用 web_search，但不会删除任何会话数据。')}
          confirmLabel={t('移除')}
          danger
          onCancel={() => setRemoving(false)}
          onConfirm={remove}
        />
      ) : null}
    </>
  )
}

/* ───────── 分区：Agent 预设 ───────── */

function AgentPresetSection() {
  const [presets, setPresets] = useState<readonly AgentPresetOption[]>([])
  const [current, setCurrent] = useState<AgentPresetState | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void listAgentPresets()
      .then((value) => {
        setPresets(value.presets)
        setCurrent(value.current ?? null)
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('读取 Agent 预设失败')))
  }, [])
  const choose = (preset: AgentPresetOption): void => {
    if (!preset.available || saving) return
    setSaving(true)
    void chooseAgentPreset(preset.id)
      .then((state) => {
        setCurrent(state ?? null)
        toast(t('已切换 Agent 预设：{name}', { name: t(preset.name) }))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('切换 Agent 预设失败')))
      .finally(() => setSaving(false))
  }
  return (
    <>
      <h2>{t('Agent 预设')}</h2>
      <div className="sub">{t('选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展能力用「创造模式」。')}</div>
      <div className="sect">
        <div className="sh2">{t('内置预设')}</div>
        <div className="presetgrid">
          {presets.map((preset) => {
            const active = current?.preset === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                className={'presetcard' + (active ? ' on' : '')}
                disabled={!preset.available || saving}
                onClick={() => choose(preset)}
              >
                <div className="presethead">
                  <span className="presetname">{t(preset.name)}</span>
                  <span className={'ext-tag' + (active ? ' on' : '')}>
                    {active ? t('当前') : preset.available ? t('可选') : t('规划中')}
                  </span>
                </div>
                <div className="presetdesc">{t(preset.description)}</div>
                <code className="presetid">{preset.id}</code>
              </button>
            )
          })}
        </div>
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('说明')}</span>
        <span>{t('Agent 预设决定工具与工作方式；权限（只读 / 工作区内修改 / 完全访问）决定能碰什么，两者独立生效。')}</span>
      </div>
    </>
  )
}

/* ───────── 分区：插件 ───────── */

interface PluginEntry {
  readonly id: string
  readonly version: string
  readonly state: 'installed' | 'enabled'
  readonly active: boolean
  readonly source: 'builtin' | 'local' | 'market'
  readonly installedAt: number
  readonly permissions: Record<string, unknown>
  readonly contributes: { readonly tools?: readonly string[]; readonly services?: readonly string[]; readonly promptSections?: readonly string[] }
}

type BuiltinPluginModeId = string

interface BuiltinPluginModeState {
  readonly configured: boolean
  readonly running: boolean
}

interface BuiltinPluginView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly group: 'session' | 'global'
  readonly fullName: string
  readonly source: string
  readonly provides: readonly string[]
  readonly requires: readonly string[]
  readonly modes: Readonly<Record<string, BuiltinPluginModeState>>
}

interface BuiltinPluginCatalog {
  readonly profile: string
  readonly modes: readonly { readonly id: BuiltinPluginModeId; readonly name: string; readonly description: string }[]
  readonly plugins: readonly BuiltinPluginView[]
}

function BuiltinPluginCard({
  plugin,
  mode,
  expanded,
  onToggle,
}: {
  readonly plugin: BuiltinPluginView
  readonly mode: BuiltinPluginModeId
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const state = plugin.modes[mode] ?? { configured: false, running: false }
  return (
    <div className={'bplug' + (state.configured ? '' : ' off')}>
      <button className="bplug-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="bplug-name">{t(plugin.name)}</span>
        {state.configured ? null : <span className="bplug-tag">{t('已停用')}</span>}
        <span className="bplug-chev">{expanded ? '⌃' : '⌄'}</span>
      </button>
      <div className="bplug-desc">{t(plugin.description)}</div>
      <code className="bplug-id">{plugin.id}</code>
      {expanded ? (
        <div className="bplug-detail">
          <div className="bplug-row"><span>{t('完整名称')}</span><code className="mono">{plugin.fullName}</code></div>
          <div className="bplug-row"><span>{t('来自')}</span><span>{t(plugin.source)}</span></div>
          <div className="bplug-row"><span>{t('配置状态')}</span><span>{state.configured ? t('已启用') : t('已停用')}</span></div>
          <div className="bplug-row"><span>{t('运行状态')}</span><span>{state.running ? t('运行中') : t('未运行')}</span></div>
          {plugin.provides.length > 0 ? (
            <div className="bplug-row"><span>{t('提供')}</span><span className="mono">{plugin.provides.join('、')}</span></div>
          ) : null}
          {plugin.requires.length > 0 ? (
            <div className="bplug-row"><span>{t('依赖')}</span><span className="mono">{plugin.requires.join('、')}</span></div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function PluginSection() {
  const [catalog, setCatalog] = useState<BuiltinPluginCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [mode, setMode] = useState<BuiltinPluginModeId>('standard')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<readonly PluginEntry[]>([])
  const [busy, setBusy] = useState<string | undefined>()
  const [uninstalling, setUninstalling] = useState<PluginEntry | null>(null)
  useEffect(() => {
    void window.lcode.runtime.builtinPlugins()
      .then((value) => {
        const next = value as BuiltinPluginCatalog
        if (next !== null && Array.isArray(next?.plugins)) setCatalog(next)
        else setCatalogError(true)
      })
      .catch(() => setCatalogError(true))
  }, [])
  const refresh = (): void => {
    void window.lcode.plugins.list().then((value) => setPlugins(Array.isArray(value) ? value as PluginEntry[] : [])).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : t('读取插件失败'))
    })
  }
  useEffect(refresh, [])
  const install = async (): Promise<void> => {
    const path = await window.lcode.chooseFolder(t('选择插件文件夹'))
    if (!path) return
    setBusy('install')
    try {
      await window.lcode.plugins.install({ path })
      refresh()
      toast(t('插件已安装，尚未启动'))
    } catch (error) {
      toast(error instanceof Error ? error.message : t('插件安装失败'))
    } finally {
      setBusy(undefined)
    }
  }
  const operate = async (action: 'activate' | 'deactivate', plugin: PluginEntry): Promise<void> => {
    const key = `${action}:${plugin.id}@${plugin.version}`
    setBusy(key)
    try {
      await window.lcode.plugins[action]({ id: plugin.id, version: plugin.version })
      refresh()
      toast(t(action === 'activate' ? '插件已启动' : '插件已停用'))
    } catch (error) {
      toast(error instanceof Error ? error.message : t('插件操作失败'))
    } finally {
      setBusy(undefined)
    }
  }
  const uninstall = async (): Promise<void> => {
    if (uninstalling === null) return
    const plugin = uninstalling
    setBusy(`uninstall:${plugin.id}@${plugin.version}`)
    try {
      await window.lcode.plugins.uninstall({ id: plugin.id, version: plugin.version })
      setUninstalling(null)
      refresh()
      toast(t('插件已卸载'))
    } catch (error) {
      toast(error instanceof Error ? error.message : t('插件操作失败'))
    } finally {
      setBusy(undefined)
    }
  }
  const sessionPlugins = catalog?.plugins.filter((plugin) => plugin.group === 'session') ?? []
  const globalPlugins = catalog?.plugins.filter((plugin) => plugin.group === 'global') ?? []
  const activeMode = catalog?.modes.find((item) => item.id === mode)
  const renderCard = (plugin: BuiltinPluginView): ReactNode => (
    <BuiltinPluginCard
      key={plugin.id}
      plugin={plugin}
      mode={mode}
      expanded={expanded === plugin.id}
      onToggle={() => setExpanded(expanded === plugin.id ? null : plugin.id)}
    />
  )
  return (
    <>
      <h2>{t('插件')}</h2>
      <div className="sub">{t('内置插件随模式在代码中启用，这里只能查看，不提供开关。')}</div>

      <div className="sect">
        <div className="sh2">
          {t('会话插件')}
          {catalog !== null && catalog.modes.length > 0 ? (
            <span className="sh2-actions">
              <PopMenu
                trigger={`${t(activeMode?.name ?? '标准模式（默认）')} ▾`}
                buttonClass="btn mini"
                title="查看不同模式下的插件"
                dense
                width={196}
                items={catalog.modes.map((item) => ({
                  id: item.id,
                  label: item.name,
                  hint: item.description,
                  checked: item.id === mode,
                }))}
                onSelect={(id) => {
                  setMode(id as BuiltinPluginModeId)
                  setExpanded(null)
                }}
              />
            </span>
          ) : null}
        </div>
        <div className="sub">{t('由 Agent 预设按会话组成')}{activeMode === undefined ? '' : ` · ${t(activeMode.description)}`}</div>
        {catalogError ? (
          <div className="bplug-note">{t('读取内置插件失败，重启应用后再试。')}</div>
        ) : catalog === null ? (
          <div className="bplug-note">{t('正在读取内置插件…')}</div>
        ) : (
          <div className="bplug-grid">{sessionPlugins.map(renderCard)}</div>
        )}
      </div>

      <div className="sect">
        <div className="sh2">{t('全局插件')}</div>
        <div className="sub">{t('系统与所有会话共用')}</div>
        {catalogError ? null : catalog === null ? (
          <div className="bplug-note">{t('正在读取内置插件…')}</div>
        ) : (
          <div className="bplug-grid">{globalPlugins.map(renderCard)}</div>
        )}
      </div>

      <div className="sect">
        <div className="sh2">
          {t('第三方插件')}
          <span className="sh2-actions">
            <button className="mini" disabled={busy !== undefined} onClick={() => void install()}>
              ＋ {busy === 'install' ? t('正在安装…') : t('从文件夹安装')}
            </button>
          </span>
        </div>
        <div className="sub">{t('第三方插件在独立受控进程中运行，只有声明的工具、提示段和事件订阅可以注册。')}</div>
        {plugins.length > 0 ? (
          <div className="modelList ext-list">
            {plugins.map((plugin) => {
              const key = `${plugin.id}@${plugin.version}`
              const tools = plugin.contributes.tools ?? []
              const prompts = plugin.contributes.promptSections ?? []
              return (
                <div className="mrow ext-row" key={key}>
                  <span className="mic">⬡</span>
                  <div className="ext-main">
                    <div className="mnm">
                      <code className="mono">{plugin.id}</code>
                      <span className="ext-version">v{plugin.version}</span>
                      <span className={'ext-tag' + (plugin.active ? ' on' : '')}>
                        {plugin.active ? t('运行中') : t('未启动')}
                      </span>
                    </div>
                    <div className="msrc ext-desc">
                      {t('工具')}：{tools.length === 0 ? t('无') : tools.join('、')} · {t('提示段')}：{prompts.length === 0 ? t('无') : prompts.join('、')}
                    </div>
                  </div>
                  <span className="macts">
                    {plugin.active ? (
                      <button type="button" title={t('停用插件')} aria-label={t('停用插件')} disabled={busy !== undefined} onClick={() => void operate('deactivate', plugin)}>⏸</button>
                    ) : (
                      <button type="button" title={t('启动插件')} aria-label={t('启动插件')} disabled={busy !== undefined} onClick={() => void operate('activate', plugin)}>▶</button>
                    )}
                    <button type="button" title={t('卸载插件')} aria-label={t('卸载插件')} disabled={busy !== undefined} onClick={() => setUninstalling(plugin)}>✕</button>
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="bplug-note">{t('还没有安装第三方插件。')}</div>
        )}
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('安全')}</span>
        <span>{t('安装只复制和校验插件快照，不会执行代码；首次启动也必须通过当前系统沙箱。')}</span>
      </div>
      {uninstalling !== null ? (
        <ConfirmDialog
          title={t('卸载插件')}
          message={t('卸载后会删除本地快照，是否继续？')}
          confirmLabel={t('卸载')}
          danger
          onCancel={() => setUninstalling(null)}
          onConfirm={() => void uninstall()}
        />
      ) : null}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 归档与回收站：工作区归档是本地视图状态（sidebar.json），会话归档是软删。
 * 两者都要能在这里看见并恢复——否则归档等于「消失」。
 * 永久归档则进回收站（`trash/`），不可恢复，只能整体清空。
 */
function ArchiveSection() {
  const [sessions, setSessions] = useState<readonly SessionMeta[]>([])
  const [workspaces, setWorkspaces] = useState<readonly { key: string; name: string }[]>([])
  const [trash, setTrash] = useState<readonly TrashEntry[]>([])
  const [trashBytes, setTrashBytes] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [emptying, setEmptying] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<
    { kind: 'one'; id: string; title: string } | { kind: 'all' } | null
  >(null)

  const load = useCallback(async () => {
    const bridge = sessionBridge()
    if (bridge !== undefined) {
      const [result, trashResult] = await Promise.all([
        bridge.list({ includeDeleted: true, limit: 200 }),
        bridge.trash(),
      ])
      setSessions(result.items.filter((item) => item.deleted_at !== null))
      setTrash(trashResult.items)
      setTrashBytes(trashResult.total_bytes)
    }
    const sidebar = (await window.lcode.getSidebar()) as { archivedWorkspaces?: string[] } | null
    setWorkspaces(
      (sidebar?.archivedWorkspaces ?? []).map((key) => ({
        key,
        name: key.split(/[\\/]/).filter(Boolean).pop() ?? key,
      })),
    )
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const restoreSession = (id: string): void => {
    const bridge = sessionBridge()
    if (bridge === undefined) return
    setBusy(id)
    void bridge
      .restore({ session_id: id })
      .then(() => {
        window.dispatchEvent(new Event('lcode:session-changed'))
        toast(t('已恢复会话'))
        return load()
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('恢复失败')))
      .finally(() => setBusy(null))
  }

  const restoreWorkspace = (key: string): void => {
    setBusy(key)
    void (async () => {
      const current = (await window.lcode.getSidebar()) as {
        pinnedWorkspaces: string[]
        archivedWorkspaces: string[]
        pinnedSessions: string[]
        collapsedWorkspaces: string[]
      }
      await window.lcode.setSidebar({
        ...current,
        archivedWorkspaces: current.archivedWorkspaces.filter((item) => item !== key),
      })
      window.dispatchEvent(new Event('lcode:sidebar-changed'))
      toast(t('已取消归档'))
      await load()
    })()
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('恢复失败')))
      .finally(() => setBusy(null))
  }

  const emptyTrash = (): void => {
    const bridge = sessionBridge()
    if (bridge === undefined) return
    setBusy('trash')
    void bridge
      .emptyTrash()
      .then(() => {
        setEmptying(false)
        toast(t('已清空回收站'))
        return load()
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('清空失败')))
      .finally(() => setBusy(null))
  }

  /** 归档会话 → 永久归档（进回收站）。批量时逐条执行，失败的不影响其它。 */
  const confirmPurge = (): void => {
    const bridge = sessionBridge()
    const target = purgeTarget
    if (bridge === undefined || target === null) return
    const targets = target.kind === 'all' ? sessions : sessions.filter((item) => item.session_id === target.id)
    if (targets.length === 0) {
      setPurgeTarget(null)
      return
    }
    setBusy('purge')
    void Promise.allSettled(targets.map((item) => bridge.purge({ session_id: item.session_id, force: true })))
      .then((results) => {
        const done = results.filter((item) => item.status === 'fulfilled').length
        window.dispatchEvent(new Event('lcode:session-changed'))
        toast(
          target.kind === 'all'
            ? t('已把 {n} 个归档会话移入回收站', { n: done })
            : t('已移入回收站'),
        )
        setPurgeTarget(null)
        return load()
      })
      .finally(() => setBusy(null))
  }

  return (
    <>
      <h2>{t('归档与回收站')}</h2>
      <div className="sub">{t('查看已归档的工作区与会话，并把它们恢复到侧栏。')}</div>
      <div className="sect">
        <div className="sh2">{t('已归档工作区')}</div>
        {workspaces.length === 0 ? (
          <div className="srow">
            <div className="sl">{t('没有归档的工作区。')}</div>
          </div>
        ) : (
          workspaces.map((item) => (
            <div className="srow" key={item.key}>
              <div className="sl">{item.name}</div>
              <div className="sr">
                <span className="src">{item.key}</span>
              </div>
              <button className="btn" disabled={busy !== null} onClick={() => restoreWorkspace(item.key)}>
                {t('恢复')}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="sect">
        <div className="sh2">
          {t('已归档会话')}
          {sessions.length > 0 && (
            <button
              className="mini danger"
              disabled={busy !== null}
              onClick={() => setPurgeTarget({ kind: 'all' })}
            >
              {t('全部删除')}
            </button>
          )}
        </div>
        <div className="hint" style={{ padding: '10px 16px' }}>
          {t('归档的会话不会自动清除，会一直保留到你恢复或永久归档。')}
        </div>
        {sessions.length === 0 ? (
          <div className="srow">
            <div className="sl">{t('没有归档的会话。')}</div>
          </div>
        ) : (
          sessions.map((item) => (
            <div className="srow" key={item.session_id}>
              <div className="sl">{item.title || t('未命名会话')}</div>
              <div className="sr">
                <span className="src">
                  {item.workspace ?? t('未设置工作区')} · {new Date(item.updated_at).toLocaleString()}
                </span>
              </div>
              <button className="btn" disabled={busy !== null} onClick={() => restoreSession(item.session_id)}>
                {t('恢复')}
              </button>
              <button
                className="btn danger"
                disabled={busy !== null}
                onClick={() => setPurgeTarget({ kind: 'one', id: item.session_id, title: item.title })}
              >
                {t('删除')}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="sect">
        <div className="sh2">
          {t('回收站（不可恢复）')}
          {trash.length > 0 && (
            <button className="mini" disabled={busy !== null} onClick={() => setEmptying(true)}>
              {t('清空回收站')}
            </button>
          )}
        </div>
        <div className="hint" style={{ padding: '10px 16px' }}>
          {t('永久归档的文件先进入回收站，保留 7 天；到期后由后台自动清理，也可以立即清空。清空后无法恢复。')}
        </div>
        {trash.length === 0 ? (
          <div className="srow">
            <div className="sl">{t('回收站是空的。')}</div>
          </div>
        ) : (
          trash.map((item) => (
            <div className="srow" key={item.path}>
              <div className="trash-label" title={item.label || t('未命名会话')}>
                {item.label || t('未命名会话')}
              </div>
            </div>
          ))
        )}
      </div>
      {purgeTarget !== null && (
        <ConfirmDialog
          title={t('永久删除会话')}
          message={
            purgeTarget.kind === 'all'
              ? t('会把 {n} 个归档会话全部移入回收站；回收站不能恢复，只能清空。', { n: sessions.length })
              : t('会把「{name}」移入回收站；回收站不能恢复，只能清空。', {
                  name: purgeTarget.title || t('未命名会话'),
                })
          }
          confirmLabel={t('删除')}
          danger
          onCancel={() => setPurgeTarget(null)}
          onConfirm={confirmPurge}
        />
      )}
      {emptying && (
        <ConfirmDialog
          title={t('清空回收站')}
          message={t('回收站里的 {n} 个文件（{size}）将被永久删除，无法恢复。', {
            n: trash.length,
            size: formatBytes(trashBytes),
          })}
          confirmLabel={t('清空')}
          danger
          onCancel={() => setEmptying(false)}
          onConfirm={emptyTrash}
        />
      )}
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
  { id: 'agentPresets', label: 'Agent 预设' },
  { g: '扩展' },
  { id: 'skills', label: '技能' },
  { id: 'plugins', label: '插件' },
  { id: 'webSearch', label: '网页搜索' },
  { g: '权限' },
  { id: 'perm', label: '权限预设' },
  { id: 'trust', label: '工作区信任' },
  { id: 'network', label: '网络访问' },
  { g: '记忆与历史' },
  { id: 'history', label: '历史与保留' },
  { id: 'export', label: '导出' },
  { id: 'archive', label: '归档与回收站' },
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
    case 'agentPresets':
      return <AgentPresetSection />
    case 'skills':
      return <SkillsSection />
    case 'plugins':
      return <PluginSection />
    case 'webSearch':
      return <WebSearchSection />
    case 'perm':
      return <PermSection />
    case 'trust':
      return <TrustSection />
    case 'network':
      return <NetworkAccessSection />
    case 'history':
      return <HistorySection />
    case 'export':
      return <ExportSection />
    case 'archive':
      return <ArchiveSection />
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
