import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionEvent, ModelMessage, ContentBlock } from '@lcode/session'
import { deriveMessages } from '@lcode/session'
import { t } from '../i18n/index.ts'
import { ToolCard, type ToolCardCall, type ToolCardResult } from './ToolCard.tsx'
import { ApprovalCard, type ApprovalDecision } from './ApprovalCard.tsx'

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
 * ## 一条纪律：投影用**内核的权威派生器**
 *
 * `deriveMessages(log)` 是 `@lcode/core/session` 导出的纯函数——**引擎自己用的就是它**。
 * 渲染层只需把事件按序攒起来喂进去，于是"UI 看到的"与"模型看到的"必然一致（I1 的另一半）。
 *
 * ⚠️ 不要在这边另写一份"遍历事件拼消息"的逻辑：渲染层自己拼一遍，就等于给同一个
 * 概念造了第二个实现，而它们迟早会分叉（压缩、空 assistant 消息这些边界最容易漏）。
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
}: {
  readonly sessionId: string
  /** 把"是否在运行"告诉父组件（按钮要禁用/变成停止） */
  readonly onSendStateChange?: ((running: boolean) => void) | undefined
  readonly onPausedStateChange?: ((paused: boolean) => void) | undefined
}) {
  /** 全部事件（open 时的历史 + 事件流推来的增量）——投影的唯一输入 */
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
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
  const bottomRef = useRef<HTMLDivElement>(null)

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
        setRunning(
          lastStart !== undefined &&
            (lastTurn === undefined || lastStart.seq > lastTurn.seq),
        )
        historyReady = true
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
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
        setRunning(true)
        setPaused(false)
      }
      if (event.type === 'turn/end') {
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
  }, [sessionId])

  // 自动滚到底（新内容到达时）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length, streaming])

  /** 派生消息：**内核的权威纯函数**，与引擎同源 */
  const messages = useMemo(() => deriveMessages(events), [events])

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

  return (
    <div className="sessionstream">
      {shownError !== null && <div className="sserror">{shownError}</div>}
      {messages.length === 0 && streaming === '' && shownError === null && (
        <div className="ssempty">{t('还没有内容。在下面输入一句话开始。')}</div>
      )}
      {timeline.map((event) => {
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
        const message = event.type === 'assistant/message' ? event.data.message : event.data
        const text = blocksToText(message.content)
        if (text === '' && message.role === 'assistant') return null
        return (
          <div className={`ssmsg ss-${message.role}`} key={`message-${event.seq}`}>
            <div className="ssrole">{message.role === 'user' ? t('你') : t('Lcode')}</div>
            <div className="ssbody">{text}</div>
          </div>
        )
      })}
      {/* 流式增量：`assistant/message` 一到就被清掉，避免与权威内容重复显示 */}
      {streaming !== '' && (
        <div className="ssmsg ss-assistant">
          <div className="ssrole">{t('Lcode')}</div>
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
