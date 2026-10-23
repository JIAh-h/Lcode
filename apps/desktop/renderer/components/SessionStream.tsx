import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { deriveVisibleSurfaceItems } from '@lcode/session'
import type { SessionEvent, ModelMessage, ContentBlock } from '@lcode/session'
import { attachmentBridge, notifySessionChanged } from '../store/sessionBridge.ts'
import { t } from '../i18n/index.ts'
import { Markdown } from './Markdown.tsx'
import { toast } from './toast.ts'
import { ToolCard, type ToolCardCall, type ToolCardResult } from './ToolCard.tsx'
import { ApprovalCard, type ApprovalDecision } from './ApprovalCard.tsx'
import { ComposerBar, type Attachment, type ComposerSendInput, type ImageAttachment } from './ComposerBar.tsx'

/**
 * 真实会话流（T5.4）。
 *
 * 在此之前工作台渲染的是一张**写死的最终总结卡**（"parse.ts 已切换为结构化解析…"），
 * 那是原型阶段的展示壳。这里换成真实数据：
 *
 * ```
 * sessions.open(sessionId) → 已有历史（derive 消息）
 * 事件流（IPC 推送）        → 之后发生的一切
 * ```
 *
 * ## 一条纪律：渲染行只从事件装配，不另写消息投影
 *
 * 渲染行由 `timeline`（用户/助手消息、工具调用、审批）直接装配；消息投影的**唯一权威**
 * 仍是 `@lcode/core/session` 的 `deriveMessages`，引擎侧用它（I1）。
 *
 * ⚠️ 不要在这边另写一份"遍历事件拼消息"的投影逻辑：那等于给同一个概念造第二个实现，
 * 压缩、空 assistant 消息这些边界迟早会分叉。空态判断只需要"有没有可渲染行"，不必为此
 * 在每次事件到达时跑一遍全量派生——10 万事件的会话里这笔开销是实打实的。
 */

interface SessionBridge {
  open(sessionId: string): Promise<{
    events: readonly SessionEvent[]
    history: { messages: readonly ModelMessage[] }
    repaired: boolean
    /** 日志末尾是一个失败的轮（`turn/end {reason:'error'}`） */
    last_turn_errored?: boolean
  }>
  onEvent(handler: (payload: unknown) => void): () => void
  onChunks(handler: (payload: unknown) => void): () => void
  onTurnFailed(handler: (payload: unknown) => void): () => void
  send(input: { session_id: string; text: string }): Promise<unknown>
  cancel(sessionId: string): Promise<unknown>
  rewindSend(input: { session_id: string; to_seq: number; text: string }): Promise<{
    readonly accepted: true
    readonly rewind: {
      readonly discarded: number
      readonly restored: readonly string[]
      readonly removed: readonly string[]
      readonly unrestored: readonly string[]
    }
  }>
  retryTurn(input: { readonly session_id: string }): Promise<{
    readonly accepted: true
    readonly retry: { readonly discarded: number }
  }>
  fork(input: { readonly source_session_id: string; readonly boundary: number }): Promise<{ readonly session_id: string }>
  marker(input: {
    readonly session_id: string
    readonly target_seq: number
    readonly pinned?: boolean
    readonly muted?: boolean
  }): Promise<{ readonly target_seq: number; readonly pinned: boolean; readonly muted: boolean }>
}

function bridge(): SessionBridge | undefined {
  const lcode = (
    globalThis as unknown as {
      lcode?: {
        session?: SessionBridge
        agent?: {
          send: SessionBridge['send']
          cancel: SessionBridge['cancel']
        }
      }
    }
  ).lcode
  if (lcode?.session === undefined || lcode.agent === undefined) return undefined
  return {
    open: (id) => lcode.session!.open(id),
    onEvent: (h) => lcode.session!.onEvent(h),
    onChunks: (h) => lcode.session!.onChunks(h),
    onTurnFailed: (h) => lcode.session!.onTurnFailed(h),
    send: (input) => lcode.agent!.send(input),
    cancel: (id) => lcode.agent!.cancel(id),
    rewindSend: (input) => lcode.session!.rewindSend(input),
    retryTurn: (input) => lcode.session!.retryTurn(input),
    fork: (input) => lcode.session!.fork(input),
    marker: (input) => lcode.session!.marker(input),
  }
}

type ImageBlock =
  | Extract<ContentBlock, { readonly type: 'image' }>
  | Extract<ContentBlock, { readonly type: 'image-ref' }>

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image' || block.type === 'image-ref'
}

function isSummaryText(text: string): boolean {
  return text.startsWith('[Conversation summary]')
}

