import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { QueuedMessage } from '../store/sessionBridge.ts'
import { TextArea } from './controls.tsx'
import { PopMenu } from './PopMenu.tsx'
import type { PopMenuItem } from './PopMenu.tsx'
import { SkillPicker } from './SkillPicker.tsx'
import { toast } from './toast.ts'
import { t } from '../i18n/index.ts'
import { chooseDefaultModel, modelSupportsImages, resolveModelVision } from '../store/modelSync.ts'
import { choosePermissionPreset } from '../store/permissionSync.ts'
import { PERMISSION_PRESETS, PERMISSION_PRESET_HINT, useUiPrefs } from '../store/uiPrefs.ts'
import type { PermissionPreset } from '../store/uiPrefs.ts'
import { matchSlashCommands, parseSlashInput } from './slashCommands.ts'

/**
 * 输入区（公共组件）：首页与工作台共用同一份实现。
 *
 * 结构：附件行（有附件时）→ textarea → 工具条（＋ / 权限 / 模型 / 发送）。
 * 外层 `.cin` 容器由调用方提供（首页要在它内部放「选择项目」行）。
 * 位置纪律（文档 `UX-INPUT-002` / `M-UX-15`）：composer 只属于中间会话栏，
 * 由调用方放在自己的栏内，本组件不负责定位。
 *
 * 三个工具按钮都**已接线**：
 * - ＋   添加附件（`FR-SESSION-004`）：走系统文件/文件夹选择框，选中后以 chip 呈现、可移除
 * - 权限 权限预设（文档 12 §3.3 的五个产品字面量）
 * - 模型 默认模型（`ctx.agentDefaultModel` 的 UI 侧；当前由 `store/uiPrefs` 承载）
 */

export interface Attachment {
  readonly path: string
  readonly kind: 'file' | 'folder'
}

export interface ImageAttachment {
  /** 例如 image/jpeg；data 是 base64，不含 data URL 前缀 */
  readonly mediaType: string
  readonly data: string
}

export interface SkillEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: 'builtin' | 'user' | 'workspace'
}

export interface ComposerSendInput {
  readonly attachments: readonly Attachment[]
  readonly skills: readonly string[]
  readonly images: readonly ImageAttachment[]
}

interface SlashItem {
  readonly key: string
  readonly kind: 'command' | 'model' | 'manage'
  readonly label: string
  readonly hint: string
  readonly description: string
  readonly name?: string
  readonly args?: string
  readonly provider?: string
}

function buildSlashItems(
  slash: { readonly name: string; readonly args: string } | null,
  models: readonly { readonly name: string; readonly src: string; readonly model: string }[],
): SlashItem[] {
  if (slash === null) return []
  if (slash.name === 'model') {
    const query = slash.args.trim().toLowerCase()
    const matched = models.filter((entry) =>
      query === '' || [entry.name, entry.src, entry.model].some((value) => value.toLowerCase().includes(query)),
    )
    if (matched.length === 0) {
      return [{
        key: 'model-manage',
        kind: 'manage',
        label: t('管理模型'),
        hint: query === '' ? t('还没有配置模型') : t('没有匹配的模型'),
        description: t('打开设置 → 模型'),
      }]
    }
    return matched.map((entry) => ({
      key: `model-${entry.name}`,
      kind: 'model' as const,
      label: `/model ${entry.src}`,
      hint: entry.model,
      description: t('切换默认模型（只影响下一轮）'),
      provider: entry.name,
    }))
  }
  return matchSlashCommands(slash.name, slash.args).map((command) => ({
    key: `command-${command.name}`,
    kind: 'command' as const,
    label: `/${command.name}`,
    hint: command.args,
    description: t(command.description),
    name: command.name,
    args: slash.args,
  }))
}

const MAX_IMAGES = 4
const MAX_IMAGE_EDGE = 1_600

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/** 把剪贴板图片压到最长边 1600px 的 JPEG，避免把原始截图整段塞进日志。 */
async function prepareImage(file: File): Promise<ImageAttachment | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) {
      bitmap.close()
      return null
    }
    // JPEG 没有透明通道；透明截图垫白底，避免变成黑底
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    if (blob === null) return null
    return { mediaType: 'image/jpeg', data: toBase64(new Uint8Array(await blob.arrayBuffer())) }
  } catch {
    return null
  }
}

