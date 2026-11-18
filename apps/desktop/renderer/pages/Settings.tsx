import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CONTEXT_WINDOW_PROBE_MAX, CONTEXT_WINDOW_STEP, FALLBACK_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '@lcode/model-api'
import { Seg, Select, Switch, SwitchRow, TextArea, TextInput } from '../components/controls.tsx'
import { syncWindowOverlayTheme } from '../store/overlayTheme.ts'
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
import type { MemorySnapshot, TrashEntry } from '../store/sessionBridge.ts'
import type { PermissionPreset } from '../store/uiPrefs.ts' // 模型条目类型 ModelEntry 也定义在 store/uiPrefs

/**
 * P5 设置（按 Codex 布局 1:1 移植 webapp 原型）：
 * 顶部「← 返回工作台」+ 搜索框；左侧面包栏（分组导航）；右侧对应分区内容。
 * 分区：个人（常规/外观/键盘快捷键/账户）· 模型 · 权限（权限预设/工作区信任）· 记忆与历史（记忆/导出/归档与回收站）。
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
                const next = v === '深色' ? 'dark' : v === '浅色' ? 'light' : null
                setTheme(next === 'dark' ? 'dark' : 'light')
                if (next !== null) {
                  document.documentElement.dataset.theme = next
                  syncWindowOverlayTheme(next)
                }
                // 「跟随系统」暂不支持自动联动（windowControlsOverlay 只在 Windows 下有 CSS 媒体查询，
                // 深浅切换需主进程 nativeTheme 监听）；此处先保持手动。
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
 * - 「推荐」是官方直连：地址由预设给出，用户只选计费类型；
 * - 「自定义」要用户填接口地址，并选择 OpenAI / Anthropic 协议。
 *
 * 推荐供应商的计费类型来自各厂公开计费方式（2026-11）：
 * - 阿里云百炼：Token Plan / Coding Plan / 按量付费
 * - DeepSeek：仅按量付费（无订阅套餐）
 * - 智谱：GLM Coding Plan / 按量付费
 * - Kimi：Kimi Code 会员（Coding Plan）/ 按量付费
 * - MiniMax：Coding Plan / 按量付费
 * - OpenAI API：按量付费（预充值 credits），ChatGPT 订阅不能用于 API
 */
type BillingType = 'token-plan' | 'coding-plan' | 'pay-as-you-go'
type ModelProtocol = 'openai' | 'anthropic'

interface BillingOption {
  readonly id: BillingType
  readonly label: string
}

interface ProviderPreset {
  readonly id: string
  readonly label: string
  readonly group: '推荐' | '自定义'
  readonly protocol: ModelProtocol
  /** 没有计费类型差异时的固定地址 */
  readonly baseUrl: string | null
  /** 推荐供应商按计费类型切换地址；自定义协议为空 */
  readonly baseUrlByBilling?: Readonly<Partial<Record<BillingType, string>>> | undefined
  /** 可选计费类型；自定义协议为空数组 */
  readonly billing: readonly BillingOption[]
  readonly defaultBilling?: BillingType | undefined
  readonly needsKey: boolean
  /** 模型名示例，用于占位提示 */
  readonly modelHint: string
}

const BILLING_LABELS: Readonly<Record<BillingType, string>> = {
  'token-plan': 'Token Plan',
  'coding-plan': 'Coding Plan',
  'pay-as-you-go': '按量付费',
}

const BILLING_OPTIONS: Readonly<Record<BillingType, BillingOption>> = {
  'token-plan': { id: 'token-plan', label: BILLING_LABELS['token-plan'] },
  'coding-plan': { id: 'coding-plan', label: BILLING_LABELS['coding-plan'] },
  'pay-as-you-go': { id: 'pay-as-you-go', label: BILLING_LABELS['pay-as-you-go'] },
}

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'bailian',
    label: '阿里云百炼',
    group: '推荐',
    protocol: 'openai',
    baseUrl: null,
    baseUrlByBilling: {
      'token-plan': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'coding-plan': 'https://coding.dashscope.aliyuncs.com/v1',
      'pay-as-you-go': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    billing: [BILLING_OPTIONS['token-plan'], BILLING_OPTIONS['coding-plan'], BILLING_OPTIONS['pay-as-you-go']],
    defaultBilling: 'pay-as-you-go',
    needsKey: true,
    modelHint: '例如 qwen3.7-plus',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    group: '推荐',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    billing: [BILLING_OPTIONS['pay-as-you-go']],
    defaultBilling: 'pay-as-you-go',
    needsKey: true,
    modelHint: '例如 deepseek-chat',
  },
  {
    id: 'zhipu',
    label: '智谱',
    group: '推荐',
    protocol: 'openai',
    baseUrl: null,
    baseUrlByBilling: {
      'coding-plan': 'https://open.bigmodel.cn/api/coding/paas/v4',
      'pay-as-you-go': 'https://open.bigmodel.cn/api/paas/v4',
    },
    billing: [BILLING_OPTIONS['coding-plan'], BILLING_OPTIONS['pay-as-you-go']],
    defaultBilling: 'pay-as-you-go',
    needsKey: true,
    modelHint: '例如 glm-5',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    group: '推荐',
    protocol: 'openai',
    baseUrl: null,
    baseUrlByBilling: {
      'coding-plan': 'https://api.kimi.com/coding/v1',
      'pay-as-you-go': 'https://api.moonshot.cn/v1',
    },
    billing: [BILLING_OPTIONS['coding-plan'], BILLING_OPTIONS['pay-as-you-go']],
    defaultBilling: 'pay-as-you-go',
    needsKey: true,
    modelHint: '例如 kimi-k2.5',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    group: '推荐',
    protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    billing: [BILLING_OPTIONS['coding-plan'], BILLING_OPTIONS['pay-as-you-go']],
    defaultBilling: 'pay-as-you-go',
    needsKey: true,
    modelHint: '例如 MiniMax-M2.5',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: '推荐',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    billing: [BILLING_OPTIONS['pay-as-you-go']],
    defaultBilling: 'pay-as-you-go',
    needsKey: true,
    modelHint: '例如 gpt-5',
  },
  {
    id: 'custom-openai',
    label: 'OpenAI Compatible',
    group: '自定义',
    protocol: 'openai',
    baseUrl: null,
    billing: [],
    needsKey: true,
    modelHint: '例如 gpt-4o 或 openai/gpt-4o',
  },
  {
    id: 'custom-anthropic',
    label: 'Anthropic Compatible',
    group: '自定义',
    protocol: 'anthropic',
    baseUrl: null,
    billing: [],
    needsKey: true,
    modelHint: '例如 claude-sonnet-4-5',
  },
]

function presetBaseUrl(preset: ProviderPreset, billing: BillingType | ''): string | null {
  if (preset.baseUrlByBilling !== undefined && billing !== '') return preset.baseUrlByBilling[billing] ?? null
  return preset.baseUrl
}

