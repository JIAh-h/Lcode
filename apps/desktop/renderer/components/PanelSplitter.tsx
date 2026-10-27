import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { t } from '../i18n/index.ts'

const DEFAULT_MAX_RATIO = 1 / 3
const KEYBOARD_STEP = 16

export interface ResizablePanelState {
  readonly width: number
  readonly dragging: boolean
  readonly minWidth: number
  readonly maxWidth: number
  readonly handleProps: {
    readonly role: 'separator'
    readonly tabIndex: 0
    readonly 'aria-orientation': 'vertical'
    readonly 'aria-label': string
    readonly 'aria-valuemin': number
    readonly 'aria-valuemax': number
    readonly 'aria-valuenow': number
    readonly title: string
    readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
    readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
    readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
    readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  }
}

export interface UseResizablePanelOptions {
  readonly storageKey: string
  readonly defaultWidth: number
  readonly minWidth: number
  readonly side: 'left' | 'right'
  readonly label: string
  readonly maximum?: number
  readonly onCollapse: () => void
}

/**
 * 可拖动侧栏宽度。最大宽度按窗口的 1/3 计算；拖到最小宽度以下直接收起。
 * 宽度存本机 localStorage，窗口缩小时自动夹到新的上限。
 */
export function useResizablePanel(options: UseResizablePanelOptions): ResizablePanelState {
  const ratio = options.maximum ?? DEFAULT_MAX_RATIO
  const maxForViewport = (): number => {
    const viewport = typeof window === 'undefined' ? 0 : window.innerWidth
    return Math.max(options.minWidth, Math.floor(viewport * ratio))
  }
  const [maxWidth, setMaxWidth] = useState(maxForViewport)
  const [width, setWidth] = useState(() => {
    const stored = readStored(options.storageKey)
    return clamp(stored > 0 ? stored : options.defaultWidth, options.minWidth, maxForViewport())
  })
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  const dragStart = useRef<{ readonly x: number; readonly width: number } | null>(null)
  const onCollapseRef = useRef(options.onCollapse)
  onCollapseRef.current = options.onCollapse

  useEffect(() => {
    try {
      window.localStorage.setItem(options.storageKey, String(Math.round(width)))
    } catch {
      // 打包后 file:// 可能禁用 localStorage；宽度仍在本会话内生效
    }
  }, [options.storageKey, width])

  useEffect(() => {
    const onResize = (): void => {
      const next = maxForViewport()
      setMaxWidth(next)
      setWidth((current) => clamp(current, options.minWidth, next))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [options.minWidth, ratio])

  const finishDrag = (): void => {
    draggingRef.current = false
    dragStart.current = null
    setDragging(false)
    document.body.classList.remove('resizing')
  }

  useEffect(() => () => document.body.classList.remove('resizing'), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragStart.current = { x: event.clientX, width }
    draggingRef.current = true
    setDragging(true)
    document.body.classList.add('resizing')
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current || dragStart.current === null) return
    const delta = event.clientX - dragStart.current.x
    const raw = options.side === 'left'
      ? dragStart.current.width + delta
      : dragStart.current.width - delta
    if (raw < options.minWidth) {
      finishDrag()
      setWidth(options.minWidth)
      onCollapseRef.current()
      return
    }
    setWidth(clamp(raw, options.minWidth, maxWidth))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    finishDrag()
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const signed = options.side === 'left' ? direction : -direction
    setWidth((current) => clamp(current + signed * KEYBOARD_STEP, options.minWidth, maxWidth))
  }

  return {
    width,
    dragging,
    minWidth: options.minWidth,
    maxWidth,
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-label': options.label,
      'aria-valuemin': options.minWidth,
      'aria-valuemax': maxWidth,
      'aria-valuenow': Math.round(width),
      title: t('拖动调整宽度（最小 {min}px，最大 {max}px）', { min: options.minWidth, max: maxWidth }),
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: finishDrag,
      onKeyDown,
    },
  }
}

export function PanelSplitter({ side, panel }: { readonly side: 'left' | 'right'; readonly panel: ResizablePanelState }) {
  return (
    <div className={`splitter splitter-${side}${panel.dragging ? ' dragging' : ''}`} {...panel.handleProps}>
      <span className="splitter-tip">{Math.round(panel.width)} px · {panel.minWidth}–{panel.maxWidth}</span>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function readStored(key: string): number {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}
