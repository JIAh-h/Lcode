import { useEffect, useState } from 'react'
import { t } from '../i18n/index.ts'
import { toast } from './toast.ts'
import { PopMenu } from './PopMenu.tsx'
import { RenameDialog } from './RenameDialog.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { sessionBridge } from '../store/sessionBridge.ts'

interface SidebarState {
  pinnedWorkspaces: string[]
  archivedWorkspaces: string[]
  pinnedSessions: string[]
  collapsedWorkspaces: string[]
}

/**
 * 会话「⋯」菜单：侧栏行与工作台标题栏共用同一套动作，
 * 避免两处各写一份而有细微差异（重命名/导出/置顶/归档/永久归档）。
 */
export function SessionActionsMenu({
  session,
  buttonClass = 'sga',
  onRenamed,
  onRemoved,
}: {
  session: { readonly session_id: string; readonly title: string }
  buttonClass?: string
  /** 重命名成功（标题已落库） */
  onRenamed?: ((title: string) => void) | undefined
  /** 归档/永久归档成功（当前页面应离开该会话） */
  onRemoved?: (() => void) | undefined
}) {
  const [pinned, setPinned] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [purging, setPurging] = useState(false)

  useEffect(() => {
    void window.lcode.getSidebar().then((value) => {
      const list = (value as SidebarState | null)?.pinnedSessions ?? []
      setPinned(list.includes(session.session_id))
    })
  }, [session.session_id])

  const notifySessionChanged = (): void => {
    window.dispatchEvent(new Event('lcode:session-changed'))
  }

  const onSelect = (id: string): void => {
    const bridge = sessionBridge()
    if (bridge === undefined) return
    if (id === 'rename') {
      setRenaming(true)
      return
    }
    if (id === 'export') {
      void bridge
        .export({ session_id: session.session_id, format: 'jsonl' })
        .then((result) => toast(t('已导出到 {path}（SHA-256 {hash}）', { path: result.path, hash: result.sha256.slice(0, 12) })))
        .catch((err: unknown) => toast(err instanceof Error ? err.message : t('导出会话失败')))
      return
    }
    if (id === 'pin') {
      void (async () => {
        const current = (await window.lcode.getSidebar()) as SidebarState
        const list = current.pinnedSessions
        const next = list.includes(session.session_id)
          ? list.filter((item) => item !== session.session_id)
          : [...list, session.session_id]
        await window.lcode.setSidebar({ ...current, pinnedSessions: next })
        setPinned(next.includes(session.session_id))
        window.dispatchEvent(new Event('lcode:sidebar-changed'))
      })()
      return
    }
    if (id === 'archive') {
      void bridge
        .delete({ session_id: session.session_id })
        .then(() => {
          notifySessionChanged()
          onRemoved?.()
          toast(t('已归档，可用 lcode restore 恢复'))
        })
        .catch((err: unknown) => toast(err instanceof Error ? err.message : t('归档失败')))
      return
    }
    if (id === 'purge') setPurging(true)
  }

  const submitRename = (title: string): void => {
    const bridge = sessionBridge()
    if (bridge === undefined) return
    void bridge
      .rename({ session_id: session.session_id, title })
      .then(() => {
        setRenaming(false)
        notifySessionChanged()
        onRenamed?.(title)
        toast(t('已重命名'))
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('重命名失败')))
  }

  const confirmPurge = (): void => {
    const bridge = sessionBridge()
    if (bridge === undefined) return
    void bridge
      .purge({ session_id: session.session_id, force: true })
      .then(() => {
        setPurging(false)
        notifySessionChanged()
        onRemoved?.()
        toast(t('已移入回收站，7 天后清除'))
      })
      .catch((err: unknown) => {
        setPurging(false)
        toast(err instanceof Error ? err.message : t('永久归档失败'))
      })
  }

  return (
    <>
      <PopMenu
        trigger="⋯"
        buttonClass={buttonClass}
        title={t('会话操作')}
        items={[
          { id: 'rename', label: '重命名' },
          { id: 'export', label: '导出记录' },
          { id: 'pin', label: pinned ? '取消置顶' : '工作区内置顶' },
          { id: 'archive', label: '归档' },
          { id: 'purge', label: '永久归档' },
        ]}
        onSelect={onSelect}
      />
      {renaming && (
        <RenameDialog initial={session.title} onCancel={() => setRenaming(false)} onSubmit={submitRename} />
      )}
      {purging && (
        <ConfirmDialog
          title={t('永久归档会话')}
          message={t('会把「{name}」移入回收站，7 天后清除。', { name: session.title || t('未命名会话') })}
          confirmLabel={t('永久归档')}
          danger
          onCancel={() => setPurging(false)}
          onConfirm={confirmPurge}
        />
      )}
    </>
  )
}
