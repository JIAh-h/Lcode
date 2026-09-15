import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { TextArea } from './controls.tsx'
import { PopMenu } from './PopMenu.tsx'
import type { PopMenuItem } from './PopMenu.tsx'
import { toast } from './toast.ts'
import { t } from '../i18n/index.ts'
import { chooseDefaultModel } from '../store/modelSync.ts'
import { PERMISSION_PRESETS, PERMISSION_PRESET_HINT, setPermissionPreset, useUiPrefs } from '../store/uiPrefs.ts'
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
  placeholder,
  sendTitle = '发送',
  hint,
  leading,
}: {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  placeholder?: string
  sendTitle?: string
  /** textarea 上方的提示行（可选） */
  hint?: string
  /** textarea 之前的插槽（首页用它放「选择项目」行） */
  leading?: ReactNode
}) {
  const prefs = useUiPrefs()
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])

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
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend()
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

  const modelItems: readonly PopMenuItem[] = prefs.models.map((m) => ({
    id: m.name,
    // 显示名（label），不是内部 id——用户认的是"我给它起的名字"
    label: m.src,
    hint: m.model,
    checked: prefs.defaultProvider === m.name,
  }))

  /** 当前选中项的显示名；没选或找不到就显示引导文案 */
  const currentModelLabel =
    prefs.models.find((m) => m.name === prefs.defaultProvider)?.src ?? ''

  return (
    <>
      {leading}
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
          onSelect={(id) => setPermissionPreset(id as PermissionPreset)}
        />
        <PopMenu
          // 没有模型时**不能显示空触发器**（一个光秃秃的 " ▾" 让人不知道那是什么）。
          // 这种情形只出现在"一个模型都没配"——此时该引导去配置，而不是给个空菜单。
          trigger={`${currentModelLabel === '' ? t('选择模型') : currentModelLabel} ▾`}
          title="模型"
          up
          header="这次对话用哪个模型"
          items={modelItems}
          footer={
            modelItems.length === 0
              ? t('还没有配置任何模型，请先到「设置 → 模型」添加')
              : t('换默认模型请到「设置 → 模型」')
          }
          onSelect={(id) => {
            // **必须走 chooseDefaultModel**：它会把选择回写主进程
            // （`ctx.agentDefaultModel` 是权威）。以前这里只改渲染层镜像，
            // 于是"界面上选好了、引擎那边还是空的"，发消息必报「还没有选择模型」。
            void chooseDefaultModel(id).catch(() => undefined)
            toast(t('已切换模型：{name}', { name: prefs.models.find((m) => m.name === id)?.src ?? id }))
          }}
        />
        <button className="send" title={t(sendTitle)} onClick={onSend}>
          ↑
        </button>
      </div>
      {hint ? <div className="chint">{hint}</div> : null}
    </>
  )
}
