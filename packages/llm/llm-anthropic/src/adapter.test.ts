import { describe, expect, it } from 'vitest'
import type { PreparedCall } from '@lcode/llm'
import { ERROR_CODES } from '@lcode/util'
import { AnthropicCompatibleAdapter } from './adapter.ts'

const credentials = {
  resolve: async (refName: string) => ({ refName, value: 'sk-test', source: 'env' }),
  describeSource: async () => 'env',
} as never

function adapterWith(fetchImpl: typeof globalThis.fetch): AnthropicCompatibleAdapter {
  return new AnthropicCompatibleAdapter({
    id: 'anthropic-test',
    name: 'Anthropic Test',
    baseUrl: 'https://api.example.com',
    apiKeyRef: 'TEST_KEY',
    credentials,
    fetch: fetchImpl,
  })
}

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":7}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

describe('AnthropicCompatibleAdapter', () => {
  it('翻译 SSE：正文、工具调用、usage 与 done', async () => {
    let captured: { url: string; body: unknown; headers: unknown } | undefined
    const adapter = adapterWith((async (input, init) => {
      captured = {
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: init?.headers,
      }
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch)
    const call = await adapter.prepareCall(
      { provider: 'anthropic-test', model: 'claude-test', params: { maxTokens: 1234, temperature: 0.2 } },
      { signal: new AbortController().signal },
    )
    ;(call as { request: { body: unknown } }).request.body = {
      system: 'you are lcode',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
      tools: [{ name: 'read', description: 'read file', inputSchema: { type: 'object' } }],
    }
    const chunks = []
    for await (const chunk of adapter.stream(call, new AbortController().signal)) chunks.push(chunk)

    expect(captured?.url).toBe('https://api.example.com/v1/messages')
    expect(captured?.body).toMatchObject({
      model: 'claude-test',
      max_tokens: 1234,
      temperature: 0.2,
      system: 'you are lcode',
      stream: true,
      tools: [{ name: 'read', description: 'read file', input_schema: { type: 'object' } }],
    })
    expect((captured?.headers as Record<string, string>)['x-api-key']).toBe('sk-test')

    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', text: 'Hello ' }])
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', callId: 'toolu_1', name: 'read', argsDelta: '' },
      { type: 'tool-call-delta', callId: 'toolu_1', name: 'read', argsDelta: '{"path":"a.txt"}' },
    ])
    const done = chunks.at(-1)
    expect(done?.type).toBe('done')
    if (done?.type === 'done') {
      expect(done.message.content).toEqual([
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } },
      ])
    }
    expect(chunks.find((chunk) => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { input: 10, output: 7 },
    })
  })

  it('工具结果转成 user 的 tool_result，并与相邻用户消息合并', async () => {
    let body: any
    const adapter = adapterWith((async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch)
    const call: PreparedCall = await adapter.prepareCall(
      { provider: 'anthropic-test', model: 'claude-test' },
      { signal: new AbortController().signal },
    )
    const internal = {
      system: '',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } }] },
        { role: 'user', toolCallId: 'toolu_1', content: 'file body' },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
      tools: [],
    }
    ;(call as { request: { body: unknown } }).request.body = internal
    for await (const _chunk of adapter.stream(call, new AbortController().signal)) { /* drain */ }

    expect(body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file body' }] },
          { type: 'text', text: '继续' },
        ],
      },
    ])
  })

  it('400 上下文溢出映射为 EL-CONTEXT_OVERFLOW', async () => {
    const adapter = adapterWith((async () => new Response(
      JSON.stringify({ error: { message: 'prompt is too long: maximum context length exceeded' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch)
    const call = await adapter.prepareCall(
      { provider: 'anthropic-test', model: 'claude-test' },
      { signal: new AbortController().signal },
    )
    await expect(async () => {
      for await (const _chunk of adapter.stream(call, new AbortController().signal)) { /* drain */ }
    }).rejects.toMatchObject({ code: ERROR_CODES.EL_CONTEXT_OVERFLOW })
  })
})