import { deriveMessages } from '@lcode/session'
import type { SessionEvent } from '@lcode/session'
import { performance } from 'node:perf_hooks'

/** 基准子进程：在 CLI 的 workspace 依赖环境里直接调用核心派生器。 */
const counts = [10_000, 100_000]
const results = counts.map((count) => {
  const events = makeEvents(count)
  const before = process.memoryUsage().rss
  const start = performance.now()
  const messages = deriveMessages(events)
  const elapsedMs = Number((performance.now() - start).toFixed(2))
  const after = process.memoryUsage().rss
  return {
    events: count,
    messages: messages.length,
    deriveMs: elapsedMs,
    rssDeltaMb: Number(((after - before) / 1024 / 1024).toFixed(2)),
  }
})

process.stdout.write(JSON.stringify({ results, rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)) }))

function makeEvents(count: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let seq = 0; seq < count; seq += 1) {
    if (seq % 1000 === 0) {
      events.push({
        type: 'user/message',
        seq,
        time: seq,
        data: { role: 'user', content: `benchmark request ${seq}` },
      })
    } else if (seq % 1000 === 1) {
      events.push({
        type: 'assistant/message',
        seq,
        time: seq,
        data: {
          turn: Math.floor(seq / 1000) + 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: `benchmark response ${seq}` }] },
        },
      })
    } else {
      events.push({
        type: 'request/context',
        seq,
        time: seq,
        data: { sources: [] },
      })
    }
  }
  return events
}
