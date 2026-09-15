import type { AppendedEvent, EventInput, SessionEvent, SessionEventType, SessionService } from '@lcode/session'
import type { JsonlSessionPersistence } from '@lcode/session-persistence-jsonl'
import type { SessionId } from '@lcode/util'

/**
 * 持久化会话：把内存日志（InMemorySessionStore）与 JSONL 权威真相缝在一起。
 *
 * 引擎（agent-loop）直接对 `SessionService.append` 追加事件——如果只给它裸的
 * `InMemorySessionStore`，这些事件**永远不会落盘**。这个封装在 `append` /
 * `appendMany` 之后**写穿**到 JSONL（write-behind，不 await 磁盘，06 §5.3 热路径纪律），
 * 其余方法全部委托给内层 store。
 *
 * 用于 T5.1（无密钥回放闭环）与 T5.3（桌面主进程持有 runtime：event 落内存的同时
 * 也进权威日志 → SQLite 投影）。产品侧统一从
 * `LocalSessionsApi.sessionServiceFor()` 拿本封装（它保证会话已打开）。
 *
 * 调用方须先 `persistence.open(sessionId, …)`，`flush()` 才是持久屏障。
 */
export function createPersistedSession(
  sessionId: SessionId,
  store: SessionService,
  persistence: JsonlSessionPersistence,
): SessionService {
  return {
    append<K extends SessionEventType>(input: EventInput<K>): AppendedEvent<K> {
      const event = store.append(input)
      // 写穿到权威日志：入队即返回（批写在 write-behind 内）；失败在 flush 的持久屏障处暴露
      void persistence.append(sessionId, [event as unknown as SessionEvent])
      return event
    },
    appendMany<K extends SessionEventType>(inputs: readonly EventInput<K>[]): readonly AppendedEvent<K>[] {
      const events = store.appendMany(inputs)
      void persistence.append(sessionId, events as unknown as readonly SessionEvent[])
      return events
    },
    events: (range) => store.events(range),
    deriveMessages: () => store.deriveMessages(),
    fork: (cutAtSeq) => store.fork(cutAtSeq),
    markEndSeed: () => store.markEndSeed(),
    get length(): number {
      return store.length
    },
    onEvent: (handler) => store.onEvent(handler),
  }
}
