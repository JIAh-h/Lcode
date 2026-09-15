import type { SessionIndexSink, SessionLogSnapshot } from '@lcode/session-persistence-jsonl'
import type BetterSqlite3 from 'better-sqlite3'
import { openIndexDb } from './db.ts'
import { applyProjection, projectSession } from './project.ts'

/**
 * write-behind 通道（文档 22 §1.2；实施计划 T3.1）。
 *
 * 三条硬性要求，全部来自 22 §1.2 / 11 §5.4：
 * 1. **不阻塞会话**：`onSessionFlushed()` 同步入队即返回，索引写入在微任务里做；
 * 2. **可失败、可重试**：写索引失败按指数退避重试若干次，仍失败则上报并**丢弃**
 *    （索引是派生的，`lcode index rebuild` 能补回来——这正是它可丢的代价换来的自由）；
 * 3. **有界**：队列按会话合并（同一会话只留**最新**快照），因此长度上界是会话数，
 *    不会因为高频 append 而无限增长。
 *
 * "按会话合并"还带来一个正确性红利：投影是**整会话重算**的，晚到的快照覆盖早到的，
 * 所以即使中间几次 flush 被丢掉，只要最后一次落库，索引就是完整的。
 */

export interface IndexWriterOptions {
  readonly home: string
  /** 最大重试次数（默认 3），超过后上报并丢弃该会话快照 */
  readonly maxAttempts?: number | undefined
  /** 退避基数（默认 50ms） */
  readonly retryBaseMs?: number | undefined
  readonly onError?: ((err: unknown, sessionId: string) => void) | undefined
  /** 注入连接（测试用）；不传则由 `home` 懒开 */
  readonly db?: BetterSqlite3.Database | undefined
  readonly now?: (() => number) | undefined
}

export class SessionIndexWriter implements SessionIndexSink {
  private readonly options: IndexWriterOptions
  private readonly queue = new Map<string, SessionLogSnapshot>()
  private readonly attempts = new Map<string, number>()
  private waiters: (() => void)[] = []
  private running = false
  private scheduled = false
  private closed = false
  private lastError: unknown = null
  private droppedSessions = 0

  constructor(options: IndexWriterOptions) {
    this.options = options
  }

  /** 同步入队、立即返回——**绝不**让调用方等磁盘（22 §1.2） */
  onSessionFlushed(snapshot: SessionLogSnapshot): void {
    if (this.closed) return
    this.queue.set(snapshot.sessionId, snapshot)
    this.schedule()
  }

  get pendingCount(): number {
    return this.queue.size
  }

  get lastFailure(): unknown {
    return this.lastError
  }

  /** 因重试耗尽而被丢弃的快照数（索引可丢，但丢弃要可见） */
  get dropped(): number {
    return this.droppedSessions
  }

  /** 等待队列排空（测试/退出前用；产品路径不调用它） */
  async drain(): Promise<void> {
    if (this.queue.size === 0 && !this.running) return
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  async close(): Promise<void> {
    await this.drain()
    this.closed = true
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      void this.drainOnce()
    })
  }

  private resolveIfIdle(): void {
    if (this.queue.size > 0 || this.running) return
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  private async drainOnce(): Promise<void> {
    if (this.running || this.closed) return
    this.running = true
    try {
      while (this.queue.size > 0 && !this.closed) {
        const next = this.queue.entries().next()
        if (next.done === true) break
        const [sessionId, snapshot] = next.value
        this.queue.delete(sessionId)
        try {
          const db = this.options.db ?? openIndexDb({ home: this.options.home })
          const indexedAt = this.options.now?.() ?? snapshot.indexedAt
          applyProjection(
            db,
            projectSession({
              sessionId: snapshot.sessionId,
              header: snapshot.header,
              events: snapshot.events,
              spans: snapshot.spans,
              revision: snapshot.revision,
              bytes: snapshot.bytes,
              indexedAt,
            }),
          )
          this.attempts.delete(sessionId)
        } catch (err) {
          this.lastError = err
          const attempt = (this.attempts.get(sessionId) ?? 0) + 1
          const maxAttempts = this.options.maxAttempts ?? 3
          if (attempt <= maxAttempts) {
            this.attempts.set(sessionId, attempt)
            const base = this.options.retryBaseMs ?? 50
            await new Promise<void>((resolve) => setTimeout(resolve, base * 2 ** (attempt - 1)))
            // 重投：把**当前**最新快照放回去（若期间又来了新快照，它已经在队列里，这里不覆盖）
            if (!this.queue.has(sessionId)) this.queue.set(sessionId, snapshot)
          } else {
            this.attempts.delete(sessionId)
            this.droppedSessions += 1
            this.options.onError?.(err, sessionId)
          }
        }
      }
    } finally {
      this.running = false
      this.resolveIfIdle()
    }
  }
}
