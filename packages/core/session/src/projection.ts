import type { ModelMessage, SessionEvent } from './types.ts'
import { deriveVisibleSurfaceItems, type VisibleSurfaceItem } from './surface.ts'

/** 一轮上下文在用户侧的两个显式标记；都是 last-write-wins。 */
export interface TurnMarker {
  readonly muted: boolean
  readonly pinned: boolean
}

export interface RequestProjectionOptions {
  /**
   * 本轮 `turn/start` 的 seq。低于它的 skill 块属于历史轮次，不再发送。
   * 不传则保持原样（预算/只读检查用）。
   */
  readonly activeFromSeq?: number | undefined
}

/**
 * 从日志取轮次标记。只认用户消息 seq；未知目标的标记不会影响任何一轮。
 */
export function deriveTurnMarkers(log: readonly SessionEvent[]): ReadonlyMap<number, TurnMarker> {
  const markers = new Map<number, TurnMarker>()
  for (const event of log) {
    if (event.type !== 'context/turn-marker') continue
    const previous = markers.get(event.data.targetSeq) ?? { muted: false, pinned: false }
    markers.set(event.data.targetSeq, {
      muted: event.data.muted ?? previous.muted,
      pinned: event.data.pinned ?? previous.pinned,
    })
  }
  return markers
}

/**
 * 模型真正应看到的表面：可见表面再叠加"屏蔽的轮次"和"历史技能剥离"。
 *
 * 屏蔽以**整轮**为单位：从该用户提问起，到下一个用户提问之前的所有助手回复、
 * 工具调用结果一起丢弃。只丢用户消息而留下工具结果会让请求出现没有配对的
 * tool result，Provider 会直接拒绝。
 */
export function deriveRequestItems(
  log: readonly SessionEvent[],
  options: RequestProjectionOptions = {},
): readonly VisibleSurfaceItem[] {
  const items = deriveVisibleSurfaceItems(log)
  const markers = deriveTurnMarkers(log)
  const keep = new Array<boolean>(items.length).fill(true)

  let spanStart = 0
  let targetSeq: number | null = isUserPrompt(items[0]?.message) ? (items[0]?.sourceSeq ?? null) : null
  const closeSpan = (end: number): void => {
    if (end <= spanStart) return
    const marker = targetSeq === null ? undefined : markers.get(targetSeq)
    if (marker?.muted === true) {
      for (let index = spanStart; index < end; index += 1) keep[index] = false
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined || !isUserPrompt(item.message)) continue
    closeSpan(index)
    spanStart = index
    targetSeq = item.sourceSeq
  }
  closeSpan(items.length)

  const activeFromSeq = options.activeFromSeq
  return items.flatMap((item, index) => {
    if (keep[index] !== true) return []
    const message =
      activeFromSeq !== undefined && item.sourceSeq < activeFromSeq
        ? withoutSkills(item.message)
        : item.message
    return [{ message, sourceSeq: item.sourceSeq }]
  })
}

export function isUserPrompt(message: ModelMessage | undefined): boolean {
  return message !== undefined && message.role === 'user' && typeof (message as { readonly toolCallId?: unknown }).toolCallId !== 'string'
}

function withoutSkills(message: ModelMessage): ModelMessage {
  if (typeof message.content === 'string') return message
  const content = message.content.filter((block) => block.type !== 'skill')
  return content.length === message.content.length ? message : { ...message, content }
}