/** 与 context-budget 同口径的粗略估算：CJK 约 1 token/字，其余约 3.5 字符/token */
function estimateText(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 3.5)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function ComposerBar({
  value,
  onChange,
  onSend,
  onCancel,
  primaryAction = 'send',
  onPrimaryAction,
  placeholder,
  sendTitle = '发送',
  hint,
  leading,
  footer,
  planActive = false,
  planReady = false,
  onPlanAction,
  queued = [],
  onGuideQueued,
  onEditQueued,
  onRemoveQueued,
  onClearQueued,
  usedTokens = 0,
  contextWindowTokens = null,
  onCompact,
  initialImages,
  initialSkills,
  initialAttachments,
  enableSlash = true,
  onSlashCommand,
}: {
  value: string
  onChange: (next: string) => void
  onSend: (input: ComposerSendInput) => void
  /** 提供时在发送键左侧渲染一个取消键（原位编辑用） */
  onCancel?: (() => void) | undefined
  primaryAction?: 'send' | 'pause' | 'resume'
  onPrimaryAction?: (() => void) | undefined
  placeholder?: string
  sendTitle?: string
  /** textarea 上方的提示行（可选） */
  hint?: string
  /** textarea 之前的插槽（首页用它放「选择项目」行） */
  leading?: ReactNode
  /** 工具条下方的状态行（工作台用它放工作区/分支与上下文用量） */
  footer?: ReactNode
  /** 会话级计划模式；激活时该按钮表示“确认并开始执行”。 */
  planActive?: boolean
  /** 是否已有可确认的结构化计划。 */
  planReady?: boolean
  onPlanAction?: (() => void) | undefined
  /** 当前任务完成后才发送的运行时消息队列。 */
  queued?: readonly QueuedMessage[]
  onGuideQueued?: ((queueId: string) => void) | undefined
  onEditQueued?: ((queueId: string, text: string) => void) | undefined
  onRemoveQueued?: ((queueId: string) => void) | undefined
  onClearQueued?: (() => void) | undefined
  /** 当前上下文已用量；与草稿估算一起做发送前预警 */
  usedTokens?: number
  contextWindowTokens?: number | null
  /** 打开压缩预览（预警条上的按钮） */
  onCompact?: (() => void) | undefined
  /** 原位编辑：把原消息里的文件/图片/技能带进输入区，而不是静默丢掉 */
  initialImages?: readonly ImageAttachment[] | undefined
  initialSkills?: readonly string[] | undefined
  initialAttachments?: readonly Attachment[] | undefined
  /** 原位编辑等场景关闭斜杠命令 */
  enableSlash?: boolean
  /** 宿主处理会话相关命令（compact/context/export/retry）；返回 true 表示已处理 */
  onSlashCommand?: ((name: string, args: string) => boolean) | undefined
}) {
  const prefs = useUiPrefs()
  const navigate = useNavigate()
  const [attachments, setAttachments] = useState<readonly Attachment[]>(initialAttachments ?? [])
  const [images, setImages] = useState<readonly ImageAttachment[]>(initialImages ?? [])
  const [dropActive, setDropActive] = useState(false)
  /** dragenter/dragleave 会为每个子元素各来一次，用深度计数避免图标闪烁 */
  const dragDepth = useRef(0)
  const [skills, setSkills] = useState<readonly SkillEntry[]>([])
  const [selectedSkills, setSelectedSkills] = useState<readonly string[]>(initialSkills ?? [])
  const [skillsMenuSignal, setSkillsMenuSignal] = useState(0)
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = useState('')
  const [visionSupport, setVisionSupport] = useState<boolean | undefined>(undefined)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)

  const currentModelId = prefs.defaultModel !== ''
    ? prefs.defaultModel
    : (prefs.models.find((model) => model.name === prefs.defaultProvider)?.model ?? '')
  const supportsImages = visionSupport ?? modelSupportsImages(currentModelId)

  /* 供应商元数据是能力的权威来源；拿不到才回落到模型名判断 */
  useEffect(() => {
    let alive = true
    setVisionSupport(undefined)
    if (prefs.defaultProvider === '' || currentModelId === '') return
    void resolveModelVision(prefs.defaultProvider, currentModelId).then((vision) => {
      if (alive) setVisionSupport(vision)
    })
    return () => {
      alive = false
    }
  }, [prefs.defaultProvider, currentModelId])

  /* 技能目录是本地只读文件，打开菜单时重新拉取，用户新放的 SKILL.md 不用重启 */
  const refreshSkills = (): void => {
    const api = typeof window !== 'undefined' ? window.lcode : undefined
    if (api === undefined || typeof api.skills?.list !== 'function') {
      setSkills([])
      return
    }
    void api.skills
      .list()
      .then((list) => {
        if (!Array.isArray(list)) {
          setSkills([])
          return
        }
        setSkills(
          list.filter((entry): entry is SkillEntry =>
            typeof entry === 'object' && entry !== null &&
            typeof (entry as SkillEntry).id === 'string' &&
            typeof (entry as SkillEntry).name === 'string',
          ),
        )
      })
      .catch(() => setSkills([]))
  }

  useEffect(() => {
    refreshSkills()
  }, [])

  const addAttachment = (path: string | null, kind: Attachment['kind']): void => {
    if (!path) return
    setAttachments((prev) => (prev.some((a) => a.path === path) ? prev : [...prev, { path, kind }]))
    const name = baseName(path)
    toast(
      kind === 'folder'
        ? t('已附加文件夹：{name}', { name })
        : t('已附加文件：{name}', { name }),
    )
  }

  const pickFile = async (kind: Attachment['kind']): Promise<void> => {
    // 两种情况都要优雅降级，不能让按钮把页面打崩：
    // ① 浏览器直开（vite dev 无 preload）→ window.lcode 不存在；
    // ② Electron 主进程未重启 → 新增的 dialog:choose-file 通道还没注册。
    const bridge = typeof window !== 'undefined' ? window.lcode : undefined
    if (!bridge) {
      toast(t('当前不在桌面应用内，无法打开系统选择框'))
      return
    }
    const pick =
      kind === 'folder'
        ? () => bridge.chooseFolder(t('选择项目文件夹'))
        : () => bridge.chooseFile(t('选择要附加的文件'))
    if (typeof pick !== 'function') {
      toast(t('这个功能需要重启应用后生效'))
      return
    }
    addAttachment(await pick(), kind)
  }

  const hasDroppedFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes('Files')

  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasDroppedFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current += 1
    setDropActive(true)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasDroppedFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasDroppedFiles(event)) return
    event.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    if (!hasDroppedFiles(event)) return
    // 必须拦住：首页把「拖入文件夹」当作选择项目，不能让同一次拖放既换项目又加附件
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setDropActive(false)
    const bridge = typeof window !== 'undefined' ? window.lcode : undefined
    const files = Array.from(event.dataTransfer.files ?? [])
    if (bridge === undefined) {
      toast(t('当前不在桌面应用内，无法读取拖入的文件'))
      return
    }
    const dropped: Attachment[] = []
    for (const file of files) {
      let path = ''
      try {
        path = bridge.pathForFile(file)
      } catch {
        path = ''
      }
      if (path === '') continue
      let kind: Attachment['kind'] = 'file'
      if (typeof bridge.pathKind === 'function') {
        try {
          if ((await bridge.pathKind(path)).kind === 'folder') kind = 'folder'
        } catch {
          // 类型探测失败就按文件处理；主进程发送时还会 stat 一次
        }
      }
      dropped.push({ path, kind })
    }
    if (dropped.length === 0) {
      toast(t('未能识别拖入内容的路径，请改用「＋」选择'))
      return
    }
    setAttachments((prev) => {
      const next = [...prev]
      for (const item of dropped) {
        if (!next.some((existing) => existing.path === item.path)) next.push(item)
      }
      return next
    })
    if (dropped.length === 1 && dropped[0] !== undefined) {
      const item = dropped[0]
      toast(
        item.kind === 'folder'
          ? t('已附加文件夹：{name}', { name: baseName(item.path) })
          : t('已附加文件：{name}', { name: baseName(item.path) }),
      )
    } else {
      toast(t('已添加 {n} 个附件', { n: dropped.length }))
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    if (!supportsImages) {
      toast(
        currentModelId === ''
          ? t('请先选择一个支持图片理解的模型')
          : t('当前模型不支持图片理解，请切换到支持图片的模型'),
      )
      return
    }
    void (async () => {
      const accepted: ImageAttachment[] = []
      for (const file of files) {
        const image = await prepareImage(file)
        if (image !== null) accepted.push(image)
      }
      if (accepted.length === 0) {
        toast(t('无法读取这张图片'))
        return
      }
      setImages((prev) => {
        const room = Math.max(0, MAX_IMAGES - prev.length)
        if (accepted.length > room) toast(t('最多附加 {n} 张图片', { n: MAX_IMAGES }))
        return room === 0 ? prev : [...prev, ...accepted.slice(0, room)]
      })
    })()
  }

  const dispatchSend = (): void => {
    onSend({ attachments, skills: selectedSkills, images })
    setSelectedSkills([])
    setImages([])
    setAttachments([])
  }

  const slash = enableSlash ? parseSlashInput(value) : null
  const slashItems = buildSlashItems(slash, prefs.models)
  const slashOpen = slash !== null && !slashDismissed && slashItems.length > 0
  const activeSlashIndex = slashOpen ? Math.min(slashIndex, slashItems.length - 1) : -1
  const selectedSlash = activeSlashIndex >= 0 ? slashItems[activeSlashIndex] : undefined

  const changeValue = (next: string): void => {
    setSlashDismissed(false)
    setSlashIndex(0)
    onChange(next)
  }

  const clearSlash = (): void => {
    setSlashDismissed(false)
    setSlashIndex(0)
    onChange('')
  }

  const runSlash = (name: string, args: string): void => {
    if (name === 'help') {
      changeValue('/')
      return
    }
    if (name === 'model') {
      const query = args.trim()
      if (query === '') {
        changeValue('/model')
        return
      }
      const wanted = query.toLowerCase()
      const matched = prefs.models.find((entry) =>
        [entry.name, entry.src, entry.model].some((value) => value.toLowerCase() === wanted),
      ) ?? prefs.models.find((entry) =>
        [entry.name, entry.src, entry.model].some((value) => value.toLowerCase().includes(wanted)),
      )
      if (matched === undefined) {
        toast(t('没有匹配的模型：{name}', { name: query }))
        return
      }
      void chooseDefaultModel(matched.name)
        .then(() => toast(t('已切换模型：{name}', { name: matched.src })))
        .catch(() => toast(t('模型切换失败')))
      clearSlash()
      return
    }
    if (name === 'new') {
      setAttachments([])
      setImages([])
      setSelectedSkills([])
      clearSlash()
      navigate('/')
      return
    }
    if (name === 'skills') {
      setSkillsMenuSignal((value) => value + 1)
      clearSlash()
      return
    }
    if (name === 'settings') {
      clearSlash()
      navigate('/settings')
      return
    }
    if (name === 'plan') {
      if (onPlanAction === undefined) {
        toast(t('当前页面不能切换计划模式'))
        return
      }
      onPlanAction()
      clearSlash()
      return
    }
    if (name === 'compact' || name === 'context' || name === 'export' || name === 'retry') {
      if (onSlashCommand?.(name, args) === true) {
        clearSlash()
        return
      }
      toast(t('这个命令只能在打开会话后使用'))
      return
    }
    toast(t('未知命令：/{name}', { name }))
  }

  const pickSlash = (item: SlashItem): void => {
    if (item.kind === 'model' && item.provider !== undefined) {
      void chooseDefaultModel(item.provider)
        .then(() => toast(t('已切换模型：{name}', { name: item.label.replace('/model ', '') })))
        .catch(() => toast(t('模型切换失败')))
      clearSlash()
      return
    }
    if (item.kind === 'manage') {
      clearSlash()
      navigate('/settings', { state: { sec: 'providers' } })
      return
    }
    if (item.kind === 'command' && item.name !== undefined) runSlash(item.name, item.args ?? '')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((index) => (index + (e.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (selectedSlash?.kind === 'command' && selectedSlash.name !== undefined) {
          changeValue(`/${selectedSlash.name} `)
        } else {
          changeValue('/model ')
        }
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (selectedSlash !== undefined) pickSlash(selectedSlash)
        return
      }
    }
    // 与 Codex 一致：Enter 提交，Shift+Enter 明确保留换行；输入法候选确认不能误发。
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (value.trim() !== '' || images.length > 0 || attachments.length > 0) dispatchSend()
  }

  const textOfQueued = (item: QueuedMessage): string =>
    item.content
      .filter((block): block is Extract<QueuedMessage['content'][number], { readonly type: 'text'; readonly text: string }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

  const startEdit = (item: QueuedMessage): void => {
    setEditingQueueId(item.queue_id)
    setEditingQueueText(textOfQueued(item))
  }

  const saveEdit = (): void => {
    if (editingQueueId === null || editingQueueText.trim() === '') return
    onEditQueued?.(editingQueueId, editingQueueText.trim())
    setEditingQueueId(null)
    setEditingQueueText('')
  }

  const planItem: PopMenuItem | null = onPlanAction === undefined
    ? null
    : {
        id: 'plan',
        label: planActive
          ? (planReady ? '确认计划并开始执行' : '计划模式（等待计划）')
          : '计划模式',
        hint: planActive
          ? (planReady ? '计划已提交，确认后开始改动' : '助手正在只读探索并整理计划')
          : '只读探索，先给出计划再执行',
        checked: planActive,
        disabled: planActive && !planReady,
        separator: true,
      }
  const addItems: readonly PopMenuItem[] = [
    { id: 'file', label: '添加文件…', hint: '内容随消息发送，超长时用工具续读' },
    { id: 'folder', label: '添加文件夹…', hint: '发送目录结构，具体文件按需读取' },
    ...(planItem === null ? [] : [planItem]),
    {
      id: 'skills',
      label: '技能',
      hint: selectedSkills.length > 0
        ? `已选 ${selectedSkills.length} 个 · ${skills.length} 个可用`
        : `${skills.length} 个可用`,
      checked: selectedSkills.length > 0,
      separator: planItem === null,
    },
  ]

  const permItems: readonly PopMenuItem[] = PERMISSION_PRESETS.map((p) => ({
    id: p,
    label: p,
    hint: PERMISSION_PRESET_HINT[p],
    checked: prefs.permissionPreset === p,
  }))

  const modelItems: readonly PopMenuItem[] = [
    ...prefs.models.map((m) => ({
      id: m.name,
      // 显示名（label），不是内部 id——用户认的是"我给它起的名字"
      label: m.src,
      hint: m.model,
      checked: prefs.defaultProvider === m.name,
    })),
    {
      id: 'manage',
      label: prefs.models.length === 0 ? '添加模型' : '管理模型',
      separator: true,
      compact: true,
      // 与左侧栏底部的设置入口同一个字形，保持全局一致
      icon: '⚙',
    },
  ]

  /** 当前选中项的显示名；没选或找不到就显示引导文案 */
  const currentModelLabel =
    prefs.models.find((m) => m.name === prefs.defaultProvider)?.src ?? ''
  const cannotSend = primaryAction === 'send' && value.trim() === '' && images.length === 0 && attachments.length === 0
  // 发送前非破坏性预警：只提示，不阻止发送。图片按固定预算计，技能正文由主进程展开
  const draftTokens = estimateText(value) + images.length * 1_200
  const projectedTokens = usedTokens + draftTokens
  const projectedPercent = contextWindowTokens === null || contextWindowTokens <= 0
    ? null
    : Math.round((projectedTokens / contextWindowTokens) * 1000) / 10
  const overflows = projectedPercent !== null && projectedPercent > 100
  const nearLimit = projectedPercent !== null && projectedPercent >= 90 && !overflows

  return (
    <div
      className={'composer-drop' + (dropActive ? ' dragging' : '')}
      data-drop-label={t('松开以添加文件或文件夹')}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        void onDrop(event)
      }}
    >
      {leading}
      {(overflows || nearLimit) && (value.trim() !== '' || images.length > 0) ? (
        <div className={'cmoverflow' + (overflows ? ' over' : '')} role="status">
          <span>
            {overflows
              ? t('这条消息会让上下文超出窗口（预计 {pct}%）。发送可能失败，建议先压缩或新建会话。', { pct: projectedPercent ?? 0 })
              : t('这条消息会让上下文接近窗口上限（预计 {pct}%）。', { pct: projectedPercent ?? 0 })}
          </span>
          {onCompact === undefined ? null : (
            <button type="button" className="btn mini" onClick={onCompact}>{t('压缩上下文')}</button>
          )}
        </div>
      ) : null}
      {queued.length > 0 ? (
        <div className="queued-list" aria-label={t('待发送消息')}>
          {queued.map((item) => {
            const editing = editingQueueId === item.queue_id
            return (
              <div className="queued-message" key={item.queue_id}>
                <span className="queued-mark" aria-hidden="true">↳</span>
                <div className="queued-content">
                  {editing ? (
                    <textarea
                      className="queued-editor"
                      value={editingQueueText}
                      onChange={(event) => setEditingQueueText(event.target.value)}
                      autoFocus
                    />
                  ) : (
                    <span className="queued-text">{textOfQueued(item)}</span>
                  )}
                </div>
                <div className="queued-actions">
                  {editing ? (
                    <>
                      <button className="queued-action" title={t('保存修改')} onClick={saveEdit}>✓</button>
                      <button className="queued-action" title={t('取消编辑')} onClick={() => setEditingQueueId(null)}>✕</button>
                    </>
                  ) : (
                    <>
                      <button className="queued-guide" title={t('不打断当前任务，在下一步调整方向')} onClick={() => onGuideQueued?.(item.queue_id)}>
                        {t('引导')}
                      </button>
                      <button className="queued-action" title={t('移除待发送消息')} onClick={() => onRemoveQueued?.(item.queue_id)}>⌫</button>
                      <PopMenu
                        trigger="…"
                        buttonClass="queued-action"
                        title="更多操作"
                        up
                        items={[
                          { id: 'edit', label: '编辑消息' },
                          { id: 'clear', label: '关闭队列' },
                        ]}
                        onSelect={(action) => {
                          if (action === 'edit') startEdit(item)
                          else onClearQueued?.()
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {selectedSkills.length > 0 || attachments.length > 0 || images.length > 0 ? (
        <div className="attchips">
          {selectedSkills.map((id) => (
            <span className="attchip skillchip" key={id}>
              ⚡ {skills.find((skill) => skill.id === id)?.name ?? id}
              <button
                className="attx"
                title={t('移除')}
                onClick={() => setSelectedSkills((prev) => prev.filter((skillId) => skillId !== id))}
              >
                ✕
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <span className="attchip" key={a.path} title={a.path}>
              {a.kind === 'folder' ? '📁' : '📄'} {baseName(a.path)}
              <button
                className="attx"
                title={t('移除')}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
              >
                ✕
              </button>
            </span>
          ))}
          {images.map((image, index) => (
            <span className="attimage" key={`${index}-${image.data.length}`}>
              <img src={`data:${image.mediaType};base64,${image.data}`} alt={t('粘贴的图片')} />
              <button
                className="attx"
                title={t('移除')}
                onClick={() => setImages((prev) => prev.filter((_item, itemIndex) => itemIndex !== index))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-editor">
        {slashOpen ? (
          <div className="slash-palette" role="listbox" aria-label={t('斜杠命令')}>
            <div className="slash-head">{t('斜杠命令')}</div>
            {slashItems.map((item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === activeSlashIndex}
                key={item.key}
                className={'slash-item' + (index === activeSlashIndex ? ' on' : '')}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSlashIndex(index)}
                onClick={() => pickSlash(item)}
              >
                <span className="slash-name">{item.label}</span>
                {item.hint === '' ? null : <span className="slash-hint">{item.hint}</span>}
                <span className="slash-desc">{item.description}</span>
              </button>
            ))}
            <div className="slash-foot">{t('↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭')}</div>
          </div>
        ) : null}
        <TextArea variant="bare" placeholder={placeholder} value={value} onChange={changeValue} onKeyDown={onKeyDown} onPaste={onPaste} />
      </div>
      <div className="cinbar">
        <PopMenu
          trigger="＋"
          title="添加附件、计划或技能"
          up
          dense
          width={210}
          items={addItems}
          openSignal={skillsMenuSignal}
          flyout={{
            itemId: 'skills',
            width: 230,
            render: (close) => (
              <SkillPicker
                skills={skills}
                selected={selectedSkills}
                onToggle={(id) => {
                  setSelectedSkills((prev) => (prev.includes(id) ? prev.filter((skillId) => skillId !== id) : [...prev, id]))
                }}
                onManage={() => {
                  close()
                  navigate('/settings', { state: { sec: 'skills' } })
                }}
                onRefresh={refreshSkills}
              />
            ),
          }}
          onOpen={refreshSkills}
          onSelect={(id) => {
            if (id === 'plan') {
              onPlanAction?.()
              return
            }
            if (id === 'skills') return 'keep-open'
            void pickFile(id === 'folder' ? 'folder' : 'file')
          }}
        />
        <PopMenu
          trigger={`${t('权限')}：${t(prefs.permissionPreset)} ▾`}
          title="权限预设"
          up
          header="它什么时候需要问你"
          items={permItems}
          onSelect={(id) => {
            void choosePermissionPreset(id as PermissionPreset).catch(() => toast(t('权限预设保存失败')))
          }}
        />
        <PopMenu
          // 没有模型时**不能显示空触发器**（一个光秃秃的 " ▾" 让人不知道那是什么）。
          // 这种情形只出现在"一个模型都没配"——此时该引导去配置，而不是给个空菜单。
          trigger={`${currentModelLabel === '' ? t('选择模型') : currentModelLabel} ▾`}
          title="模型"
          up
          header="这次对话用哪个模型"
          items={modelItems}
          onSelect={(id) => {
            if (id === 'manage') {
              navigate('/settings', { state: { sec: 'providers' } })
              return
            }
            // **必须走 chooseDefaultModel**：它会把选择回写主进程
            // （`ctx.agentDefaultModel` 是权威）。以前这里只改渲染层镜像，
            // 于是"界面上选好了、引擎那边还是空的"，发消息必报「还没有选择模型」。
            void chooseDefaultModel(id).catch(() => undefined)
            toast(t('已切换模型：{name}', { name: prefs.models.find((m) => m.name === id)?.src ?? id }))
          }}
        />
        {onCancel !== undefined ? (
          <button type="button" className="sendcancel" title={t('取消')} aria-label={t('取消')} onClick={onCancel}>
            {t('取消')}
          </button>
        ) : null}
        <button
          className={'send' + (primaryAction === 'pause' ? ' stop' : '')}
          title={t(primaryAction === 'pause' ? '暂停' : primaryAction === 'resume' ? '继续' : sendTitle)}
          aria-label={t(primaryAction === 'pause' ? '暂停' : primaryAction === 'resume' ? '继续' : sendTitle)}
          onClick={() => {
            if (primaryAction === 'send') dispatchSend()
            else onPrimaryAction?.()
          }}
          disabled={cannotSend}
        >
          {primaryAction === 'pause' ? '■' : primaryAction === 'resume' ? '▶' : '↑'}
        </button>
      </div>
      {hint ? <div className="chint">{hint}</div> : null}
      {footer}
    </div>
  )
}
