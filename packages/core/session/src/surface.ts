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
    } else if (isReplace(event.surfaceOp)) {
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
    // 其它日志事件（chunk / tool/call / turn 边界等）不产生表面项
  }
  return items
}

/** 派生模型可见消息：隐藏项被过滤（用户最终看到的是"压缩后"的序列） */
export function deriveMessages(log: readonly SessionEvent[]): ModelMessage[] {
  return deriveSurfaceItems(log)
    .filter((item) => !item.hidden)
    .map((item) => item.message)
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

function eventToMessage(event: SessionEvent): ModelMessage {
  // SessionEventMap 是开放接口（非闭合判别联合），switch 无法自动收窄 data，需显式断言（06 §2.3）
  switch (event.type) {
    case 'user/message':
      return event.data as UserMessage
    case 'assistant/message':
      return (event.data as { readonly message: AssistantMessage }).message
    case 'tool/result':
      return (event.data as { readonly message: ToolResultMessage }).message
    default:
      // 开放接口：未知类型跳过（若它标了 ignorable 或已在加载时被拒绝，06 §2.3）
      throw new Error(`不可达：非表面事件 ${event.type}`)
  }
}
