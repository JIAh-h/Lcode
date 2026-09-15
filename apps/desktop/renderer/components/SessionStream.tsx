import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionEvent, ModelMessage, ContentBlock } from '@lcode/session'
import { deriveMessages } from '@lcode/session'
import { t } from '../i18n/index.ts'

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
  const lcode = (globalThis as unknown as { lcode?: { session?: SessionBridge; agent?: { send: SessionBridge['send']; cancel: SessionBridge['cancel'] } } }).lcode
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

/** 内容块 → 可显示文本（只取文本块；工具块等批次⑤ 再接卡片渲染） */
function blocksToText(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((s) => s !== '')
    .join('')
}

/**
 * 把一条工具结果压成**人能读的样子**。
 *
 * 工具结果是给**模型**的形状（JSON、字段名、转义），直接摊在界面上等于没给用户
 * 任何东西——实测见到的是一屏 `{"path":"…","lines":[{"number":1,…`。
 *
 * 所以按**已知的规范值形状**各给一种呈现（21 §3 定了这些形状，所以可以穷举）：
 * 抽不出来就退回截断的原文，而不是丢掉——看不懂也比看不见好。
 */
function toolResultSummary(message: ModelMessage): string {
  const raw = typeof message.content === 'string' ? message.content : blocksToText(message.content)
  if ('isError' in message && message.isError === true) return `⚠ ${raw.slice(0, 400)}`

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return raw.slice(0, 1200) // 不是 JSON（例如工具直接回了文本）
  }
  if (typeof value !== 'object' || value === null) return raw.slice(0, 1200)
  const v = value as Record<string, unknown>

  // read：把行号 + 内容还原成一段带行号的文本
  if (Array.isArray(v['lines'])) {
    const lines = v['lines'] as { number: number; text: string }[]
    const body = lines.map((l) => `${String(l.number).padStart(4)}  ${l.text}`).join('\n')
    const tail = v['truncated'] === true ? `\n…（共 ${String(v['totalLines'])} 行，这里只是一段）` : ''
    return `${String(v['path'])}\n${body}${tail}`
  }
  // shell：输出才是重点，退出码放最后一行
  if (v['kind'] === 'foreground') {
    const out = `${String(v['stdout'] ?? '')}${String(v['stderr'] ?? '')}`.trim()
    const notes = [v['timedOut'] === true ? '超时' : '', v['aborted'] === true ? '已中止' : ''].filter(Boolean).join(' ')
    return `${out || '（没有输出）'}\n退出码 ${String(v['exitCode'])}${notes === '' ? '' : ` · ${notes}`}`
  }
  if (typeof v['jobId'] === 'string') return `已在后台运行（作业 ${v['jobId']}）`
  // glob / grep：路径或命中列表
  if (Array.isArray(v['paths'])) {
    const paths = v['paths'] as string[]
    const more = v['truncated'] === true ? `\n…（共 ${String(v['total'])} 个，已截断）` : ''
    return `${paths.join('\n')}${more}`
  }
  if (Array.isArray(v['matches'])) {
    const rows = (v['matches'] as { path: string; line: number; text: string }[]).map(
      (m) => `${m.path}:${m.line}  ${m.text.trim()}`,
    )
    const more = v['truncated'] === true ? `\n…（共 ${String(v['total'])} 处，已截断）` : ''
    return `${rows.join('\n')}${more}`
  }
  // write / edit：一句话就好
  if (typeof v['bytesWritten'] === 'number') return `已写入 ${String(v['path'])}（${String(v['bytesWritten'])} 字节）`
  if (typeof v['applied'] === 'number') return `已修改 ${String(v['path'])}（${String(v['applied'])} 处）`

  return raw.slice(0, 1200)
}