/** 附件图按需读取：长会话里不会因为几十张 base64 把首屏拖住。 */
function AttachmentImage({ block }: { readonly block: ImageBlock }) {
  const [src, setSrc] = useState<string | null>(block.type === 'image' ? `data:${block.mediaType};base64,${block.data}` : null)
  const [missing, setMissing] = useState(false)
  const [preview, setPreview] = useState(false)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  /** 查看器尺寸按图片比例计算，避免左右/上下留下无意义的空白 */
  const [panelSize, setPanelSize] = useState<{ width: number; height: number } | null>(null)
  const naturalRef = useRef<{ width: number; height: number } | null>(null)
  const thumbRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)

  const fitPanel = (naturalWidth: number, naturalHeight: number): { width: number; height: number } => {
    const maxWidth = Math.max(320, Math.min(1440, window.innerWidth - 64))
    const maxHeight = Math.max(240, Math.min(920, window.innerHeight - 88))
    const ratio = naturalWidth / naturalHeight
    let width = maxWidth
    let height = width / ratio
    if (height > maxHeight) {
      height = maxHeight
      width = height * ratio
    }
    return { width: Math.round(width), height: Math.round(height) }
  }

  const closePreview = (): void => {
    setPreview(false)
    setDragging(false)
    dragRef.current = null
    setView({ scale: 1, x: 0, y: 0 })
  }

  /** 放大后限制平移范围，避免把图片拖出面板 */
  const clampPan = (x: number, y: number, scale: number): { x: number; y: number } => {
    const canvas = canvasRef.current
    const image = canvas?.querySelector('img')
    if (canvas === null || image === null || image === undefined) return { x, y }
    const maxX = Math.max(0, (image.clientWidth * scale - canvas.clientWidth) / 2)
    const maxY = Math.max(0, (image.clientHeight * scale - canvas.clientHeight) / 2)
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) }
  }

  useEffect(() => {
    if (block.type !== 'image-ref') return
    const api = attachmentBridge()
    if (api === undefined) {
      setMissing(true)
      return
    }
    let alive = true
    setSrc(null)
    setMissing(false)
    void api
      .read({ hash: block.hash, media_type: block.mediaType })
      .then((result) => {
        if (alive) setSrc(`data:${result.media_type};base64,${result.data}`)
      })
      .catch(() => {
        if (alive) setMissing(true)
      })
    return () => {
      alive = false
    }
  }, [block])
  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview])

  // React 的 wheel 监听在根节点上是 passive 的；必须用原生监听才能阻止背景滚动
  useEffect(() => {
    if (!preview) return
    const onResize = (): void => {
      const natural = naturalRef.current
      if (natural !== null) setPanelSize(fitPanel(natural.width, natural.height))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [preview])

  useEffect(() => {
    if (!preview) return
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      setView((previous) => {
        const nextScale = Math.min(8, Math.max(0.25, previous.scale * Math.exp(-event.deltaY * 0.0015)))
        const ratio = nextScale / previous.scale
        // 围绕鼠标位置缩放：指针下的内容保持不动
        const cursorX = event.clientX - rect.left - rect.width / 2
        const cursorY = event.clientY - rect.top - rect.height / 2
        const pan = clampPan(
          cursorX - (cursorX - previous.x) * ratio,
          cursorY - (cursorY - previous.y) * ratio,
          nextScale,
        )
        return { scale: nextScale, ...pan }
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [preview])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || view.scale <= 1) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针可能已被系统释放；拖动仍然按坐标继续
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    }
    setDragging(true)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    setView((previous) => {
      const pan = clampPan(
        drag.originX + event.clientX - drag.startX,
        drag.originY + event.clientY - drag.startY,
        previous.scale,
      )
      return { ...previous, ...pan }
    })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  if (missing) return <span className="ssimage-missing">{t('图片附件已清理')}</span>
  if (src === null) return <span className="ssimage-loading">{t('加载图片…')}</span>
  return (
    <>
      <button
        type="button"
        className="ssimage-btn"
        title={t('放大查看图片')}
        aria-label={t('放大查看图片')}
        onClick={() => {
          const image = thumbRef.current
          if (image !== null && image.naturalWidth > 0 && image.naturalHeight > 0) {
            naturalRef.current = { width: image.naturalWidth, height: image.naturalHeight }
            setPanelSize(fitPanel(image.naturalWidth, image.naturalHeight))
          }
          setView({ scale: 1, x: 0, y: 0 })
          setPreview(true)
        }}
      >
        <img ref={thumbRef} src={src} alt={t('粘贴的图片')} />
      </button>
      {preview
        ? createPortal(
            <div
              className="imgview"
              onClick={(event) => {
                if (event.target === event.currentTarget) closePreview()
              }}
            >
              <div
                className="imgview-panel"
                role="dialog"
                aria-modal="true"
                aria-label={t('查看图片')}
                style={panelSize === null ? undefined : { width: panelSize.width, height: panelSize.height }}
              >
                <div
                  ref={canvasRef}
                  className={'imgview-canvas' + (view.scale > 1 ? ' can-pan' : '') + (dragging ? ' dragging' : '')}
                  onPointerDown={startDrag}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onDoubleClick={() => setView({ scale: 1, x: 0, y: 0 })}
                >
                  <img
                    src={src}
                    alt={t('粘贴的图片')}
                    draggable={false}
                    onDragStart={(event) => event.preventDefault()}
                    onLoad={(event) => {
                      const image = event.currentTarget
                      if (image.naturalWidth === 0 || image.naturalHeight === 0) return
                      naturalRef.current = { width: image.naturalWidth, height: image.naturalHeight }
                      if (panelSize === null) setPanelSize(fitPanel(image.naturalWidth, image.naturalHeight))
                    }}
                    style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                  />
                </div>
                <button
                  type="button"
                  className="imgview-close"
                  title={t('关闭图片预览')}
                  aria-label={t('关闭图片预览')}
                  onClick={closePreview}
                >
                  ×
                </button>
                <span className="imgview-hint">{t('滚轮缩放 · 放大后拖动查看 · Esc 关闭')}</span>
                <button
                  type="button"
                  className="imgview-scale"
                  title={t('恢复适应窗口')}
                  onClick={() => setView({ scale: 1, x: 0, y: 0 })}
                >
                  {Math.round(view.scale * 100)}%
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/**
 * 从日志尾部恢复"当前还没收尾的步骤"已经流出的文本。
 *
 * 只收集最后一个 `assistant/message` 之后的 chunk；再往前的是已经完成并落盘的步骤，
 * 不应该重新塞进流式气泡。
 */
function pendingStreamText(events: readonly SessionEvent[]): string {
  let lastStart = -1
  let lastEnd = -1
  let lastAssistant = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') lastStart = index
    if (event.type === 'turn/end') lastEnd = index
    if (event.type === 'assistant/message') lastAssistant = index
  }
  if (lastStart < 0 || lastEnd > lastStart) return ''
  const from = lastAssistant > lastStart ? lastAssistant + 1 : lastStart + 1
  let text = ''
  for (let index = from; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      text += event.data.chunk.text
    }
  }
  return text
}

/** 日志里的流式文本与订阅期间缓存的 chunk 有重叠时，只补未覆盖的部分 */
function mergeStreamText(base: string, extra: string): string {
  if (base === '') return extra
  if (extra === '') return base
  const max = Math.min(base.length, extra.length)
  for (let length = max; length > 0; length -= 1) {
    if (base.endsWith(extra.slice(0, length))) return base + extra.slice(length)
  }
  return base + extra
}

/**
 * 只服务流式气泡的外部文本存储：chunk 追加不触发整棵会话树重渲染，
 * 订阅者只有 StreamingAssistant 一个，按帧合并更新。
 */
interface TextStreamStore {
  readonly get: () => string
  readonly subscribe: (listener: () => void) => () => void
  readonly append: (text: string) => void
  readonly set: (text: string) => void
  readonly reset: () => void
  readonly dispose: () => void
}

function createTextStreamStore(): TextStreamStore {
  let text = ''
  const listeners = new Set<() => void>()
  let frame: number | null = null
  const notify = (): void => {
    frame = null
    for (const listener of listeners) listener()
  }
  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(notify)
  }
  return {
    get: () => text,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    append: (chunk) => {
      if (chunk === '') return
      text += chunk
      schedule()
    },
    set: (value) => {
      text = value
      schedule()
    },
    reset: () => {
      text = ''
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      for (const listener of listeners) listener()
    },
    dispose: () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      listeners.clear()
    },
  }
}

/** 流式气泡：Markdown 边到边渲染，重渲染只发生在这个组件内 */
function StreamingAssistant({ store, onGrow }: { readonly store: TextStreamStore; readonly onGrow: () => void }) {
  const text = useSyncExternalStore(store.subscribe, store.get)
  useLayoutEffect(() => {
    onGrow()
  }, [text, onGrow])
  return (
    <div className="ssmsg ss-assistant">
      <div className="ssbody">
        <Markdown text={text} />
        <span className="sscursor" />
      </div>
    </div>
  )
}

/** 内容块 → 可显示文本（工具块交给 ToolCard 渲染） */
function blocksToText(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((s) => s !== '')
    .join('')
}

export function SessionStream({
  sessionId,
  retrySignal,
  onSendStateChange,
  onPausedStateChange,
  onRewound,
}: {
  readonly sessionId: string
  /** 递增时执行一次“重试最后一轮”（供 /retry 使用） */
  readonly retrySignal?: number | undefined
  /** 把"是否在运行"告诉父组件（按钮要禁用/变成停止） */
  readonly onSendStateChange?: ((running: boolean) => void) | undefined
  readonly onPausedStateChange?: ((paused: boolean) => void) | undefined
  /** 日志被就地截断后通知父页面重新打开（右栏的变更/计划都来自它自己那份事件副本） */
  readonly onRewound?: (() => void) | undefined
}) {
  /** 全部事件（open 时的历史 + 事件流推来的增量）——投影的唯一输入 */
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  /** 回退重发后自增：重新 open 一次，把已经渲染出来的旧轮次从内存里抹掉 */
  const [reloadEpoch, setReloadEpoch] = useState(0)
  /** 流式中的增量文本（`assistant/message` 落盘前的"打字过程"） */
  /**
   * 流式文本用 DOM 直接追加，而不是每个 chunk 改 React state。
   *
   * 主进程已经按 33ms 合帧；若渲染层再用 state 触发整棵会话树重渲染，
   * 长会话会在每个 chunk 上重算所有可见 Markdown，观感上就像被"逐字压慢"。
   * `streamingActive` 只在开始/结束各变一次，中间批次直接写 textContent。
   */
  const [streamingActive, setStreamingActive] = useState(false)
  const streamStoreRef = useRef<TextStreamStore | null>(null)
  if (streamStoreRef.current === null) streamStoreRef.current = createTextStreamStore()
  const streamStore = streamStoreRef.current
  useEffect(() => () => streamStore.dispose(), [streamStore])
  /**
   * **非轮失败**的错误（桥缺失、打开会话失败）。轮失败不在这里——它从 `events` 派生，
   * 见下面的 `lastTurnFailed`。分开是因为两者的"寿命"不同：桥错误是这一次操作的，
   * 而"这个会话的最后一轮失败了"是**日志里的事实**，重新打开也该看得见。
   */
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  /** 轮失败推送到达时递增，用来催界面重算（见 `onTurnFailed`） */
  const [failureEpoch, setFailureEpoch] = useState(0)
  /** `open()` 时主进程告诉我们"日志末尾是一个失败的轮"（历史里没有 turn/end 这种结构事件） */
  const [historyTurnFailed, setHistoryTurnFailed] = useState(false)
  /**
   * 时间线渲染窗口：只挂载最近 N **轮**（同一轮的执行过程折叠在一起），
   * 避免长会话一次创建上万个 DOM 节点；"加载更早"以倍增方式扩容。
   */
  const [visibleLimit, setVisibleLimit] = useState(40)
  /** 用户手动展开/收起过的轮；未记录的轮默认在运行时展开、结束后收起 */
  const [openBlocks, setOpenBlocks] = useState<Record<string, boolean>>({})
  /** 正在原位编辑的最新提问（seq）与草稿 */
  const [editingSeq, setEditingSeq] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  /** 编辑富消息时带进输入区的附件/图片/技能，避免重发时静默丢内容 */
  const [editSeed, setEditSeed] = useState<{
    readonly attachments: readonly Attachment[]
    readonly images: readonly ImageAttachment[]
    readonly skills: readonly string[]
  }>({ attachments: [], images: [], skills: [] })
  const [sendingEdit, setSendingEdit] = useState(false)
  const navigate = useNavigate()
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** 视口是否贴底；用户向上翻阅历史时为 false，新事件不再强制滚动 */
  const stickRef = useRef(true)
  /** 自动贴底设置的目标；滚动事件正好落在这里时不要误判成用户上翻 */
  const autoTargetRef = useRef<number | null>(null)
  const [showJump, setShowJump] = useState(false)
  const showJumpRef = useRef(false)
  const [jumpPos, setJumpPos] = useState<{ left: number; top: number } | null>(null)
  /**
   * 日志里当前是否有开着的轮。chunk 是**批量**到达的（主进程 33ms 合帧），
   * 最后一批可能晚于 `turn/end` 落到渲染层；没有这道闸，它会：
   * ① 把已经结束的轮重新标成"正在执行" ② 在最终消息下面再长出一条流式气泡。
   */
  const liveTurnRef = useRef(false)
  /** 扩容前记录的 scrollHeight；扩容后用它把视口锚在原位置，避免内容从上方插入时跳动 */
  const anchorRef = useRef<number | null>(null)

  useEffect(() => {
    setVisibleLimit(40)
    setOpenBlocks({})
    setEditingSeq(null)
    setDraft('')
    setEditSeed({ attachments: [], images: [], skills: [] })
  }, [sessionId, reloadEpoch])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    anchorRef.current = null
    const scroller = scrollerRef.current
    if (anchor === null || scroller === null) return
    scroller.scrollTop += scroller.scrollHeight - anchor
  }, [visibleLimit])

  useEffect(() => {
    onSendStateChange?.(running)
  }, [running, onSendStateChange])

  useEffect(() => {
    onPausedStateChange?.(paused)
  }, [paused, onPausedStateChange])

  function resetStreaming(): void {
    streamStore.reset()
    setStreamingActive(false)
  }

  /** 一批 chunk 到达就整批写入；批内不做任何字符级节流 */
  function appendStreaming(text: string): void {
    if (text === '') return
    streamStore.append(text)
    setStreamingActive(true)
  }

  // ── 打开会话：拿历史 + 订阅事件流 ──
  useEffect(() => {
    const api = bridge()
    if (api === undefined) {
      setError(t('当前环境没有主进程桥（开发预览或浏览器里打开时会这样）'))
      return
    }
    let alive = true
    let historyReady = false
    const buffered: SessionEvent[] = []
    /** 工作台挂载前的 chunk 先留着，open 回来后与日志里的流式事件去重合并 */
    const bufferedChunks: string[] = []
    setEvents([])
    resetStreaming()
    showJumpRef.current = false
    setShowJump(false)
    setHistoryTurnFailed(false)
    setPaused(false)
    liveTurnRef.current = false

    void api
      .open(sessionId)
      .then((openedSession) => {
        if (!alive) return
        setHistoryTurnFailed(openedSession.last_turn_errored === true)
        // 主进程返回真实日志事件，renderer 不再把派生消息伪装成事件。
        // open() 与订阅可能并发完成，合并时按 seq 去重，避免首屏丢事件或重复消息。
        const merged = [...openedSession.events, ...buffered].sort((a, b) => a.seq - b.seq)
        const unique = merged.filter((event, index) => index === 0 || event.seq !== merged[index - 1]!.seq)
        setEvents(unique)
        const lastTurn = [...unique].reverse().find((event) => event.type === 'turn/end')
        setPaused(lastTurn?.type === 'turn/end' && lastTurn.data.reason === 'cancelled')
        // 页面在轮已开跑后才挂载时，实时 `turn/start` 可能已经错过；
        // 以日志末尾结构事件恢复真实运行态，避免按钮错误地显示为“发送”。
        const lastStart = [...unique].reverse().find((event) => event.type === 'turn/start')
        const openNow =
          lastStart !== undefined &&
          (lastTurn === undefined || lastStart.seq > lastTurn.seq)
        setRunning(openNow)
        liveTurnRef.current = openNow
        /*
         * 页面在流式开始后才挂载时，chunk 推送可能早于订阅，或者被 `liveTurnRef`
         * 的"还没开轮"判断丢掉。日志里的 `assistant/chunk` 是权威：恢复当前步骤
         * 已经生成的文本，再与订阅期间缓存的 chunk 去重拼接。
         */
        const fromLog = openNow ? pendingStreamText(unique) : ''
        const restored = mergeStreamText(fromLog, bufferedChunks.join(''))
        streamStore.set(restored)
        if (openNow && restored !== '') setStreamingActive(true)
        historyReady = true
      })
      .catch((err: unknown) => {
        if (!alive) return
        const message = err instanceof Error ? err.message : String(err)
        // 会话已被删除/归档：工作台页面会回首页，这里不要再闪一个错误条
        if (message.includes('ES-SESSION_NOT_FOUND') || message.includes('会话不存在或日志缺失')) return
        setError(message)
      })

    const stopEvent = api.onEvent((payload) => {
      const record = payload as { session_id?: string; event?: SessionEvent }
      if (!alive || record.session_id !== sessionId || record.event === undefined) return
      const event = record.event
      if (!historyReady) {
        buffered.push(event)
      } else {
        setEvents((prev) => (prev.some((item) => item.seq === event.seq) ? prev : [...prev, event]))
      }
      // 事件落地后清掉流式缓冲：`assistant/message` 才是权威（06 §4.1 的不对称）
      if (event.type === 'assistant/message') resetStreaming()
      if (event.type === 'turn/start') {
        liveTurnRef.current = true
        setRunning(true)
        setPaused(false)
      }
      if (event.type === 'turn/end') {
        liveTurnRef.current = false
        setRunning(false)
        resetStreaming()
        setPaused(event.data.reason === 'cancelled')
      }
    })

    const stopChunks = api.onChunks((payload) => {
      const record = payload as {
        session_id?: string
        chunks?: readonly { type: string; text?: string }[]
      }
      if (!alive || record.session_id !== sessionId || record.chunks === undefined) return
      const text = record.chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.text ?? '')
        .join('')
      if (!historyReady) {
        bufferedChunks.push(text)
        return
      }
      // 迟到的批次不再属于任何开着的轮：丢掉，别把已收尾的轮重新点亮
      if (!liveTurnRef.current) return
      setRunning(true)
      setPaused(false)
      appendStreaming(text)
    })

    /*
     * 轮失败：**只标一个时间戳，不直接写 error 状态**。
     *
     * 原因是屏幕上那句话要从 `events` 里**派生**（见下面的 `lastTurnFailed`），
     * 而不是由这条推送直接呈现——否则"失败发生在订阅之前"时（首页发完就跳转，
     * 配错模型时几十毫秒就失败）界面依然是空的：推送确实到了，但当时没人在听，
     * 而等挂载好再看日志，那个失败是真实存在过的。实测就是这么漏的。
     *
     * 这里的作用只是"催一下"：让已经挂载的界面**立刻**重算，不用等别的状态变化。
     */
    const stopFailed = api.onTurnFailed((payload) => {
      const record = payload as { session_id?: string }
      if (!alive || record.session_id !== sessionId) return
      liveTurnRef.current = false
      setRunning(false)
      resetStreaming()
      setFailureEpoch((n) => n + 1)
    })

    return () => {
      alive = false
      stopEvent()
      stopChunks()
      stopFailed()
    }
  }, [sessionId, reloadEpoch])

  /**
   * 真正滚动的是外层 `.stream`（它才有固定高度和 overflow）；`.sessionstream`
   * 随内容长高，自己并不滚动。监听必须挂在真正的滚动容器上，否则“用户是否贴底”
   * 永远是 true，自动贴底也会因为 scrollIntoView 的祖先判断而不稳定。
   */
  function scrollContainer(): HTMLElement | null {
    const root = scrollerRef.current
    if (root === null) return null
    const outer = root.closest('.stream')
    return outer instanceof HTMLElement ? outer : root
  }

  function scrollToBottomIfFollowing(): void {
    if (!stickRef.current) return
    const container = scrollContainer()
    if (container === null) return
    autoTargetRef.current = container.scrollHeight
    container.scrollTop = container.scrollHeight
  }

  useEffect(() => {
    const container = scrollContainer()
    if (container === null) return
    const setFollowing = (following: boolean): void => {
      stickRef.current = following
      if (showJumpRef.current === !following) return
      showJumpRef.current = !following
      setShowJump(!following)
    }
    const onScroll = (): void => {
      const target = autoTargetRef.current
      autoTargetRef.current = null
      // 自动贴底产生的滚动事件：保持跟随状态，不要当成用户上翻
      if (target !== null && Math.abs(container.scrollTop + container.clientHeight - target) <= 2) return
      setFollowing(container.scrollHeight - container.scrollTop - container.clientHeight < 48)
    }
    // 滚轮/触摸上翻是明确的用户意图，先于下一次 chunk 的自动滚动生效
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0) return
      setFollowing(false)
      autoTargetRef.current = null
    }
    const onTouchMove = (): void => {
      setFollowing(false)
      autoTargetRef.current = null
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchmove', onTouchMove)
    }
  }, [sessionId])

  // 新内容到达时贴底；用户主动向上翻阅后不打断
  useEffect(() => {
    scrollToBottomIfFollowing()
  }, [events.length, streamingActive])

  /** 回到底部按钮：固定在正文右侧留白处，不覆盖消息文本 */
  useEffect(() => {
    if (!showJump) {
      setJumpPos(null)
      return
    }
    const update = (): void => {
      const container = scrollContainer()
      if (container === null) return
      const rect = container.getBoundingClientRect()
      const col = container.querySelector('.col')?.getBoundingClientRect()
      const size = 28
      const right = rect.right - size - 10
      const gutter = col === undefined ? 0 : rect.right - col.right
      // 放在正文列右侧留白里，完全避开文字；留白不足时才退到滚动区右缘
      const left = col !== undefined && gutter >= size + 4
        ? col.right + (gutter - size) / 2
        : right
      setJumpPos({ left: Math.round(left), top: Math.round(rect.bottom - size - 12) })
    }
    update()
    window.addEventListener('resize', update)
    const container = scrollContainer()
    const observer = container === null ? null : new ResizeObserver(update)
    if (container !== null) observer?.observe(container)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [showJump, sessionId])

  const jumpToBottom = (): void => {
    stickRef.current = true
    showJumpRef.current = false
    setShowJump(false)
    const container = scrollContainer()
    if (container === null) return
    autoTargetRef.current = container.scrollHeight
    container.scrollTop = container.scrollHeight
  }

  /**
   * **从事件里派生"最后一轮失败了"**（而不是只认那条实时推送）。
   *
   * 这样"失败发生在订阅之前"也能看见：那个 `turn/end {reason:'error'}` 一直躺在日志里，
   * 重新打开会话、甚至重启应用之后依然成立。实时推送只负责**催一下重算**，
   * 不承担"唯一的信息来源"这个角色——否则就成了"推送到达时没人在听 = 用户什么都看不到"。
   *
   * `historyTurnFailed` 那一路是必要的补充：`open()` 回的是**派生好的消息**，
   * 没有 `turn/end` 这种结构事件，所以"打开时就发现上一轮失败过"只能由主进程直接告诉我们。
   * 新一轮开跑（`turn/start`）时它自然失效。
   */
  const lastTurnFailed = useMemo(() => {
    void failureEpoch // 依赖：推送到达时重算
    const last = [...events].reverse().find((e) => e.type === 'turn/end')
    if (last?.type === 'turn/end') return last.data.reason === 'error'
    return historyTurnFailed
  }, [events, failureEpoch, historyTurnFailed])

  const shownError = error ?? (lastTurnFailed ? t('这一轮没能跑起来。请检查模型配置（密钥、接口地址、模型名）。') : null)
  const toolResults = useMemo(() => {
    const result = new Map<string, { readonly result: ToolCardResult; readonly seq: number }>()
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      result.set(event.data.message.toolCallId, {
        result: {
          message: event.data.message,
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
          ...(event.data.error === undefined ? {} : { error: event.data.error }),
        },
        seq: event.seq,
      })
    }
    return result
  }, [events])
  const approvalDecisions = useMemo(() => {
    const decisions = new Map<string, ApprovalDecision>()
    for (const event of events) {
      if (event.type !== 'approval/decided') continue
      decisions.set(event.data.callId, { result: event.data.result, decidedBy: event.data.decidedBy })
    }
    return decisions
  }, [events])
  /** 固定/屏蔽标记：last-write-wins，和主进程的投影规则一致 */
  const markers = useMemo(() => {
    const map = new Map<number, { muted: boolean; pinned: boolean }>()
    for (const event of events) {
      if (event.type !== 'context/turn-marker') continue
      const previous = map.get(event.data.targetSeq) ?? { muted: false, pinned: false }
      map.set(event.data.targetSeq, {
        muted: event.data.muted ?? previous.muted,
        pinned: event.data.pinned ?? previous.pinned,
      })
    }
    return map
  }, [events])
  /** 压缩摘要是"旧历史的替身"，按表面渲染在顶部，不再伪装成最新提问 */
  const visibleSummary = useMemo(() => {
    try {
      const items = deriveVisibleSurfaceItems(events)
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index]
        if (item === undefined) continue
        const text = blocksToText(item.message.content)
        if (isSummaryText(text)) return text.slice('[Conversation summary]'.length).trim()
      }
      return null
    } catch {
      return null
    }
  }, [events])
  const timeline = useMemo(
    () => events.filter((event) =>
      (event.type === 'user/message' && !isSummaryText(blocksToText(event.data.content))) ||
      event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'approval/asked'),
    [events],
  )
  /** 按用户消息切轮：同一轮的工具调用、审批与中间回复归入「执行过程」 */
  const blocks = useMemo(() => {
    const out: { key: string; user: SessionEvent | null; events: SessionEvent[] }[] = []
    let current: (typeof out)[number] | null = null
    for (const event of timeline) {
      if (event.type === 'user/message') {
        current = { key: `turn-${event.seq}`, user: event, events: [] }
        out.push(current)
        continue
      }
      if (current === null) {
        current = { key: `turn-${event.seq}`, user: null, events: [] }
        out.push(current)
      }
      current.events.push(event)
    }
    return out
  }, [timeline])
  const hiddenCount = Math.max(0, blocks.length - visibleLimit)
  const visibleBlocks = hiddenCount === 0 ? blocks : blocks.slice(hiddenCount)
  const lastUserSeq = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const user = blocks[index]?.user
      if (user !== null && user !== undefined) return user.seq
    }
    return null
  }, [blocks])
  /** 最后一轮没有调过工具时允许“原样重试”，避免把工具副作用再执行一遍 */
  const retryable = useMemo(() => {
    if (running || sendingEdit) return false
    let end = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/end') {
        end = index
        break
      }
    }
    if (end < 0) return false
    let start = -1
    for (let index = end - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start') {
        start = index
        break
      }
    }
    if (start < 0) return false
    const turnEvents = events.slice(start, end + 1)
    if (turnEvents.some((event) => event.type === 'tool/call')) return false
    return turnEvents.filter((event) => event.type === 'user/message').length === 1
  }, [events, running, sendingEdit])

  const messageText = (event: SessionEvent): string => {
    if (event.type === 'user/message') return blocksToText(event.data.content)
    if (event.type === 'assistant/message') return blocksToText(event.data.message.content)
    return ''
  }

  const copyText = (text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast(t('已复制')))
      .catch(() => undefined)
  }

  const setMarker = (seq: number, patch: { readonly pinned?: boolean; readonly muted?: boolean }): void => {
    const api = bridge()
    if (api === undefined || running) return
    void api
      .marker({ session_id: sessionId, target_seq: seq, ...patch })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('无法修改轮次标记')))
  }

  const branchFrom = (seq: number): void => {
    const api = bridge()
    if (api === undefined || running) return
    // 切点必须落在轮之前：用户消息本身前面紧跟着 turn/start，直接拿它的 seq 会切在未闭合轮内
    let boundary = seq
    const index = events.findIndex((event) => event.seq === seq)
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (events[cursor]?.type === 'turn/start') {
        boundary = events[cursor]!.seq
        break
      }
    }
    void api
      .fork({ source_session_id: sessionId, boundary })
      .then((result) => {
        notifySessionChanged()
        toast(t('已从这轮之前创建分支'))
        navigate(`/sessions/${result.session_id}`)
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : t('无法从这轮创建分支')))
  }

  const submitEdit = ({ attachments, skills, images }: ComposerSendInput): void => {
    const text = draft.trim()
    const seq = editingSeq
    if ((text === '' && images.length === 0 && attachments.length === 0) || seq === null || sendingEdit) return
    const api = bridge()
    if (api === undefined) return
    setSendingEdit(true)
    setRunning(true)
    void api
      .rewindSend({
        session_id: sessionId,
        to_seq: seq,
        text,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(skills.length === 0 ? {} : { skills }),
        ...(images.length === 0 ? {} : { images }),
      })
      .then((result) => {
        setEditingSeq(null)
        setDraft('')
        setEditSeed({ attachments: [], images: [], skills: [] })
        if (result.rewind.unrestored.length > 0) {
          toast(t('有 {n} 个文件无法回退，已请模型重新生成', { n: result.rewind.unrestored.length }))
        } else if (result.rewind.restored.length > 0 || result.rewind.removed.length > 0) {
          toast(t('已撤回上一轮的文件改动'))
        }
      })
      .catch((err: unknown) => {
        setRunning(false)
        toast(err instanceof Error ? err.message : t('重新发送失败'))
      })
      .finally(() => {
        setSendingEdit(false)
        // 截断可能已经发生（哪怕后续发送失败）：重新 open 一次，内存里别留着旧轮次
        onRewound?.()
        setReloadEpoch((n) => n + 1)
      })
  }

  const retryLastTurn = (): void => {
    const api = bridge()
    if (api === undefined || running) return
    setRunning(true)
    void api
      .retryTurn({ session_id: sessionId })
      .catch((err: unknown) => {
        setRunning(false)
        toast(err instanceof Error ? err.message : t('重试失败'))
      })
      .finally(() => {
        // 截断可能已经发生（哪怕后续发送失败）：重新 open，内存里别留着旧轮次
        onRewound?.()
        setReloadEpoch((n) => n + 1)
      })
  }

  const handledRetrySignalRef = useRef(0)
  useEffect(() => {
    if (retrySignal === undefined || retrySignal === handledRetrySignalRef.current) return
    handledRetrySignalRef.current = retrySignal
    if (running) {
      toast(t('任务进行中，暂时无法重试'))
      return
    }
    if (!retryable) {
      toast(t('这一轮执行过工具，无法直接重试，请编辑后重发'))
      return
    }
    retryLastTurn()
  }, [retrySignal])

  /** 进入原位编辑：文本、附件、图片、技能一起带回输入区。 */
  const beginEdit = async (event: SessionEvent): Promise<void> => {
    if (event.type !== 'user/message') return
    const content = event.data.content
    const blocks = typeof content === 'string' ? [] : content
    const skills = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'skill' }> => block.type === 'skill')
      .map((block) => block.id)
    const attachments: Attachment[] = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'file-ref' }> => block.type === 'file-ref')
      .map((block) => ({ path: block.path, kind: block.kind }))
    const images: ImageAttachment[] = []
    for (const block of blocks) {
      if (block.type === 'image') {
        images.push({ mediaType: block.mediaType, data: block.data })
        continue
      }
      if (block.type !== 'image-ref') continue
      const api = attachmentBridge()
      if (api === undefined) continue
      try {
        const result = await api.read({ hash: block.hash, media_type: block.mediaType })
        images.push({ mediaType: result.media_type, data: result.data })
      } catch {
        toast(t('图片附件已清理，重发时不会再带上'))
      }
    }
    setDraft(blocksToText(content))
    setEditSeed({ attachments, images, skills })
    setEditingSeq(event.seq)
  }

  const renderMessage = (event: SessionEvent) => {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return null
    const text = messageText(event)
    const content = event.type === 'user/message' ? event.data.content : event.data.message.content
    const blocks = typeof content === 'string' ? [] : content
    const skills = blocks.filter((block): block is Extract<ContentBlock, { type: 'skill' }> => block.type === 'skill')
    const files = blocks.filter((block): block is Extract<ContentBlock, { type: 'file-ref' }> => block.type === 'file-ref')
    const images = blocks.filter(isImageBlock)
    if (text === '' && skills.length === 0 && files.length === 0 && images.length === 0) return null
    const role = event.type === 'user/message' ? 'user' : 'assistant'
    const isLatestUser = event.type === 'user/message' && event.seq === lastUserSeq && !running
    // 富消息也能编辑：图片/技能会被带进输入区，不会在重发时丢掉
    const latestUser = isLatestUser
    const editing = event.type === 'user/message' && editingSeq === event.seq
    const marker = event.type === 'user/message' ? markers.get(event.seq) : undefined
    // 固定/屏蔽/分支对每一轮都可操作；编辑与重试仍只针对最新一轮
    const showActions = event.type === 'user/message' && !editing && !running
    return (
      <div
        className={`ssmsg ss-${role}${editing ? ' editing' : ''}${marker?.muted === true ? ' ss-muted' : ''}`}
        key={`message-${event.seq}`}
      >
        {editing ? null : (
          <div className="ssbody">
            {files.length > 0 ? (
              <div className="ssfiles">
                {files.map((file) => (
                  <span
                    className={'ssfile' + (file.truncated === true ? ' cut' : '')}
                    key={`${file.path}-${file.kind}`}
                    title={file.truncated === true ? t('{path}（内容过长，已截断；模型可用工具继续读取）', { path: file.path }) : file.path}
                  >
                    {file.kind === 'folder' ? '📁' : '📄'} {file.name}
                    {file.truncated === true ? ' · ' + t('已截断') : ''}
                  </span>
                ))}
              </div>
            ) : null}
            {skills.length > 0 ? (
              <div className="ssskills">
                {skills.map((skill) => <span className="sskill" key={skill.id}>⚡ {skill.name}</span>)}
              </div>
            ) : null}
            {text !== '' ? <Markdown text={text} /> : null}
            {images.length > 0 ? (
              <div className="ssimages">
                {images.map((image, index) => (
                  <AttachmentImage key={`${index}-${image.mediaType}-${image.type === 'image' ? image.data.length : image.hash.slice(0, 8)}`} block={image} />
                ))}
              </div>
            ) : null}
            {marker?.muted === true || marker?.pinned === true ? (
              <div className="ssmarks">
                {marker.muted === true ? <span className="ssmark muted">{t('已屏蔽 · 不进入模型上下文')}</span> : null}
                {marker.pinned === true ? <span className="ssmark pinned">{t('已固定 · 不可被压缩')}</span> : null}
              </div>
            ) : null}
          </div>
        )}
        {showActions && (
          <div className="ss-actions">
            <button
              type="button"
              className={'ss-icon' + (marker?.pinned === true ? ' active' : '')}
              title={marker?.pinned === true ? t('取消固定') : t('固定这一轮（压缩时保留）')}
              aria-label={t('固定这一轮')}
              onClick={() => setMarker(event.seq, { pinned: marker?.pinned !== true })}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M9.5 2.5l4 4-2.2.6-2.4 2.4.3 2.4-1.2 1.2-4.4-4.4 1.2-1.2 2.4.3 2.4-2.4.9-2.9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <path d="M5.4 10.6L2.5 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={'ss-icon' + (marker?.muted === true ? ' active' : '')}
              title={marker?.muted === true ? t('取消屏蔽') : t('屏蔽这一轮（不再发给模型，仍保留记录）')}
              aria-label={t('屏蔽这一轮')}
              onClick={() => setMarker(event.seq, { muted: marker?.muted !== true })}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.2" />
                {marker?.muted === true ? <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /> : null}
              </svg>
            </button>
            <button
              type="button"
              className="ss-icon"
              title={t('从这轮之前创建分支')}
              aria-label={t('从这轮之前创建分支')}
              onClick={() => branchFrom(event.seq)}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <circle cx="4.5" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="11.5" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="4.5" cy="12.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4.5 5v6M11.5 5v2.5a4 4 0 01-4 4H4.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            {retryable && isLatestUser ? (
              <button type="button" className="ss-icon" title={t('重试本轮')} aria-label={t('重试本轮')} onClick={retryLastTurn}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M12.5 6.2A5 5 0 103 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  <path d="M12.5 2.8v3.7H8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            {latestUser ? (
              <button
                type="button"
                className="ss-icon"
                title={t('编辑')}
                onClick={() => void beginEdit(event)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M10.8 2.7l2.5 2.5M3 13l.7-3 7.6-7.6a.9.9 0 011.3 0l1 1a.9.9 0 010 1.3L6 12.3l-3 .7z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            <button type="button" className="ss-icon" title={t('复制')} onClick={() => copyText(text)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          </div>
        )}
        {editing && (
          <div className="ss-edit">
            <div className="cin">
              <ComposerBar
                value={draft}
                onChange={setDraft}
                onSend={submitEdit}
                onCancel={() => {
                  setEditingSeq(null)
                  setDraft('')
                }}
                sendTitle="重新发送"
                placeholder={t('修改后发送：会撤回上一轮并重新执行')}
                hint={t('会撤回这一轮的模型回复与文件改动，然后重新开始')}
                initialImages={editSeed.images}
                initialSkills={editSeed.skills}
                initialAttachments={editSeed.attachments}
                enableSlash={false}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderProcessEvent = (event: SessionEvent) => {
    if (event.type === 'tool/call') {
      const finished = toolResults.get(event.data.callId)
      const call: ToolCardCall = {
        seq: event.seq,
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
        ...(event.data.card === undefined ? {} : { card: event.data.card }),
      }
      return <ToolCard key={`tool-${event.seq}`} sessionId={sessionId} call={call} result={finished?.result} resultSeq={finished?.seq} />
    }
    if (event.type === 'approval/asked') {
      return (
        <ApprovalCard
          key={`approval-${event.seq}`}
          callId={event.data.callId}
          action={event.data.action}
          basis={event.data.basis}
          impact={event.data.impact}
          decision={approvalDecisions.get(event.data.callId)}
        />
      )
    }
    return renderMessage(event)
  }

  return (
    <div
      className="sessionstream"
      ref={scrollerRef}
    >
      {shownError !== null && <div className="sserror">{shownError}</div>}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="ssmore"
          onClick={() => {
            anchorRef.current = scrollerRef.current?.scrollHeight ?? null
            setVisibleLimit((n) => n * 2)
          }}
        >
          {t('加载更早的 {n} 轮', { n: Math.min(hiddenCount, visibleLimit) })}
        </button>
      )}
      {visibleSummary !== null ? (
        <details className="ssctxsummary">
          <summary>{t('上下文摘要（较早历史已压缩）')}</summary>
          <Markdown text={visibleSummary} />
        </details>
      ) : null}
      {blocks.length === 0 && !streamingActive && shownError === null && (
        <div className="ssempty">{t('还没有内容。在下面输入一句话开始。')}</div>
      )}
      {visibleBlocks.map((block, index) => {
        const isLast = index === visibleBlocks.length - 1
        const blockRunning = isLast && running
        /** 正在编辑这一轮：隐藏它的执行过程与回复——它们马上会被撤回 */
        const editingTurn =
          block.user !== null && editingSeq !== null && block.user.seq === editingSeq
        const final =
          [...block.events]
            .reverse()
            .find(
              (event) => event.type === 'assistant/message' && blocksToText(event.data.message.content) !== '',
            ) ?? null
        const process = block.events.filter((event) => final === null || event.seq !== final.seq)
        const open = openBlocks[block.key] ?? blockRunning
        return (
          <div className="turn" key={block.key}>
            {block.user !== null ? renderMessage(block.user) : null}
            {!editingTurn && process.length > 0 && (
              <button
                type="button"
                className={'turn-toggle' + (open ? ' open' : '')}
                aria-expanded={open}
                onClick={() => setOpenBlocks((prev) => ({ ...prev, [block.key]: !open }))}
              >
                <span className="chev">▸</span>
                {blockRunning ? <span className="spin" /> : null}
                <span>
                  {blockRunning
                    ? t('正在执行 · {n} 步', { n: process.length })
                    : t('执行过程 · {n} 步', { n: process.length })}
                </span>
              </button>
            )}
            {!editingTurn && process.length > 0 && open && (
              <div className="turn-process">
                <div className="turn-process-scroll">{process.map(renderProcessEvent)}</div>
              </div>
            )}
            {!editingTurn && final !== null ? renderMessage(final) : null}
          </div>
        )
      })}
      {/* 流式增量：`assistant/message` 一到就被清掉，避免与权威内容重复显示 */}
      {streamingActive && <StreamingAssistant store={streamStore} onGrow={scrollToBottomIfFollowing} />}
      {showJump && jumpPos !== null
        ? createPortal(
            <button
              type="button"
              className="jumpbottom"
              style={{ left: jumpPos.left, top: jumpPos.top }}
              title={t('回到底部')}
              aria-label={t('回到底部')}
              onClick={jumpToBottom}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v9M4.2 8.2L8 12l3.8-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>,
            document.body,
          )
        : null}
    </div>
  )
}
