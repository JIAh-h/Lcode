import { useReducer } from 'react'
import type { SessionEvent, SessionEventType, ModelMessage } from '@lcode/session'

/**
 * 事件投影 store（文档 10 §3 / 05 §3.1：renderer 是纯投影）。
 * 消费 main 进程广播的 `session/event`，用纯 reducer 投影出视图状态；
 * 同一份日志必然渲染出完全相同的历史（可重放）。
 *
 * 骨架版提供 reducer 结构；真实事件流经 preload 的 IPC（21 §2.13）在批次 ⑦/⑧ 接入。
 */

export interface SessionViewState {
  readonly events: readonly SessionEvent[]
  /** 派生消息历史（surface 投影，含压缩后的可见序列） */
  readonly messages: readonly ModelMessage[]
  readonly activeSeq: number | undefined
}

type SessionAction =
  | { readonly type: 'event-appended'; readonly event: SessionEvent }
  | { readonly type: 'load'; readonly events: readonly SessionEvent[] }
  | { readonly type: 'select-seq'; readonly seq: number | undefined }

const SURFACE_TYPES: readonly SessionEventType[] = ['user/message', 'assistant/message', 'tool/result']

export function deriveMessagesFrom(events: readonly SessionEvent[]): readonly ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const event of events) {
    if (!(SURFACE_TYPES as readonly string[]).includes(event.type)) continue
    if (event.type === 'user/message') messages.push(event.data as ModelMessage)
    else if (event.type === 'assistant/message') {
      messages.push((event.data as { message: ModelMessage }).message)
    } else if (event.type === 'tool/result') {
      messages.push((event.data as { message: ModelMessage }).message)
    }
  }
  return messages
}

export function sessionReducer(state: SessionViewState, action: SessionAction): SessionViewState {
  switch (action.type) {
    case 'load':
      return { ...state, events: action.events, messages: deriveMessagesFrom(action.events) }
    case 'event-appended': {
      const events = [...state.events, action.event]
      return { ...state, events, messages: deriveMessagesFrom(events) }
    }
    case 'select-seq':
      return { ...state, activeSeq: action.seq }
    default:
      return state
  }
}

export const initialSessionState: SessionViewState = {
  events: [],
  messages: [],
  activeSeq: undefined,
}

export function useSessionStore() {
  return useReducer(sessionReducer, initialSessionState)
}