export function SessionStream({ sessionId, onSendStateChange }: {
  readonly sessionId: string
  /** 把"是否在运行"告诉父组件（按钮要禁用/变成停止） */
  readonly onSendStateChange?: ((running: boolean) => void) | undefined
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
  /** 轮失败推送到达时递增，用来催界面重算（见 `onTurnFailed`） */
  const [failureEpoch, setFailureEpoch] = useState(0)
  /** `open()` 时主进程告诉我们"日志末尾是一个失败的轮"（历史里没有 turn/end 这种结构事件） */
  const [historyTurnFailed, setHistoryTurnFailed] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onSendStateChange?.(running)
  }, [running, onSendStateChange])

  // ── 打开会话：拿历史 + 订阅事件流 ──
  useEffect(() => {
    const api = bridge()
    if (api === undefined) {
      setError(t('当前环境没有主进程桥（开发预览或浏览器里打开时会这样）'))
      return
    }
    let alive = true
    setEvents([])
    setStreaming('')
    setHistoryTurnFailed(false)

    void api
      .open(sessionId)
      .then((opened) => {
        if (!alive) return
        setHistoryTurnFailed(opened.last_turn_errored === true)
        // 历史只给"派生好的消息"，但投影要用事件——所以这里把消息再摊回**表面事件**，
        // 保持"投影的唯一输入是事件序列"这条原则（而不是两套输入混着用）。
        setEvents(
          opened.history.messages.map((message, index) => messageToEvent(message, index)),
        )
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })

    const stopEvent = api.onEvent((payload) => {
      const record = payload as { session_id?: string; event?: SessionEvent }
      if (!alive || record.session_id !== sessionId || record.event === undefined) return
      const event = record.event
      setEvents((prev) => [...prev, event])
      // 事件落地后清掉流式缓冲：`assistant/message` 才是权威（06 §4.1 的不对称）
      if (event.type === 'assistant/message') setStreaming('')
      if (event.type === 'turn/end') {
        setRunning(false)
        setStreaming('')
      }
    })

    const stopChunks = api.onChunks((payload) => {
      const record = payload as { session_id?: string; chunks?: readonly { type: string; text?: string }[] }
      if (!alive || record.session_id !== sessionId || record.chunks === undefined) return
      setRunning(true)
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

  return (
    <div className="sessionstream">
      {shownError !== null && <div className="sserror">{shownError}</div>}
      {messages.length === 0 && streaming === '' && shownError === null && (
        <div className="ssempty">{t('还没有内容。在下面输入一句话开始。')}</div>
      )}
      {messages.map((message, index) => {
        /*
         * 工具结果在派生历史里也是 `role: 'user'`（那是给**模型**看的形状——
         * 协议要求工具结果以 user 角色回传）。但界面上它**不是**用户说的话：
         *
         * - 用户输入 → 显示（那是他的话）
         * - 工具结果 → 显示成"过程记录"（那是它干活的过程，而且原始 JSON 对用户没意义）
         *
         * 不区分的后果实测见过：界面上一串 "你: {"path":"…","lines":[…]}…"，
         * 看起来像用户在往外贴 JSON。那不是 UI 不够漂亮，那是**说错了话**。
         */
        const isToolResult = message.role === 'user' && 'toolCallId' in message
        const text = isToolResult ? toolResultSummary(message) : blocksToText(message.content)
        if (text === '' && message.role === 'assistant') return null
        if (isToolResult) {
          return (
            <div className="ssmsg ss-tool" key={`${index}-tool`}>
              <div className="ssrole">{t('过程记录')}</div>
              <div className="ssbody">{text}</div>
            </div>
          )
        }
        return (
          <div className={`ssmsg ss-${message.role}`} key={`${index}-${message.role}`}>
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

/**
 * 把派生消息**摊回一个表面事件**。
 *
 * 为什么要这么绕：`sessions.open` 给的是派生后的消息（那是读路径的方便形态），
 * 但本组件的投影输入必须**只有事件序列**一种。与其在这里混两套输入（未来必然分叉），
 * 不如把消息还原成等价的事件形态——它只影响 index/展示，不参与任何持久化。
 */
function messageToEvent(message: ModelMessage, index: number): SessionEvent {
  if (message.role === 'user') {
    return { type: 'user/message', seq: -1 - index, time: 0, data: message } as unknown as SessionEvent
  }
  if (message.role === 'assistant') {
    return {
      type: 'assistant/message',
      seq: -1 - index,
      time: 0,
      data: { turn: 0, step: 0, message },
    } as unknown as SessionEvent
  }
  return {
    type: 'tool/result',
    seq: -1 - index,
    time: 0,
    data: { turn: 0, step: 0, message },
  } as unknown as SessionEvent
}