function inferBilling(preset: ProviderPreset, baseUrl: string): BillingType | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  if (preset.baseUrlByBilling !== undefined) {
    for (const [billing, url] of Object.entries(preset.baseUrlByBilling) as [BillingType, string][]) {
      if (url.trim().replace(/\/+$/, '').toLowerCase() === normalized) return billing
    }
  }
  return undefined
}

function presetForEditing(editing: CustomModelInfo): ProviderPreset {
  const byId = PROVIDER_PRESETS.find((preset) => preset.id === editing.provider_preset)
  if (byId !== undefined) return byId
  const normalized = editing.base_url.trim().replace(/\/+$/, '').toLowerCase()
  /*
   * 百炼的业务空间会给出 `\*.maas.aliyuncs.com/compatible-mode/v1` 这类专属域名，
   * 它不在固定预设表里；按域名特征仍归到百炼，编辑时保留地址覆盖与计费类型。
   */
  try {
    const url = new URL(editing.base_url)
    const host = url.hostname.toLowerCase()
    if (
      host === 'dashscope.aliyuncs.com' ||
      host === 'coding.dashscope.aliyuncs.com' ||
      host === 'token-plan.cn-beijing.maas.aliyuncs.com' ||
      (host.endsWith('.maas.aliyuncs.com') && url.pathname.toLowerCase().includes('/compatible-mode'))
    ) {
      return PROVIDER_PRESETS.find((preset) => preset.id === 'bailian')!
    }
  } catch {
    // URL 不合法时继续走精确匹配/自定义
  }
  const matched = PROVIDER_PRESETS.find((preset) => {
    if (preset.group !== '推荐') return false
    if (preset.baseUrl !== null && preset.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === normalized) return true
    return preset.baseUrlByBilling !== undefined &&
      Object.values(preset.baseUrlByBilling).some((url) => url.trim().replace(/\/+$/, '').toLowerCase() === normalized)
  })
  if (matched !== undefined) return matched
  return PROVIDER_PRESETS.find((preset) => preset.id === (editing.protocol === 'anthropic' ? 'custom-anthropic' : 'custom-openai'))!
}

