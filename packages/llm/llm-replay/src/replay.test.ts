import { describe, expect, it } from 'vitest'
import { ReplayLlmAdapter } from './replay.ts'
import type { ReplayScript } from './replay.ts'
import type { PreparedCall } from '@lcode/llm'
import type { StreamChunk } from '@lcode/session'

const scriptOf = (text: string): ReplayScript => ({
  provider: 'replay',
  chunks: [
    { type: 'text-delta', text },
    { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ],
})

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const fakeCall = (body: unknown = {}): PreparedCall => ({
  provider: 'replay',
  model: 'replay-model',
  request: { endpoint: 'replay://', headers: {}, body },
  retryPolicy: { maxAttempts: 1, baseDelayMs: 0, shouldRetry: () => false },
})

describe('ReplayLlmAdapter', () => {
  it('单脚本：按序产出全部 chunk', async () => {
    const adapter = new ReplayLlmAdapter(scriptOf('你好'))
    const chunks = await collect(adapter.stream(fakeCall(), new AbortController().signal))
    expect(chunks.map((c) => (c.type === 'text-delta' ? c.text : c.type))).toEqual(['你好', 'done'])
  })

  it('多脚本：每次 stream 消费下一段（跑工具→再要模型 的两段式驱动）', async () => {
    const adapter = new ReplayLlmAdapter([scriptOf('第一段'), scriptOf('第二段'), scriptOf('第三段')])
    expect(adapter.remaining).toBe(3)
    const first = await collect(adapter.stream(fakeCall('call-1'), new AbortController().signal))
    const second = await collect(adapter.stream(fakeCall('call-2'), new AbortController().signal))
    expect(first[0]).toMatchObject({ type: 'text-delta', text: '第一段' })
    expect(second[0]).toMatchObject({ type: 'text-delta', text: '第二段' })
    expect(adapter.remaining).toBe(1)
    expect(adapter.served.map((c) => c.request.body)).toEqual(['call-1', 'call-2'])
  })

  it('确定性：同构造同序列（快照重放的前提）', async () => {
    const make = (): ReplayLlmAdapter => new ReplayLlmAdapter([scriptOf('a'), scriptOf('b')])
    const run = async (): Promise<string[]> => {
      const adapter = make()
      const out: string[] = []
      for (let i = 0; i < 2; i++) {
        for await (const chunk of adapter.stream(fakeCall(), new AbortController().signal)) {
          if (chunk.type === 'text-delta') out.push(chunk.text)
        }
      }
      return out
    }
    expect(await run()).toEqual(await run())
  })

  it('脚本耗尽：抛 EC-NOT_READY，不静默重放', async () => {
    const adapter = new ReplayLlmAdapter(scriptOf('only'))
    await collect(adapter.stream(fakeCall(), new AbortController().signal))
    await expect(collect(adapter.stream(fakeCall(), new AbortController().signal))).rejects.toMatchObject({
      code: 'EC-NOT_READY',
    })
  })

  it('中止：流中段即抛 AbortError（循环侧据此走取消收尾）', async () => {
    const adapter = new ReplayLlmAdapter(scriptOf('很长很长的一段输出'))
    const controller = new AbortController()
    const consuming = collect(adapter.stream(fakeCall(), controller.signal))
    controller.abort()
    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('中止发生在首个 chunk 前：同样抛出', async () => {
    const adapter = new ReplayLlmAdapter(scriptOf('x'))
    const controller = new AbortController()
    controller.abort()
    await expect(collect(adapter.stream(fakeCall(), controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  })
})
