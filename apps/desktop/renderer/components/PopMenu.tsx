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
  header,
  footer,
  up = false,
  block = false,
  align = 'left',
  width = MENU_WIDTH,
  dense = false,
}: {
  trigger: ReactNode
  buttonClass?: string
  title?: string
  items: readonly PopMenuItem[]
  onSelect: (id: string) => void
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
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const open = pos !== null

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
    const close = () => setPos(null)
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node
      if (triggerRef.current?.contains(node)) return
      if (menuRef.current?.contains(node)) return
      setPos(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null)
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

  return (
    <span className={'pickwrap' + (block ? ' block' : '')} ref={triggerRef}>
      <button
        className={buttonClass}
        title={title ? t(title) : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setPos(null) : place())}
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
              {items.map((item) => (
                <Fragment key={item.id}>
                  {item.separator === true ? <div className="pmsep" role="separator" /> : null}
                  <a
                    role="menuitemradio"
                    aria-checked={item.checked === true}
                    className={
                      (item.checked ? 'on' : '') +
                      (item.disabled ? ' disabled' : '') +
                      (item.compact ? ' compact' : '')
                    }
                    onClick={() => {
                      if (item.disabled) return
                      setPos(null)
                      onSelect(item.id)
                    }}
                  >
                    <span className="pmk">{item.icon ?? (item.checked ? '✓' : '')}</span>
                    <span className="pml">
                      {t(item.label)}
                      {item.hint ? <em>{t(item.hint)}</em> : null}
                    </span>
                  </a>
                </Fragment>
              ))}
              {footer ? <div className="pickhint">{t(footer)}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
