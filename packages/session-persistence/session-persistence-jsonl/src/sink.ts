import type { EventFrame, FileHeaderFrame } from './jsonl.ts'
import type { LogRecordSpan } from './spans.ts'

/**
 * 索引侧接收口（docs/24 §5 阶段 3 的接线点）。
 *
 * **为什么放在 jsonl 包而不是契约包**：`session-persistence` 是**冻结**的接口包
 * （20 §2.3 明示"接口包里出现实现代码是架构错误"），而这个口子是 jsonl 写入侧
 * 与 sqlite 索引侧之间的**装配契约**，不属于产品 API。sqlite 包依赖 jsonl 包，
 * 因此把接口定义在这里不需要动冻结包。
 *
 * **传的是「完成态快照」而不是增量**：`IndexWriter` 据此**整会话重算**投影，
 * 于是「实时写入」与「index rebuild」走**同一个纯函数**，逐行一致是构造性保证
 * （docs/24 §5 T3.6 的出口判据）。代价是每轮 flush 重算一次会话投影——
 * 对 MVP 规模可接受，将来要换成增量时只需替换 IndexWriter 内部，契约不变。
 */

export interface SessionLogSnapshot {
  readonly sessionId: string
  /** 头部帧（`cwd` / `parentSession` / `seedLength` 等元数据的来源） */
  readonly header: FileHeaderFrame
  /** 全部事件（已解包，`seq` 连续） */
  readonly events: readonly EventFrame[]
  /** 全部记录的字节定位（含头部帧） */
  readonly spans: readonly LogRecordSpan[]
  /** 当前文件 revision（22 §4.3） */
  readonly revision: string
  /** 当前文件字节数 */
  readonly bytes: number
  /** 本次索引时间（epoch ms） */
  readonly indexedAt: number
}

export interface SessionIndexSink {
  /** 日志已过持久屏障。实现方必须**异步、可失败、可重试**，绝不阻塞会话（22 §1.2） */
  onSessionFlushed(snapshot: SessionLogSnapshot): void
}
