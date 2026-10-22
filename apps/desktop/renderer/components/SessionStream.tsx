import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionEvent, ModelMessage, ContentBlock } from '@lcode/session'
import { t } from '../i18n/index.ts'
import { Markdown } from './Markdown.tsx'
import { toast } from './toast.ts'
import { ToolCard, type ToolCardCall, type ToolCardResult } from './ToolCard.tsx'
import { ApprovalCard, type ApprovalDecision } from './ApprovalCard.tsx'
import { ComposerBar, withAttachments, type Attachment } from './ComposerBar.tsx'

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
  }
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
  onSendStateChange,
  onPausedStateChange,
  onRewound,
}: {
  readonly sessionId: string
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
  const [streaming, setStreaming] = useState<string>('')
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
  const [sendingEdit, setSendingEdit] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** 视口是否贴底；用户向上翻阅历史时为 false，新事件不再强制滚动 */
  const stickRef = useRef(true)
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
    setEvents([])
    setStreaming('')
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
      if (event.type === 'assistant/message') setStreaming('')
      if (event.type === 'turn/start') {
        liveTurnRef.current = true
        setRunning(true)
        setPaused(false)
      }
      if (event.type === 'turn/end') {
        liveTurnRef.current = false
        setRunning(false)
        setStreaming('')
        setPaused(event.data.reason === 'cancelled')
      }
    })

    const stopChunks = api.onChunks((payload) => {
      const record = payload as {
        session_id?: string
        chunks?: readonly { type: string; text?: string }[]
      }
      if (!alive || record.session_id !== sessionId || record.chunks === undefined) return
      // 迟到的批次不再属于任何开着的轮：丢掉，别把已收尾的轮重新点亮
      if (!liveTurnRef.current) return
      setRunning(true)
      setPaused(false)
      const text = record.chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.text ?? '')
        .join('')
      if (text !== '') setStreaming((prev) => prev + text)
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
      setStreaming('')
      setFailureEpoch((n) => n + 1)
    })

    return () => {
      alive = false
      stopEvent()
      stopChunks()
      stopFailed()
    }
  }, [sessionId, reloadEpoch])

  // 自动滚到底（新内容到达时）；用户向上翻阅历史时不打断
  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length, streaming])

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
  const timeline = useMemo(
    () => events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'approval/asked'),
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

  const submitEdit = (attachments: readonly Attachment[] = []): void => {
    const text = draft.trim()
    const seq = editingSeq
    if (text === '' || seq === null || sendingEdit) return
    const api = bridge()
    if (api === undefined) return
    setSendingEdit(true)
    setRunning(true)
    void api
      .rewindSend({ session_id: sessionId, to_seq: seq, text: withAttachments(text, attachments) })
      .then((result) => {
        setEditingSeq(null)
        setDraft('')
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

  const renderMessage = (event: SessionEvent) => {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return null
    const text = messageText(event)
    if (text === '') return null
    const role = event.type === 'user/message' ? 'user' : 'assistant'
    const latestUser = event.type === 'user/message' && event.seq === lastUserSeq && !running
    const editing = event.type === 'user/message' && editingSeq === event.seq
    return (
      <div
        className={`ssmsg ss-${role}${editing ? ' editing' : ''}`}
        key={`message-${event.seq}`}
      >
        {editing ? null : (
          <div className="ssbody">
            <Markdown text={text} />
          </div>
        )}
        {latestUser && !editing && (
          <div className="ss-actions">
            <button
              type="button"
              className="ss-icon"
              title={t('编辑')}
              onClick={() => {
                setDraft(text)
                setEditingSeq(event.seq)
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M10.8 2.7l2.5 2.5M3 13l.7-3 7.6-7.6a.9.9 0 011.3 0l1 1a.9.9 0 010 1.3L6 12.3l-3 .7z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
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
                onSend={(attachments) => submitEdit(attachments)}
                onCancel={() => {
                  setEditingSeq(null)
                  setDraft('')
                }}
                sendTitle="重新发送"
                placeholder={t('修改后发送：会撤回上一轮并重新执行')}
                hint={t('会撤回这一轮的模型回复与文件改动，然后重新开始')}
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
      onScroll={(event) => {
        const el = event.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
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
      {blocks.length === 0 && streaming === '' && shownError === null && (
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
            {!editingTurn && process.length > 0 && open && <div className="turn-process">{process.map(renderProcessEvent)}</div>}
            {!editingTurn && final !== null ? renderMessage(final) : null}
          </div>
        )
      })}
      {/* 流式增量：`assistant/message` 一到就被清掉，避免与权威内容重复显示 */}
      {streaming !== '' && (
        <div className="ssmsg ss-assistant">
          <div className="ssbody">
            {streaming}
            <span className="sscursor" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
