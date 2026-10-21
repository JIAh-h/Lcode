import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { QueuedMessage } from '../store/sessionBridge.ts'
import { TextArea } from './controls.tsx'
import { PopMenu } from './PopMenu.tsx'
import type { PopMenuItem } from './PopMenu.tsx'
import { toast } from './toast.ts'
import { t } from '../i18n/index.ts'
import { chooseDefaultModel } from '../store/modelSync.ts'
import { choosePermissionPreset } from '../store/permissionSync.ts'
import { PERMISSION_PRESETS, PERMISSION_PRESET_HINT, useUiPrefs } from '../store/uiPrefs.ts'
import type { PermissionPreset } from '../store/uiPrefs.ts'

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

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function ComposerBar({
  value,
  onChange,
  onSend,
  primaryAction = 'send',
  onPrimaryAction,
  placeholder,
  sendTitle = '发送',
  hint,
  leading,
  planActive = false,
  planReady = false,
  onPlanAction,
  queued = [],
  onGuideQueued,
  onEditQueued,
  onRemoveQueued,
  onClearQueued,
}: {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  primaryAction?: 'send' | 'pause' | 'resume'
  onPrimaryAction?: (() => void) | undefined
  placeholder?: string
  sendTitle?: string
  /** textarea 上方的提示行（可选） */
  hint?: string
  /** textarea 之前的插槽（首页用它放「选择项目」行） */
  leading?: ReactNode
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
}) {
  const prefs = useUiPrefs()
  const navigate = useNavigate()
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = useState('')

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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 与 Codex 一致：Enter 提交，Shift+Enter 明确保留换行；输入法候选确认不能误发。
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (value.trim() !== '') onSend()
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

  const addItems: readonly PopMenuItem[] = [
    { id: 'file', label: '添加文件…', hint: '作为附件引用，不内联内容' },
    { id: 'folder', label: '添加文件夹…', hint: '整个目录作为上下文来源' },
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
      hint: '设置 → 模型',
    },
  ]

  /** 当前选中项的显示名；没选或找不到就显示引导文案 */
  const currentModelLabel =
    prefs.models.find((m) => m.name === prefs.defaultProvider)?.src ?? ''
  const cannotSend = primaryAction === 'send' && value.trim() === ''

  return (
    <>
      {leading}
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
      {attachments.length > 0 ? (
        <div className="attchips">
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
        </div>
      ) : null}
      <TextArea variant="bare" placeholder={placeholder} value={value} onChange={onChange} onKeyDown={onKeyDown} />
      <div className="cinbar">
        {onPlanAction ? (
          <button
            className={'planmode' + (planActive ? ' on' : '')}
            title={t(planActive ? (planReady ? '确认计划并开始执行' : '等待助手提交计划') : '进入计划模式')}
            onClick={onPlanAction}
            disabled={planActive && !planReady}
          >
            {t(planActive ? '开始执行' : '计划模式')}
          </button>
        ) : null}
        <PopMenu
          trigger="＋"
          title="添加附件"
          up
          items={addItems}
          onSelect={(id) => void pickFile(id === 'folder' ? 'folder' : 'file')}
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
        <button
          className={'send' + (primaryAction === 'pause' ? ' stop' : '')}
          title={t(primaryAction === 'pause' ? '暂停' : primaryAction === 'resume' ? '继续' : sendTitle)}
          aria-label={t(primaryAction === 'pause' ? '暂停' : primaryAction === 'resume' ? '继续' : sendTitle)}
          onClick={onPrimaryAction ?? onSend}
          disabled={cannotSend}
        >
          {primaryAction === 'pause' ? '■' : primaryAction === 'resume' ? '▶' : '↑'}
        </button>
      </div>
      {hint ? <div className="chint">{hint}</div> : null}
    </>
  )
}
