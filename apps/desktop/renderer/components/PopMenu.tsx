import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { t } from '../i18n/index.ts'

/**
 * 通用下拉菜单（公共组件）。
 *
 * 交互与 `AppShell` 菜单栏、首页「选择项目」同一套：点击外部关闭、Esc 关闭、
 * 点触发按钮自身切换（触发按钮在 `triggerRef` 内，因此"点按钮"不算"点外部"）。
 *
 * **为什么用 portal + fixed 定位**：设置页的卡片 `.sect` 有 `overflow: hidden`，
 * 若菜单按常规绝对定位挂在触发按钮旁边，会被卡片裁掉。挂到 `document.body`
 * 并用 `getBoundingClientRect()` 算固定坐标，任何祖先的 overflow / transform
 * 都裁不到它。代价是滚动时坐标会失效，所以滚动/缩放时直接关闭（可预期优先）。
 *
 * 样式复用 `.pickmenu`（与首页「选择项目」视觉一致）。
 */

export interface PopMenuItem {
  readonly id: string
  readonly label: string
  /** 说明行（如权限预设的用户预期） */
  readonly hint?: string
  /** 选中态（当前生效项） */
  readonly checked?: boolean
  readonly disabled?: boolean
  /** 左侧图标（替代勾选位；用于菜单底部的动作入口） */
  readonly icon?: ReactNode
  /** 在这一项之前画一条分隔线 */
  readonly separator?: boolean
  /** 次级样式：更小字号与次要颜色，和普通选项区分 */
  readonly compact?: boolean
  /** 多选样式（角色为 menuitemcheckbox）；默认是单选/动作 */
  readonly checkbox?: boolean
}

const MENU_WIDTH = 260
const GAP = 6
const EDGE = 8

export function PopMenu({
  trigger,
  buttonClass = 'tbtn',
  title,
  items,
  onSelect,
  onOpen,
  header,
  footer,
  up = false,
  block = false,
  align = 'left',
  width = MENU_WIDTH,
  dense = false,
  flyout,
  openSignal,
}: {
  trigger: ReactNode
  buttonClass?: string
  title?: string
  items: readonly PopMenuItem[]
  /** 返回 'keep-open' 时保持菜单展开（多选场景） */
  onSelect: (id: string) => void | 'keep-open'
  /** 菜单即将展开（用于刷新动态条目） */
  onOpen?: (() => void) | undefined
  /** 菜单顶部分组标题 */
  header?: string
  /** 菜单底部说明 */
  footer?: string
  /** 向上展开（composer 在窗口底部时用） */
  up?: boolean
  /** 触发按钮占满一行（表单里的下拉用） */
  block?: boolean
  /** 贴触发按钮哪一侧展开：右侧按钮用 right，菜单向左长 */
  align?: 'left' | 'right'
  /** 菜单宽度（像素）；窄菜单用 170 左右 */
  width?: number
  /** 紧凑档：更小的内边距、隐藏勾选留白（纯动作菜单用） */
  dense?: boolean
  /**
   * 悬停某一项时在其右侧展开二级浮层（如「技能」）。
   * 浮层是菜单 DOM 的后代，所以移入浮层不会被当成“点击外部”，也不需要额外的定位协调。
   */
  flyout?: {
    readonly itemId: string
    readonly width?: number
    readonly render: (close: () => void) => ReactNode
  } | undefined
  /** 递增时打开菜单并直接展开 flyout（供 /skills 使用） */
  openSignal?: number | undefined
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const open = pos !== null
  const closeAll = (): void => {
    setPos(null)
    setFlyoutOpen(false)
  }

  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const raw = align === 'right' ? r.right - width : r.left
    const left = Math.max(EDGE, Math.min(raw, window.innerWidth - width - EDGE))
    // 向上展开时用 translateY(-100%) 翻转，免得为了定位去测量菜单高度
    setPos({ left, top: up ? r.top - GAP : r.bottom + GAP })
  }, [up, align, width])

  /* 打开时定位；滚动/缩放会让固定坐标失效，直接关闭（可预期优先） */
  useEffect(() => {
    if (!open) return
    const close = () => closeAll()
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node
      if (triggerRef.current?.contains(node)) return
      if (menuRef.current?.contains(node)) return
      closeAll()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  // /skills 这类命令需要直接打开菜单并展开二级浮层
  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return
    onOpen?.()
    place()
    setFlyoutOpen(true)
  }, [openSignal])

  return (
    <span className={'pickwrap' + (block ? ' block' : '')} ref={triggerRef}>
      <button
        className={buttonClass}
        title={title ? t(title) : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            closeAll()
            return
          }
          onOpen?.()
          place()
        }}
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            <div
              className={'pickmenu portal' + (dense ? ' dense' : '')}
              role="menu"
              ref={menuRef}
              style={{
                left: pos.left,
                top: pos.top,
                width,
                ...(up ? { transform: 'translateY(-100%)' } : {}),
              }}
            >
              {header ? <div className="picklab">{t(header)}</div> : null}
              {items.map((item) => {
                const isFlyoutItem = flyout?.itemId === item.id
                const content = (
                  <a
                    role={item.checkbox === true ? 'menuitemcheckbox' : 'menuitemradio'}
                    aria-checked={item.checked === true}
                    aria-haspopup={isFlyoutItem ? 'menu' : undefined}
                    aria-expanded={isFlyoutItem ? flyoutOpen : undefined}
                    className={
                      (item.checked ? 'on' : '') +
                      (item.disabled ? ' disabled' : '') +
                      (item.compact ? ' compact' : '')
                    }
                    onMouseEnter={() => {
                      if (isFlyoutItem) setFlyoutOpen(true)
                      else setFlyoutOpen(false)
                    }}
                    onClick={() => {
                      if (item.disabled) return
                      if (isFlyoutItem) {
                        setFlyoutOpen((value) => !value)
                        return
                      }
                      if (onSelect(item.id) !== 'keep-open') closeAll()
                    }}
                  >
                    <span className="pmk">{item.icon ?? (item.checked ? '✓' : '')}</span>
                    <span className="pml">
                      {t(item.label)}
                      {item.hint ? <em>{t(item.hint)}</em> : null}
                    </span>
                    {isFlyoutItem ? <span className="pm-chev" aria-hidden="true">›</span> : null}
                  </a>
                )
                return (
                  <Fragment key={item.id}>
                    {item.separator === true ? <div className="pmsep" role="separator" /> : null}
                    {isFlyoutItem ? (
                      <div
                        className="pm-flyout-wrap"
                        onMouseLeave={() => setFlyoutOpen(false)}
                      >
                        {content}
                        {flyoutOpen ? (
                          <div
                            className="pm-flyout"
                            role="menu"
                            style={{ width: flyout.width ?? 230 }}
                          >
                            {flyout.render(closeAll)}
                          </div>
                        ) : null}
                      </div>
                    ) : content}
                  </Fragment>
                )
              })}
              {footer ? <div className="pickhint">{t(footer)}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
