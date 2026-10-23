import type { AssistantMessage, ModelMessage, ToolResultMessage, UserMessage } from './types.ts'
import { SURFACE_EVENT_TYPES, type SessionEvent, type SurfaceOp } from './types.ts'

/**
 * 表面投影（文档 06 §3：表面的定义与 surface replace）。
 *
 * 表面 = 事件日志中会产生模型可见消息的有序投影，只含三类事件：
 * `user/message` / `assistant/message` / `tool/result`。
 *
 * surfaceOp: replace 是**压缩的唯一原语**（D5）——追加一条声明替换某区间的
 * surface 事件，**不做删除**：原始事实保留 ⇒ 重放确定；被替换的旧内容可展开查看。
 *
 * 派生是纯函数：同样的日志必然得到同样的结果（P1 / I1 的另一半）。
 */

export interface SurfaceItem {
  readonly message: ModelMessage
  /** 产生这条消息的事件 seq（血缘 / 定位用） */
  readonly sourceSeq: number
  /** 是否被后续 replace 隐藏 */
  readonly hidden: boolean
}

/** 当前模型真正可见的表面项。它按 `surfaceOp.replace` 的逻辑位置重建，
 * 与用于历史审计的 `deriveSurfaceItems` 区分开来。 */
export interface VisibleSurfaceItem {
  readonly message: ModelMessage
  readonly sourceSeq: number
}

/**
 * 从事件日志派生表面项序列。
 * replace 区间按**表面项索引**计（[start, end)，左闭右开），必须落在当前 surface 范围内（I4）。
 */
export function deriveSurfaceItems(log: readonly SessionEvent[]): SurfaceItem[] {
  const items: SurfaceItem[] = []
  for (const event of log) {
    if (isSurfaceEvent(event)) {
      items.push({
        message: eventToMessage(event),
        sourceSeq: event.seq,
        hidden: false,
      })
    }
    // 注意：这里**不能**写成 `else if`。压缩摘要是「user/message + surfaceOp:{op:'replace'}」
    // 的形态（06 §3.3），它既是表面事件、又携带 replace——用 else if 会让替换区间被整段忽略，
    // 于是 `hidden` 永远为 false、I4 越界也永远查不出来。
    if (isReplace(event.surfaceOp)) {
      // 校验区间（I4）：必须在当前 surface 范围内
      const { start, end } = event.surfaceOp
      if (start < 0 || end > items.length || start >= end) {
        throw new RangeError(
          `surface replace 区间越界：start=${start} end=${end} surface 长度=${items.length}（不变量 I4 违规）`,
        )
      }
      for (let i = start; i < end; i++) {
        items[i] = { ...items[i]!, hidden: true }
      }
    }
    if (isRestore(event.surfaceOp)) {
      const { start, eventSeqs } = event.surfaceOp
      if (start < 0 || start >= items.length) {
        throw new RangeError(
          `surface restore 区间越界：start=${start} surface 长度=${items.length}（不变量 I4 违规）`,
        )
      }
      // 审计视图保留"摘要曾在第 start 位"的位置，只把被撤销的原文重新标为可见
      items[start] = { ...items[start]!, hidden: true }
      const wanted = new Set(eventSeqs)
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item !== undefined && wanted.has(item.sourceSeq)) items[index] = { ...item, hidden: false }
      }
    }
    // 其它日志事件（chunk / tool/call / turn 边界等）不产生表面项
  }
  return items
}

/**
 * 重建当前可见的表面。replace 在当前可见数组中原地替换，而不是把摘要排到日志末尾。
 * 原始事件仍由 `deriveSurfaceItems` 保留为可审计的 hidden 项；模型历史和后续压缩则
 * 必须使用本函数，避免多次压缩时把已经遮蔽的事件重新计入区间。
 */
export function deriveVisibleSurfaceItems(log: readonly SessionEvent[]): readonly VisibleSurfaceItem[] {
  const items: VisibleSurfaceItem[] = []
  const bySeq = new Map<number, SessionEvent>()
  for (const event of log) if (isSurfaceEvent(event)) bySeq.set(event.seq, event)
  for (const event of log) {
    const replacement = isReplace(event.surfaceOp) ? event.surfaceOp : undefined
    if (replacement !== undefined) {
      const { start, end } = replacement
      if (start < 0 || end > items.length || start >= end) {
        throw new RangeError(
          `surface replace 区间越界：start=${start} end=${end} 当前表面长度=${items.length}（不变量 I4 违规）`,
        )
      }
      const item = isSurfaceEvent(event)
        ? [{ message: eventToMessage(event), sourceSeq: event.seq }]
        : []
      items.splice(start, end - start, ...item)
      continue
    }
    const restore = isRestore(event.surfaceOp) ? event.surfaceOp : undefined
    if (restore !== undefined) {
      const { start } = restore
      if (start < 0 || start >= items.length) {
        throw new RangeError(
          `surface restore 区间越界：start=${start} 当前表面长度=${items.length}（不变量 I4 违规）`,
        )
      }
      const restored = restore.eventSeqs.map((seq) => {
        const original = bySeq.get(seq)
        if (original === undefined) {
          throw new RangeError(`surface restore 引用了不存在的表面事件：${seq}`)
        }
        return { message: eventToMessage(original), sourceSeq: seq }
      })
      items.splice(start, 1, ...restored)
      continue
    }
    if (isSurfaceEvent(event)) {
      items.push({ message: eventToMessage(event), sourceSeq: event.seq })
    }
  }
  return items
}

/** 派生模型可见消息：隐藏项被过滤（用户最终看到的是"压缩后"的序列） */
export function deriveMessages(log: readonly SessionEvent[]): ModelMessage[] {
  return deriveVisibleSurfaceItems(log).map((item) => item.message)
}

/** 事件 → 模型可见消息（06 §4.1 投影规则：仅三类表面事件可投影，其余返回 null） */
export function deriveEventMessage(event: SessionEvent): ModelMessage | null {
  if (!isSurfaceEvent(event)) return null
  return eventToMessage(event)
}

function isSurfaceEvent(event: SessionEvent): boolean {
  return (SURFACE_EVENT_TYPES as readonly string[]).includes(event.type)
}

function isReplace(op: SurfaceOp | undefined): op is { op: 'replace'; start: number; end: number } {
  return op !== undefined && op !== 'append' && op.op === 'replace'
}

function isRestore(op: SurfaceOp | undefined): op is { op: 'restore'; start: number; eventSeqs: readonly number[] } {
  return op !== undefined && op !== 'append' && op.op === 'restore'
}

function eventToMessage(event: SessionEvent): ModelMessage {
  // SessionEventMap 是开放接口（非闭合判别联合），switch 无法自动收窄 data，需显式断言（06 §2.3）
  switch (event.type) {
    case 'user/message':
      return event.data as UserMessage
    case 'assistant/message':
      return (event.data as { readonly message: AssistantMessage }).message
    case 'tool/result':
      return (event.data as { readonly message: ToolResultMessage }).message
    /* c8 ignore next 2 -- isSurfaceEvent 只允许上面的三类事件，default 不可由当前类型流到达 */
    default:
      // 开放接口：未知类型跳过（若它标了 ignorable 或已在加载时被拒绝，06 §2.3）
      /* c8 ignore next -- isSurfaceEvent 只允许上面的三类事件 */
      throw new Error(`不可达：非表面事件 ${event.type}`)
  }
}