/** `AddModelModal` 提交的完整内容（**含 API Key**——它由主进程写进凭据存储，不进 settings） */
interface ModelDraft {
  /** 配置条目的显示名（用户自己起的名，如「deepseek-flash」） */
  readonly label: string
  /** 真正发给服务端的模型 id（如 `deepseek-chat`）。缺省回落到 label */
  readonly model?: string
  readonly base_url: string
  readonly api_key: string
  readonly protocol: ModelProtocol
  readonly billing_type?: BillingType
  readonly provider_preset: string
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
  const initialPreset = editing === undefined ? PROVIDER_PRESETS[0]! : presetForEditing(editing)
  const initialBilling = editing?.billing_type ??
    (editing === undefined ? undefined : inferBilling(initialPreset, editing.base_url)) ??
    initialPreset.defaultBilling ??
    initialPreset.billing[0]?.id ??
    ''
  const [provider, setProvider] = useState(initialPreset.id)
  const [billing, setBilling] = useState<BillingType | ''>(initialBilling)
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
  const isRecommended = preset.group === '推荐'
  /** 只有自定义和百炼需要地址覆盖：百炼新版业务空间会给出专属域名 */
  const canOverrideBase = !isRecommended || preset.id === 'bailian'
  /** 最终生效的接口地址：显式覆盖优先，否则用推荐供应商按计费类型给出的地址 */
  const effectiveBase = canOverrideBase && base.trim() !== '' ? base.trim() : (presetBaseUrl(preset, billing) ?? '')

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
   * 滑块范围：
   * - 供应商报了窗口 → 以它为上限（窗口就是权威）
   * - 供应商没报（自建网关常见）→ 上限延伸到 **1M**，让用户能往大调；
   *   默认值仍是 128K（宁大勿小的兜底，见 model-api 的 FALLBACK_CONTEXT_WINDOW）
   */
  const windowMax = providerMax ?? CONTEXT_WINDOW_PROBE_MAX
  const windowMin = Math.min(MIN_CONTEXT_WINDOW, windowMax)
  const windowValue = Math.min(windowMax, Math.max(windowMin, ctxWindow ?? FALLBACK_CONTEXT_WINDOW))
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
        protocol: preset.protocol,
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
    const nextPreset = PROVIDER_PRESETS.find((item) => item.id === next) ?? PROVIDER_PRESETS[0]!
    setProvider(next)
    setBilling(nextPreset.defaultBilling ?? nextPreset.billing[0]?.id ?? '')
    setBase('')
    setKey('')
    setName('')
    setModelId('')
    setCtxWindow(null)
    setProviderLimit(null)
    resetDiscovered()
  }

  /* 计费类型切换通常对应不同套餐的 Key：清掉已输入的 Key、地址覆盖和已发现模型 */
  const changeBilling = (next: BillingType): void => {
    setBilling(next)
    setBase('')
    setKey('')
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
    if (!isRecommended && !base.trim()) {
      toast(t('自定义供应商需要填写接口地址'))
      return null
    }
    if (effectiveBase === '') {
      toast(t('这个供应商缺少接口地址'))
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
      protocol: preset.protocol,
      provider_preset: preset.id,
      ...(isRecommended && billing !== '' ? { billing_type: billing } : {}),
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
    if (!isRecommended && !base.trim()) {
      toast(t('自定义供应商需要填写接口地址'))
      return
    }
    if (effectiveBase === '') {
      toast(t('这个供应商缺少接口地址'))
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
        protocol: preset.protocol,
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
              {t('供应商')}
              <em>{isRecommended ? t('（官方推荐）') : t('（自定义协议）')}</em>
            </span>
            {/* 编辑模式**不允许改供应商**：配置是按供应商 id 存的，改 id 等于新开一条，
                而用户想要的是'改这个模型的地址/密钥'。要换供应商就删了重加。 */}
            {isEdit ? (
              <div className="mmreadonly">
                <span className="mmfrom">{preset.label} · {preset.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 兼容</span>
              </div>
            ) : (
              <PopMenu
                block
                width={320}
                buttonClass="selectbtn"
                items={PROVIDER_PRESETS.map((item) => ({
                  id: item.id,
                  label: item.label,
                  group: item.group,
                  checked: item.id === provider,
                }))}
                onSelect={(id) => changeProvider(id)}
                trigger={(
                  <>
                    <span className="selval">{preset.label}</span>
                    <i className="chev">▾</i>
                  </>
                )}
              />
            )}
          </div>

          {/* 推荐供应商：多一个「类型」= 计费模式。地址随计费类型切换，用户不用手填 */}
          {isRecommended && (
            <div className="mmfield">
              <span className="mmlab">
                {t('类型')} <em>{t('（计费模式）')}</em>
              </span>
              {preset.billing.length > 1 ? (
                <PopMenu
                  block
                  width={260}
                  buttonClass="selectbtn"
                  items={preset.billing.map((item) => ({
                    id: item.id,
                    label: item.label,
                    checked: item.id === billing,
                  }))}
                  onSelect={(id) => changeBilling(id as BillingType)}
                  trigger={(
                    <>
                      <span className="selval">{preset.billing.find((item) => item.id === billing)?.label ?? preset.billing[0]?.label ?? ''}</span>
                      <i className="chev">▾</i>
                    </>
                  )}
                />
              ) : (
                <div className="mmreadonly">
                  <span className="mmfrom">{preset.billing[0]?.label ?? t('按量付费')}</span>
                </div>
              )}
            </div>
          )}

          {/* 接口地址：自定义必填；百炼可选覆盖（业务空间专属域名）；其余推荐供应商用固定地址 */}
          {canOverrideBase && (
            <label className="mmfield">
              <span className="mmlab">
                {t('接口地址')}
                <em>{!isRecommended ? t('（{protocol} 兼容协议）', { protocol: preset.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI' }) : t('（可选覆盖）')}</em>
              </span>
              <TextInput
                value={base}
                onChange={(value) => {
                  setBase(value)
                  resetDiscovered()
                }}
                placeholder={isRecommended
                  ? (presetBaseUrl(preset, billing) ?? 'https://api.example.com/v1')
                  : preset.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'}
              />
              {isRecommended ? (
                <span className="src" style={{ whiteSpace: 'normal' }}>
                  {t('留空使用推荐地址：{url}', { url: presetBaseUrl(preset, billing) ?? '—' })}
                  {t('。百炼也可以直接粘贴控制台 API Key 页面给出的业务空间专属 OpenAI 兼容地址。')}
                </span>
              ) : null}
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
              <em>{t('（接口文档里那个模型 id）')}</em>
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
                  ? t('供应商没报窗口上限，暂按 128K。自建网关常见：若知道模型真实窗口，拖动滑块调整（可到 1M）。')
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
    protocol?: ModelProtocol
    billing_type?: BillingType
    provider_preset?: string
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
  discover(input: { base_url: string; api_key: string; protocol?: ModelProtocol; credential_ref?: string }): Promise<DiscoverResult>
  /** 用未保存的 URL/Key 查单个模型的窗口上限（下拉选中/手填模型 id 后） */
  limitsUnsaved(input: { base_url: string; model: string; api_key: string; protocol?: ModelProtocol; credential_ref?: string }): Promise<{ context_window?: number; max_output_tokens?: number }>
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
  readonly protocol?: ModelProtocol | undefined
  readonly billing_type?: BillingType | undefined
  readonly provider_preset?: string | undefined
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
  /**
   * Router 专用模型（docs/26 §3.2）。`null` = 跟随默认模型。
   *
   * 单独读一栏而不是塞进 `uiPrefs`：它是**编排策略**而不是"当前默认模型"，
   * 两者生命周期不同（改默认模型影响所有新会话，改这个只影响 Router 会话）。
   */
  const [routerModel, setRouterModel] = useState<{ provider: string; model: string } | null>(null)
  const [routerSaving, setRouterSaving] = useState(false)
  const [routerNote, setRouterNote] = useState<string | null>(null)
  /**
   * 编排授权档位（docs/26 §7.4）：`off` / `observe` / `auto`。
   *
   * 与 `routerModel` 不同，**改完即刻生效、不需要重开应用**——档位是运行时状态，
   * 模型路由规则才是装配期构造的。默认 `observe`：只记录派发意向，不建 worker。
   */
  const [orchMode, setOrchMode] = useState<'off' | 'observe' | 'auto'>('observe')

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
      // 编排模型与模型清单一起刷新：它引用的是同一批供应商
      const orch = (globalThis as unknown as { lcode?: { orchestration?: { get(): Promise<unknown> } } }).lcode?.orchestration
      if (orch !== undefined) {
        const stored = (await orch.get()) as {
          routerModel?: { provider: string; model: string } | null
          defaultMode?: string
        } | null
        setRouterModel(stored?.routerModel ?? null)
        // 默认 auto：勾了 Router 就该真派发，见 docs/26 §7.4
        setOrchMode(stored?.defaultMode === 'observe' ? 'observe' : 'auto')
      }
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
      {/*
       * 编排模型（docs/26 §3.2）。
       *
       * 为什么要单独配：Router 只做"判断要不要派、派给谁、汇总结果"这类工作，
       * 用轻模型就够。把它和默认模型分开，既省钱又不牺牲 worker 的执行质量。
       *
       * 为什么现在就有意义：**`observe` 档下 Router 同样在调模型**，不是等切到
       * `auto` 才生效——这一点很多人的直觉是反的。
       */}
      <div className="sect">
        <div className="sh2">{t('编排模型')}</div>
        <div className="srow">
          <div className="sl">{t('Router 使用')}</div>
          <div className="sr">
            <Seg
              options={[t('跟随默认模型'), ...custom.map((m) => m.label)]}
              value={routerModel === null ? t('跟随默认模型') : (custom.find((m) => m.name === routerModel.provider)?.label ?? t('跟随默认模型'))}
              onChange={(v) => {
                const picked = custom.find((m) => m.label === v)
                setRouterSaving(true)
                setRouterNote(null)
                const orch = (globalThis as unknown as { lcode?: { orchestration?: { setRouterModel(input: unknown): Promise<unknown> } } }).lcode?.orchestration
                if (orch === undefined) {
                  setRouterSaving(false)
                  setRouterNote(t('当前环境没有主进程桥'))
                  return
                }
                const payload = picked === undefined ? null : { provider: picked.name, model: picked.model }
                void orch
                  .setRouterModel(payload)
                  .then(() => {
                    setRouterModel(payload)
                    setRouterNote(t('已保存。重开应用后生效。'))
                  })
                  .catch((err: unknown) => {
                    setRouterNote(err instanceof Error ? err.message : String(err))
                  })
                  .finally(() => setRouterSaving(false))
              }}
            />
            <span className="src">
              {t('Router 负责判断与派发，用轻模型就够；worker 仍走默认模型。')}
              {routerSaving ? ` ${t('保存中…')}` : ''}
              {routerNote !== null ? ` ${routerNote}` : ''}
            </span>
          </div>
        </div>
        {/*
         * 新建编排会话时的默认档位（docs/26 §7.4）。
         *
         * **不再是"全局开关"**：档位是按会话的。勾选 Router 就是人给出的
         * "这次需要拆"的显式信号，所以默认 `auto`——勾了却回一句"你还没切档"
         * 等于把同一个意图问两遍。想看它怎么拆而不真执行的人改这里。
         */}
        <div className="srow">
          <div className="sl">{t('新建编排会话时')}</div>
          <div className="sr">
            <Seg
              options={[t('自动执行'), t('只观察')]}
              value={orchMode === 'observe' ? t('只观察') : t('自动执行')}
              onChange={(v) => {
                const next = v === t('只观察') ? 'observe' : 'auto'
                const orch = (globalThis as unknown as { lcode?: { orchestration?: { setDefaultMode(input: unknown): Promise<unknown> } } }).lcode?.orchestration
                if (orch === undefined) return
                void orch
                  .setDefaultMode({ mode: next })
                  .then(() => setOrchMode(next))
                  .catch(() => undefined)
              }}
            />
            <span className="src">
              {orchMode === 'observe'
                ? t('只记录本来会派什么，不创建 worker——先看它怎么拆任务。')
                : t('真的派发 worker 并汇总，会消耗更多 token。')}
            </span>
          </div>
        </div>
      </div>
      <div className="sect">
        <div className="sh2">{t('自定义模型')}{' '}
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
          {t('配置一份 OpenAI / Anthropic 兼容的接口即可。配置存在本地 ')}
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
      <div className="mnote" style={{ marginTop: 20 }}>
        {t('代码语义索引（code_search）使用独立的 Embedding 模型；可以复用上面的模型服务商，也可以自定义接口地址、API Key 与模型名。')}
      </div>
      <CodeIndexSection />
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

/* ───────── 分区：MCP 服务 ───────── */

interface McpStatusView {
  readonly name: string
  readonly command: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly tools: number
  readonly error?: string
}

function toMcpStatuses(value: unknown): McpStatusView[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const list = Array.isArray(record['status']) ? record['status'] : undefined
  if (list === undefined) return undefined
  const statuses: McpStatusView[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry['name'] !== 'string') continue
    statuses.push({
      name: entry['name'],
      command: typeof entry['command'] === 'string' ? entry['command'] : '',
      enabled: entry['enabled'] !== false,
      connected: entry['connected'] === true,
      tools: typeof entry['tools'] === 'number' ? entry['tools'] : 0,
      ...(typeof entry['error'] === 'string' ? { error: entry['error'] } : {}),
    })
  }
  return statuses
}

function mcpServers(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const servers = record['servers']
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? servers as Record<string, unknown>
    : record
}

function McpSection() {
  const [statuses, setStatuses] = useState<readonly McpStatusView[]>([])
  const [path, setPath] = useState('')
  const [text, setText] = useState('{\n  "version": 1,\n  "servers": {}\n}')
  const [busy, setBusy] = useState<'save' | 'reload' | undefined>()
  const [parseError, setParseError] = useState<string | null>(null)

  const apply = (value: unknown): void => {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    if (typeof record['path'] === 'string') setPath(record['path'])
    const next = toMcpStatuses(value)
    if (next !== undefined) setStatuses(next)
    const servers = mcpServers(record['servers'])
    if (servers !== undefined) setText(JSON.stringify({ version: 1, servers }, null, 2))
  }

  useEffect(() => {
    void Promise.all([window.lcode.mcp.config(), window.lcode.mcp.status()])
      .then(([config, status]) => {
        apply(config)
        apply(status)
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('读取 MCP 配置失败')))
  }, [])

  const validate = (input: unknown): Record<string, unknown> | string => {
    const servers = mcpServers(input)
    if (servers === undefined) return t('顶层必须是包含 servers 的对象')
    for (const [name, value] of Object.entries(servers)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return t('服务「{name}」必须是对象', { name })
      const command = (value as Record<string, unknown>)['command']
      if (typeof command !== 'string' || command.trim() === '') return t('服务「{name}」缺少 command', { name })
    }
    return servers
  }

  const save = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      setParseError(error instanceof Error ? error.message : t('JSON 格式错误'))
      return
    }
    const servers = validate(parsed)
    if (typeof servers === 'string') {
      setParseError(servers)
      return
    }
    setParseError(null)
    setBusy('save')
    void window.lcode.mcp.save({ servers })
      .then((value) => {
        apply(value)
        toast(t('已保存并重新连接'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('保存 MCP 配置失败')))
      .finally(() => setBusy(undefined))
  }

  const reload = (): void => {
    setBusy('reload')
    void window.lcode.mcp.reload()
      .then((value) => {
        apply(value)
        toast(t('已重新连接'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('重连 MCP 服务失败')))
      .finally(() => setBusy(undefined))
  }

  return (
    <>
      <h2>{t('MCP 服务')}</h2>
      <div className="sub">{t('通过 stdio 连接本地 MCP 服务器，工具会以 mcp__服务器__工具 的名字提供给模型。')}</div>
      <div className="sect">
        <div className="sh2">
          {t('连接状态')}
          <span className="src" style={{ marginLeft: 'auto' }}>
            {statuses.length === 0 ? t('未配置') : t('{n} 个服务', { n: statuses.length })}
          </span>
        </div>
        {statuses.length === 0 ? (
          <div className="srow">
            <div className="sr"><span className="src">{t('还没有配置服务。在下方添加后保存即可连接。')}</span></div>
          </div>
        ) : statuses.map((status) => (
          <div className="srow" key={status.name}>
            <div className="sl mono" title={status.name}>{status.name}</div>
            <div className="sr">
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                <span
                  className="src"
                  style={{
                    flex: 'none',
                    color: !status.enabled ? 'var(--text-muted)' : status.connected ? 'var(--accent)' : 'var(--state-error)',
                  }}
                >
                  {!status.enabled ? t('已停用') : status.connected ? t('已连接') : t('连接失败')}
                </span>
                <span className="mono src" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.command}>
                  {status.command}
                </span>
              </div>
              <span className="src" style={status.error === undefined ? undefined : { color: 'var(--state-error)', whiteSpace: 'normal' }}>
                {status.error ?? (status.connected ? t('{n} 个工具', { n: status.tools }) : '')}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="sect" style={{ marginTop: 16 }}>
        <div className="sh2">
          {t('配置')}
          <span className="src mono" style={{ marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>
            {path}
          </span>
        </div>
        <div className="srow">
          <div className="sr">
            <div className="field" style={{ maxWidth: 'none' }}>
              <TextArea
                value={text}
                onChange={(value) => {
                  setText(value)
                  setParseError(null)
                }}
                rows={12}
                placeholder={'{\n  "version": 1,\n  "servers": {\n    "demo": { "command": "node", "args": ["server.mjs"] }\n  }\n}'}
              />
            </div>
            {parseError === null ? null : (
              <span className="src" style={{ color: 'var(--state-error)', whiteSpace: 'normal' }}>{parseError}</span>
            )}
            <span className="src">{t('每个服务支持 command、args、env 与 enabled；命令行逐项传入，不经过 shell。')}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy !== undefined} onClick={save}>{t('保存并重连')}</button>
              <button className="btn" disabled={busy !== undefined} onClick={reload}>{t('重新读取文件')}</button>
            </div>
          </div>
        </div>
      </div>
      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('安全')}</span>
        <span>{t('MCP 服务器是本机进程，不受工作区 OS 沙箱约束；只读预设下不会调用其工具。首次保存后会立即启动这些进程。')}</span>
      </div>
    </>
  )
}

/* ───────── 模型页内嵌：Embedding 模型与代码索引 ───────── */

interface CodeIndexWorkspaceView {
  readonly workspace: string
  readonly model: string
  readonly dim: number
  readonly files: number
  readonly chunks: number
  readonly updatedAt: number
}

interface CodeIndexStatusView {
  readonly configured: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly workspaces: readonly CodeIndexWorkspaceView[]
  readonly totalFiles: number
  readonly totalChunks: number
}

interface CodeIndexProviderView {
  readonly name: string
  readonly label: string
  readonly base_url: string
  readonly preset: string | null
}

interface CodeIndexConfigView {
  readonly provider: string | null
  readonly model: string | null
  readonly base_url: string | null
  readonly has_api_key: boolean
  readonly providers: readonly CodeIndexProviderView[]
}

function toCodeIndexStatus(value: unknown): CodeIndexStatusView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const list = Array.isArray(record['workspaces']) ? record['workspaces'] : []
  const workspaces: CodeIndexWorkspaceView[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row['workspace'] !== 'string' || typeof row['model'] !== 'string') continue
    workspaces.push({
      workspace: row['workspace'],
      model: row['model'],
      dim: typeof row['dim'] === 'number' ? row['dim'] : 0,
      files: typeof row['files'] === 'number' ? row['files'] : 0,
      chunks: typeof row['chunks'] === 'number' ? row['chunks'] : 0,
      updatedAt: typeof row['updatedAt'] === 'number' ? row['updatedAt'] : 0,
    })
  }
  return {
    configured: record['configured'] === true,
    provider: typeof record['provider'] === 'string' ? record['provider'] : null,
    model: typeof record['model'] === 'string' ? record['model'] : null,
    workspaces,
    totalFiles: typeof record['totalFiles'] === 'number' ? record['totalFiles'] : 0,
    totalChunks: typeof record['totalChunks'] === 'number' ? record['totalChunks'] : 0,
  }
}

function toCodeIndexConfig(value: unknown): CodeIndexConfigView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const providers: CodeIndexProviderView[] = []
  if (Array.isArray(record['providers'])) {
    for (const item of record['providers']) {
      // 兼容旧主进程只返回字符串的情况
      if (typeof item === 'string') {
        providers.push({ name: item, label: item, base_url: '', preset: null })
        continue
      }
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      if (typeof row['name'] !== 'string' || row['name'] === '') continue
      providers.push({
        name: row['name'],
        label: typeof row['label'] === 'string' && row['label'].trim() !== '' ? row['label'].trim() : row['name'],
        base_url: typeof row['base_url'] === 'string' ? row['base_url'] : '',
        preset: typeof row['preset'] === 'string' && row['preset'] !== '' ? row['preset'] : null,
      })
    }
  }
  return {
    provider: typeof record['provider'] === 'string' ? record['provider'] : null,
    model: typeof record['model'] === 'string' ? record['model'] : null,
    base_url: typeof record['base_url'] === 'string' ? record['base_url'] : null,
    has_api_key: record['has_api_key'] === true,
    providers,
  }
}

function codeIndexProviderHint(option: CodeIndexProviderView): string | undefined {
  const preset = PROVIDER_PRESETS.find((item) => item.id === option.preset)
  if (preset !== undefined) return preset.label
  return option.base_url === '' ? undefined : hostOf(option.base_url)
}

function CodeIndexSection() {
  const [status, setStatus] = useState<CodeIndexStatusView | null>(null)
  const [providers, setProviders] = useState<readonly CodeIndexProviderView[]>([])
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [customBase, setCustomBase] = useState('')
  const [customKey, setCustomKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'rebuild' | 'clear' | undefined>()
  const [clearing, setClearing] = useState(false)

  const refresh = (): void => {
    void Promise.all([window.lcode.codeIndex.status(), window.lcode.codeIndex.config()])
      .then(([statusValue, configValue]) => {
        const nextStatus = toCodeIndexStatus(statusValue)
        if (nextStatus !== undefined) setStatus(nextStatus)
        const nextConfig = toCodeIndexConfig(configValue)
        if (nextConfig !== undefined) {
          setProviders(nextConfig.providers)
          setProvider(nextConfig.provider ?? '')
          setModel(nextConfig.model ?? '')
          setCustomBase(nextConfig.base_url ?? '')
          setHasApiKey(nextConfig.has_api_key)
          setCustomKey('')
        }
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('读取代码索引状态失败')))
  }

  useEffect(refresh, [])

  const save = (): void => {
    if (model.trim() === '') {
      toast(t('请填写 embedding 模型名'))
      return
    }
    if (provider === 'custom' && customBase.trim() === '') {
      toast(t('自定义 Embedding 需要填写接口地址'))
      return
    }
    if (provider === '') {
      toast(t('请选择服务商或自定义 Embedding'))
      return
    }
    setBusy('save')
    void window.lcode.codeIndex.save(provider === 'custom'
      ? { provider: 'custom', model, base_url: customBase, api_key: customKey }
      : { provider, model })
      .then(() => {
        refresh()
        toast(t('已保存；之后重建索引会使用这个模型'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('保存代码索引配置失败')))
      .finally(() => setBusy(undefined))
  }

  const rebuild = (): void => {
    void window.lcode.chooseFolder(t('选择要建立索引的工作区')).then((path) => {
      if (path === null || path === '') return
      setBusy('rebuild')
      void window.lcode.codeIndex.rebuild({ workspace: path })
        .then((value) => {
          const report = value as {
            files?: number
            chunks?: number
            embeddedFiles?: number
            deletedFiles?: number
            truncated?: boolean
          }
          const skipped = Array.isArray((value as { skipped?: unknown }).skipped)
            ? ((value as { skipped: unknown[] }).skipped.length)
            : 0
          toast(t('索引完成：{files} 个文件 / {chunks} 个片段（本次嵌入 {embedded} 个文件）', {
            files: report.files ?? 0,
            chunks: report.chunks ?? 0,
            embedded: report.embeddedFiles ?? 0,
          }))
          if (report.truncated === true) toast(t('文件数超过索引上限，已只索引前 5000 个文件'))
          if (skipped > 0) toast(t('{n} 个文件被跳过（读取失败或二进制）', { n: skipped }))
          refresh()
        })
        .catch((error: unknown) => toast(error instanceof Error ? error.message : t('建立索引失败')))
        .finally(() => setBusy(undefined))
    })
  }

  const clear = (): void => {
    setBusy('clear')
    void window.lcode.codeIndex.clear()
      .then(() => {
        setClearing(false)
        refresh()
        toast(t('已清除全部代码索引'))
      })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : t('清除索引失败')))
      .finally(() => setBusy(undefined))
  }

  const selectedProvider = providers.find((item) => item.name === provider)
  const isCustomProvider = provider === 'custom'
  const selectedProviderLabel = isCustomProvider
    ? t('自定义 Embedding')
    : selectedProvider?.label ?? (provider === '' ? t('跟随默认模型服务商') : provider)
  const canRebuild = model.trim() !== '' && provider !== '' && (!isCustomProvider || customBase.trim() !== '')

  return (
    <>
      <div className="sect" style={{ marginTop: 12 }}>
        <div className="sh2">
          {t('索引状态')}
          <span className="src" style={{ marginLeft: 'auto' }}>
            {status === null
              ? t('读取中…')
              : t('{files} 个文件 · {chunks} 个片段', { files: status.totalFiles, chunks: status.totalChunks })}
          </span>
        </div>
        {status !== null && status.workspaces.length > 0 ? status.workspaces.map((row) => (
          <div className="srow" key={row.workspace}>
            <div className="sl mono" title={row.workspace} style={{ width: 220 }}>{row.workspace}</div>
            <div className="sr">
              <span className="src mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.model} · {row.dim} 维 · {row.files} 文件 / {row.chunks} 片段
              </span>
              <span className="src">
                {row.updatedAt > 0 ? t('更新于 {time}', { time: new Date(row.updatedAt).toLocaleString() }) : ''}
              </span>
            </div>
          </div>
        )) : (
          <div className="srow">
            <div className="sr">
              <span className="src">
                {status?.configured === true
                  ? t('还没有建立索引。点击下方「重建索引」选择工作区。')
                  : t('先配置 embedding 模型，再选择工作区建立索引。')}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="sect" style={{ marginTop: 16 }}>
        <div className="sh2">{t('Embedding 模型')}</div>
        <div className="srow">
          <div className="sl">{t('服务商')}</div>
          <div className="sr">
            <div className="field" style={{ maxWidth: 260 }}>
              <PopMenu
                block
                width={260}
                buttonClass="selectbtn"
                items={[
                  ...providers.map((item) => {
                    const hint = codeIndexProviderHint(item)
                    return {
                      id: item.name,
                      label: item.label,
                      ...(hint === undefined ? {} : { hint }),
                      checked: item.name === provider,
                      group: '模型服务商',
                      raw: true,
                    }
                  }),
                  {
                    id: 'custom',
                    label: t('自定义 Embedding'),
                    group: '自定义',
                    checked: isCustomProvider,
                    raw: true,
                  },
                ]}
                onSelect={(id) => {
                  setProvider(id)
                  setCustomKey('')
                }}
                trigger={(
                  <>
                    <span className="selval">{selectedProviderLabel}</span>
                    <i className="chev">▾</i>
                  </>
                )}
              />
            </div>
            <span className="src">
              {isCustomProvider
                ? t('自定义 Embedding 的接口地址与 API Key 单独保存，Key 存在本机凭据存储。')
                : providers.length > 0
                  ? t('复用该服务商在「模型」里保存的接口地址与 API Key。')
                  : t('还没有模型服务商；可以直接选择「自定义 Embedding」。')}
            </span>
          </div>
        </div>
        {isCustomProvider ? (
          <>
            <div className="srow">
              <div className="sl">{t('接口地址')}</div>
              <div className="sr">
                <div className="field" style={{ maxWidth: 420 }}>
                  <TextInput
                    value={customBase}
                    onChange={setCustomBase}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <span className="src">{t('OpenAI 兼容的 embeddings 接口 base URL，例如 https://api.openai.com/v1。')}</span>
              </div>
            </div>
            <div className="srow">
              <div className="sl">API Key</div>
              <div className="sr">
                <div className="field" style={{ maxWidth: 420 }}>
                  <TextInput
                    type="password"
                    value={customKey}
                    onChange={setCustomKey}
                    placeholder={hasApiKey ? t('已保存，留空则不修改') : t('输入 API Key（本地服务可留空）')}
                    autoComplete="off"
                  />
                </div>
                <span className="src">{t('只保存在本机凭据存储，不会写进 settings.json。')}</span>
              </div>
            </div>
          </>
        ) : null}
        <div className="srow">
          <div className="sl">{t('模型名')}</div>
          <div className="sr">
            <div className="field" style={{ maxWidth: 320 }}>
              <TextInput value={model} onChange={setModel} placeholder="text-embedding-v4" />
            </div>
            <span className="src">{t('填服务商支持的 embedding 模型名。修改模型后需要重新建立索引。')}</span>
          </div>
        </div>
        <div className="srow">
          <div className="sl" />
          <div className="sr">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy !== undefined} onClick={save}>{t('保存')}</button>
              <button className="btn" disabled={busy !== undefined || !canRebuild} onClick={rebuild}>
                {busy === 'rebuild' ? t('正在建立索引…') : t('重建索引…')}
              </button>
              {status !== null && status.workspaces.length > 0 ? (
                <button className="btn danger" disabled={busy !== undefined} onClick={() => setClearing(true)}>
                  {t('清除全部索引')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="warnrow" style={{ marginTop: 16 }}>
        <span className="wt">{t('数据外发')}</span>
        <span>{t('建立索引会把工作区代码片段发送给所选 embedding 服务；索引只存本机（~/.lcode/code-index.db），不会上传整库。code_search 只检索已建立索引的工作区。')}</span>
      </div>

      {clearing ? (
        <ConfirmDialog
          title={t('清除代码索引')}
          message={t('会删除本机全部工作区的语义索引（不会修改任何源码）。下次使用 code_search 前需要重新建立索引。')}
          confirmLabel={t('清除')}
          danger
          onCancel={() => setClearing(false)}
          onConfirm={clear}
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
  /*
   * 内置能力开关（docs/30 §P2）。
   *
   * 粒度是 **bundle**（不是单个工具）：composeRuntimeProfile 按 bundle 装配，
   * 一个 bundle 提供多个服务，拆到单个工具去关会破坏 requires 依赖。
   * 改动后需重启：services 是进程启动时装配的，运行中替换会留下半套状态。
   */
  const [bundleIds, setBundleIds] = useState<readonly string[]>([])
  const [disabledBundles, setDisabledBundles] = useState<readonly string[]>([])
  const [togglingBundle, setTogglingBundle] = useState<string | undefined>()
  useEffect(() => {
    void Promise.all([
      /*
       * IPC 返回 RuntimeComposition 的**可序列化部分**：`{ profile, entries }`
       * （dispose 函数过不了结构化序列化）。entries 直接在顶层，不在 snapshot 里。
       */
      window.lcode.runtime.composition() as Promise<{ entries?: readonly { id: string }[] }>,
      window.lcode.plugins.disabledList() as Promise<unknown>,
    ]).then(([composition, disabled]) => {
      setBundleIds((composition.entries ?? []).map((item) => item.id))
      setDisabledBundles(Array.isArray(disabled) ? disabled as string[] : [])
    }).catch(() => undefined)
  }, [])
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
  const toggleBundle = async (id: string): Promise<void> => {
    setTogglingBundle(id)
    const next = disabledBundles.includes(id)
      ? disabledBundles.filter((item) => item !== id)
      : [...disabledBundles, id]
    try {
      await window.lcode.plugins.disabledSet({ disabled: next })
      setDisabledBundles(next)
      toast(t('已保存，重启应用后生效'))
    } catch (error) {
      toast(error instanceof Error ? error.message : t('保存失败'))
    } finally {
      setTogglingBundle(undefined)
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
      <div className="sub">{t('系统与所有会话共用；内置能力可在此关闭，改动后重启生效。')}</div>

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
        {bundleIds.length > 0 && (
          <div className="bundle-toggles">
            <div className="picklab">{t('内置能力开关（改动后重启生效）')}</div>
            {bundleIds.map((id) => {
              const off = disabledBundles.includes(id)
              return (
                <label className="bundle-toggle" key={id}>
                  <input
                    type="checkbox"
                    checked={!off}
                    disabled={togglingBundle === id}
                    onChange={() => void toggleBundle(id)}
                  />
                  <span>{id}</span>
                  {off && <em className="bundle-off">{t('已禁用')}</em>}
                </label>
              )
            })}
          </div>
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

/* ───────── 分区：记忆 ───────── */

/*
 * 「记忆」说明的是**模型能看到什么**，而不是磁盘占用（后者归「归档与回收站」）。
 *
 * 两层记忆的归属不同，这一点必须在界面上讲清楚：
 * - 用户记忆：`~/.lcode/memory/USER.md`，跟着人走，换项目也在
 * - 项目记忆：工作区里的 `AGENTS.md` / `CLAUDE.md` / `.lcode/instructions.md`，跟着仓库走
 *
 * 展示的是**真正会注入的文本**（主进程已按 200 行 / 25KB 裁剪），
 * 而不是原文——否则用户以为自己写的生效了，其实被截断。
 */
function MemorySection() {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)
  const [userText, setUserText] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState<{ sessions: number; bytes: number } | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const memory = memoryBridge()
    const bridge = sessionBridge()
    if (memory !== undefined) {
      try {
        // 工作区取当前会话的？设置页没有会话上下文，这里读 HOME 级视角：
        // 项目记忆由各会话所属工作区决定，页面上展示最近使用的工作区即可
        const [snap, text] = await Promise.all([memory.read({}), memory.readUser()])
        setSnapshot(snap)
        setUserText(text)
      } catch {
        setSnapshot(null)
      }
    }
    if (bridge !== undefined) {
      try {
        const [all, usage] = await Promise.all([bridge.list({ includeDeleted: true, limit: 500 }), bridge.storageUsage?.()])
        setStats({
          sessions: all.items.filter((item) => item.deleted_at === null).length,
          bytes: usage?.sessions ?? 0,
        })
      } catch {
        setStats(null)
      }
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = (): void => {
    const memory = memoryBridge()
    if (memory === undefined) return
    setBusy(true)
    void memory
      .writeUser({ text: userText })
      .then(async () => {
        toast(t('用户记忆已保存，下次请求生效'))
        setEditing(false)
        await reload()
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('保存失败')))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <h2>{t('记忆')}</h2>
      <div className="sub">{t('模型在当前会话里能看到什么，以及你能怎么控制它。')}</div>

      <div className="sect">
        <div className="sh2">
          {t('用户记忆')}
          <span className="src" style={{ marginLeft: 'auto', fontSize: 11 }}>
            {snapshot?.user === null || snapshot?.user === undefined
              ? t('未设置')
              : t('{n} 字 · {lines} 行', { n: snapshot.user.chars, lines: snapshot.user.lines })}
          </span>
        </div>
        <div className="pickhint">
          {t('跟着你走，换项目也在：个人偏好、常用约定。保存在 ~/.lcode/memory/USER.md。')}
        </div>
        {editing ? (
          <>
            <div className="srow">
              <textarea
                className="memedit mono"
                value={userText}
                spellCheck={false}
                onChange={(event) => setUserText(event.target.value)}
                placeholder={t('例如：\n- 回答用中文，代码注释用英文\n- 提交信息用约定式提交')}
              />
            </div>
            <div className="srow">
              <div className="sr" style={{ flexDirection: 'row', gap: 8 }}>
                <button className="btn primary" disabled={busy} onClick={save}>
                  {busy ? t('保存中…') : t('保存')}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false)
                    // 取消编辑：丢弃改动，重新拉原文
                    void reload()
                  }}
                >
                  {t('取消')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/*
             * 非编辑态**直接显示内容**，而不是只给一个"83 字"。
             *
             * 这一页要回答的问题是"模型到底记住了我什么"，只显示字数等于没回答；
             * 而且要能一眼看出有没有记错、有没有重复条目。
             */}
            {snapshot?.user === null || snapshot?.user === undefined ? (
              <div className="srow">
                <div className="sl">{t('还没有用户记忆。')}</div>
                <button className="btn" onClick={() => setEditing(true)}>
                  {t('添加')}
                </button>
              </div>
            ) : (
              <>
                <div className="srow">
                  <pre className="memview mono">{userText.trim()}</pre>
                </div>
                <div className="srow">
                  <div className="sr">
                    <span className="src">{t('已注入系统提示词，下一次请求生效。')}</span>
                  </div>
                  <button className="btn" onClick={() => setEditing(true)}>
                    {t('编辑')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="sect">
        <div className="sh2">{t('项目记忆')}</div>
        <div className="pickhint">
          {t('跟着仓库走，团队共享：工作区里的 AGENTS.md、CLAUDE.md 或 .lcode/instructions.md，内容会随会话自动注入。')}
        </div>
        {snapshot === null || snapshot.project.length === 0 ? (
          <div className="srow">
            <div className="sl">{t('当前没有项目记忆文件。')}</div>
          </div>
        ) : (
          <div className="scroll-rows">
            {snapshot.project.map((file) => (
              <div className="srow" key={file.path}>
                <div className="sl">{file.name}</div>
                <div className="sr">
                  <span className="src">
                    {t('{n} 字 · {lines} 行', { n: file.chars, lines: file.lines })}
                    {file.truncated ? ` · ${t('已截断')}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sect">
        <div className="sh2">{t('记忆分层')}</div>
        <div className="trow">
          <span className="tp">{t('工作记忆')}</span>
          <span className="tm">
            {stats === null ? t('读取中…') : t('{n} 个活跃会话 · {size}', { n: stats.sessions, size: formatBytes(stats.bytes) })}
          </span>
        </div>
        <div className="pickhint">
          {t('每一轮的输入、工具调用与结果都按序写进事件日志；模型看到的内容由日志派生，不存在第二份副本。')}
        </div>
        <div className="trow">
          <span className="tp">{t('长程记忆')}</span>
          <span className="tm">{t('压缩摘要')}</span>
        </div>
        <div className="pickhint">
          {t('上下文接近窗口上限（90%）时自动压缩较早历史：先剪枝超长结果，再外置大结果，最后才用模型摘要重写。摘要也是事件，可撤销，原文永久保留。')}
        </div>
      </div>

      <div className="sect">
        <div className="sh2">{t('你能控制什么')}</div>
        <div className="trow">
          <span className="tp">{t('固定某一轮')}</span>
          <span className="tm">{t('压缩时不丢弃')}</span>
        </div>
        <div className="trow">
          <span className="tp">{t('屏蔽某一轮')}</span>
          <span className="tm">{t('移出模型上下文')}</span>
        </div>
        <div className="trow">
          <span className="tp">{t('回退检查点')}</span>
          <span className="tm">{t('连同工作区文件一起恢复')}</span>
        </div>
        <div className="pickhint">{t('这三个操作都在会话流里：把鼠标移到某一轮上即可看到按钮。')}</div>
      </div>
    </>
  )
}

function memoryBridge(): {
  read(input: { readonly workspace?: string | undefined }): Promise<MemorySnapshot>
  readUser(): Promise<string>
  writeUser(input: { readonly text: string }): Promise<unknown>
} | undefined {
  return (globalThis as unknown as {
    lcode?: {
      memory?: {
        read(input: unknown): Promise<MemorySnapshot>
        readUser(): Promise<string>
        writeUser(input: unknown): Promise<unknown>
      }
    }
  }).lcode?.memory as
    | {
        read(input: { readonly workspace?: string | undefined }): Promise<MemorySnapshot>
        readUser(): Promise<string>
        writeUser(input: { readonly text: string }): Promise<unknown>
      }
    | undefined
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
  /** 待删除的归档工作区（撤销信任 + 移出列表），先弹确认 */
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

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

  /*
   * 删除已归档工作区：
   * 1. **撤销信任**——「选择项目」只列已信任工作区，撤了才不会继续出现；
   * 2. 从归档列表移除；
   * 3. **软删该工作区下的活跃会话**——侧栏分组来自会话记录（与信任无关），
   *    不动会话的话分组会在删除后仍然显示（实测踩过）。会话进「已归档会话」，可恢复。
   * 需要确认：撤销信任是有安全含义的动作（下次打开该目录要走完整信任流程）。
   */
  const removeWorkspace = (key: string): void => {
    const bridge = window.lcode.workspaceTrust
    if (bridge === undefined) {
      toast(t('当前环境没有主进程桥，无法撤销信任'))
      return
    }
    setBusy(key)
    void (async () => {
      await bridge.set({ workspace: key, trusted: false })

      /*
       * **把该工作区下的活跃会话一并软删**——否则侧栏的分组还在
       * （侧栏分组来自会话记录，与信任无关），用户看到的是"删除了反而恢复"。
       * 软删的会话进「已归档会话」，可恢复，不丢数据。
       */
      const sb = sessionBridge()
      if (sb !== undefined) {
        const list = await sb.list({ limit: 500 })
        const targets = list.items.filter((item) => item.workspace === key)
        const results = await Promise.allSettled(targets.map((item) => sb.delete({ session_id: item.session_id })))
        const failed = results.filter((item) => item.status === "rejected").length
        if (failed > 0) toast(t("{n} 个会话归档失败", { n: failed }))
      }
      const current = (await window.lcode.getSidebar()) as {
        pinnedWorkspaces: string[]
        archivedWorkspaces: string[]
        pinnedSessions: string[]
        collapsedWorkspaces: string[]
      }
      await window.lcode.setSidebar({
        ...current,
        archivedWorkspaces: current.archivedWorkspaces.filter((item) => item !== key),
        pinnedWorkspaces: current.pinnedWorkspaces.filter((item) => item !== key),
      })
      window.dispatchEvent(new Event('lcode:sidebar-changed'))
      toast(t('已删除：撤销信任并从列表移除'))
      await load()
    })()
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('删除失败')))
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
          /* 超过 5 条即内部滚动（固定行高 44px × 5），避免长列表把整页撑得很长 */
          <div className="scroll-rows">
            {workspaces.map((item) => (
              <div className="srow" key={item.key}>
                <div className="sl">{item.name}</div>
                <div className="sr">
                  <span className="src">{item.key}</span>
                </div>
                <button className="btn" disabled={busy !== null} onClick={() => restoreWorkspace(item.key)}>
                  {t('恢复')}
                </button>
                {/* 删除 = 撤销信任 + 移出归档列表；「选择项目」只列已信任工作区，删后自然消失 */}
                <button className="btn danger" disabled={busy !== null} onClick={() => setRemoveTarget(item.key)}>
                  {t('删除')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {removeTarget !== null && (
        <ConfirmDialog
          title={t('删除已归档工作区')}
          message={t('会撤销「{path}」的信任、从归档列表移除，并把该工作区下的活跃会话一并归档（可在「已归档会话」恢复）。删除后再次打开需要重新信任。', { path: removeTarget })}
          confirmLabel={t('删除')}
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            const target = removeTarget
            setRemoveTarget(null)
            removeWorkspace(target)
          }}
        />
      )}
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
          <div className="scroll-rows">
            {sessions.map((item) => (
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
            ))}
          </div>
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
          <div className="scroll-rows">
            {trash.map((item) => (
              <div className="srow" key={item.path}>
                <div className="trash-label" title={item.label || t('未命名会话')}>
                  {item.label || t('未命名会话')}
                </div>
              </div>
            ))}
          </div>
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
  { id: 'mcp', label: 'MCP 服务' },
  { g: '权限' },
  { id: 'perm', label: '权限预设' },
  { id: 'trust', label: '工作区信任' },
  { id: 'network', label: '网络访问' },
  { g: '记忆与历史' },
  { id: 'memory', label: '记忆' },
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
    case 'mcp':
      return <McpSection />
    case 'perm':
      return <PermSection />
    case 'trust':
      return <TrustSection />
    case 'network':
      return <NetworkAccessSection />
    case 'memory':
      return <MemorySection />
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
