import { describe, expect, it } from 'vitest'
import type { CredentialsService, ResolvedCredential } from '@lcode/credentials'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'
import { OpenAiCompatibleAdapter, parseSse } from './adapter.ts'

/**
 * 批次④验收：真实适配器的**无密钥测试**（15 §7 快照重放策略的同类做法）。
 *
 * 全部用可注入的 `fetch` 桩，不联网、不花钱。测的是**协议翻译**与**错误归因**两件事——
 * 那是适配器唯一的职责（"从日志派生什么"归循环、"怎么发"归适配器）。
 */

function credential(value: string, source: ResolvedCredential['source'] = 'keychain'): CredentialsService {
  return {
    resolve: async (refName) => ({ refName, value, source }),
    describeSource: async () => source,
  }
}

const NO_CREDENTIAL: CredentialsService = {
  resolve: async () => undefined,
  describeSource: async () => undefined,
}

/** 造一个 SSE 响应体 */
function sse(events: readonly unknown[]): Response {
  const text = events.map((e) => `data: ${e === '[DONE]' ? '[DONE]' : JSON.stringify(e)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function makeAdapter(opts: {
  fetch: typeof globalThis.fetch
  credentials?: CredentialsService
  baseUrl?: string
  apiKeyRef?: string
  overrides?: () => { readonly baseUrl?: string | undefined; readonly apiKeyRef?: string | undefined } | undefined
}): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    id: 'custom',
    name: '自定义',
    baseUrl: opts.baseUrl ?? 'https://api.example.com/v1',
    apiKeyRef: opts.apiKeyRef ?? 'CUSTOM_API_KEY',
    credentials: opts.credentials ?? credential('sk-secret-value'),
    fetch: opts.fetch,
    ...(opts.overrides === undefined ? {} : { overrides: opts.overrides }),
  })
}

/** 收流成数组 */
async function collect(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of gen) out.push(item)
  return out
}

describe('① 协议翻译：内部形状 → OpenAI 请求体', () => {
  it('prepareCall 拼出 /chat/completions，凭据只出现在 headers 里', async () => {
    const adapter = makeAdapter({ fetch: (async () => sse([])) as typeof globalThis.fetch })
    const call = await adapter.prepareCall(
      { provider: 'custom', model: 'gpt-4o', params: { maxTokens: 1024, temperature: 0.3 } },
      { signal: new AbortController().signal },
    )

    expect(call.provider).toBe('custom')
    expect(call.model).toBe('gpt-4o')
    expect(call.request.endpoint).toBe('https://api.example.com/v1/chat/completions')
    expect(call.request.headers['authorization']).toBe('Bearer sk-secret-value')

    // ⚠️ I7：凭据值**不得**出现在 body 里
    const body = JSON.stringify(call.request.body)
    expect(body).not.toContain('sk-secret-value')

    // 采样参数**挂在 call 上**（body 会被 agent-loop 换掉，见下一条用例）
    expect(call.params).toMatchObject({ maxTokens: 1024, temperature: 0.3 })
  })

  it('**stream 把内部形状翻成 OpenAI 形状**（引擎换进 body 的是 {system,messages,tools}）', async () => {
    // 这是实测踩过的一个真 bug，而且是**每次真实对话都必然踩**：
    // `agent-loop` 用 `withBody()` 把 request.body 换成内部形状（I1：一切从日志派生），
    // 而 `stream()` 当时把它**原样发出去**——OpenAI 收到的是一份没有 `model`、
    // `messages` 里还夹着 `tool_use` 内容块的奇怪 JSON，一律 400。
    //
    // 为什么没被发现：`llm-replay` 适配器根本不看 body，而单测当时只测了 `prepareCall`
    // 拼出来的起点 body（那份是 OpenAI 形状的），从没测过 `stream` 真正发出去的东西。
    let sent: unknown
    const adapter = makeAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return sse([{ choices: [{ delta: { content: 'ok' } }, ], }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
      }) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall(
      { provider: 'custom', model: 'gpt-4o', params: { maxTokens: 64 } },
      { signal: new AbortController().signal },
    )
    // 模拟引擎：用内部形状覆盖 body
    const withBody = {
      ...call,
      request: {
        ...call.request,
        body: {
          system: '你是 Lcode',
          messages: [
            { role: 'user', content: [{ type: 'text', text: '你好' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }],
            },
            { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: '文件内容' }] },
          ],
          tools: [{ name: 'read', description: '读文件', inputSchema: { type: 'object' } }],
        },
      },
    }
    await collect(adapter.stream(withBody, new AbortController().signal))

    // 发出去的必须是**OpenAI 形状**
    expect(sent).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    })
    const body = sent as { messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[] }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是 Lcode' })
    expect(body.messages[1]).toEqual({ role: 'user', content: '你好' })
    // assistant 的 tool_use 块 → OpenAI 的 tool_calls
    expect(body.messages[2]).toMatchObject({ role: 'assistant' })
    expect(body.messages[2]!.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
    ])
    // tool_result 块 → 独立的 role:'tool' 消息
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '文件内容' })
    // 工具 schema 也要翻过去
    expect((sent as { tools?: unknown[] }).tools).toEqual([
      { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object' } } },
    ])
  })

  it('技能指令变成文本、图片变成 image_url，两者都不泄漏 base64 到文本里', async () => {
    let sent: { messages: { role: string; content?: unknown }[] } | undefined
    const adapter = makeAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as { messages: { role: string; content?: unknown }[] }
        return sse([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
      }) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall(
      { provider: 'custom', model: 'qwen3-vl-plus' },
      { signal: new AbortController().signal },
    )
    await collect(adapter.stream({
      ...call,
      request: {
        ...call.request,
        body: {
          system: '',
          messages: [{
            role: 'user',
            content: [
              { type: 'skill', id: 'review', name: 'Review', instructions: '检查改动。' },
              { type: 'text', text: '看图' },
              { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' },
            ],
          }],
          tools: [],
        },
      },
    }, new AbortController().signal))

    expect(sent?.messages[0]?.content).toEqual([
      { type: 'text', text: '[Skill: Review]\n检查改动。\n\n看图' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ])
  })

  it('file-ref 附件以「正文内联 + 无需重复读取」的文本进请求；截断时提示可续读', async () => {
    let sent: { messages: { role: string; content?: unknown }[] } | undefined
    const adapter = makeAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as { messages: { role: string; content?: unknown }[] }
        return sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
      }) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall(
      { provider: 'custom', model: 'm' },
      { signal: new AbortController().signal },
    )
    await collect(adapter.stream({
      ...call,
      request: {
        ...call.request,
        body: {
          system: '',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '这里面讲了什么？' },
              { type: 'file-ref', kind: 'file', path: 'D:/repo/docs/a.md', name: 'a.md', content: '# 正文' },
              { type: 'file-ref', kind: 'folder', path: 'D:/repo/docs', name: 'docs', content: '- src/', entries: 1, truncated: true },
            ],
          }],
          tools: [],
        },
      },
    }, new AbortController().signal))

    const raw = sent?.messages[0]?.content
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? ((raw as { type: string; text: string }[]).find((b) => b.type === 'text')?.text ?? '') : ''
    expect(text).toContain('[Attachment: D:/repo/docs/a.md]（正文已完整附在下方')
    expect(text).toContain('# 正文')
    expect(text).toContain('[Attachment folder: D:/repo/docs]\n- src/')
    expect(text).toContain('[content truncated; use the path above to read the rest]')
  })

  it('body 形状意外时退化成空请求，而不是炸在深处', async () => {
    let sent: unknown
    const adapter = makeAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
      }) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const broken = { ...call, request: { ...call.request, body: { 乱来的: true } } }
    await collect(adapter.stream(broken, new AbortController().signal))
    expect(sent).toMatchObject({ model: 'm', messages: [], stream: true })
  })

  it('**消息级工具结果 → `role:"tool"`**（引擎实际产出的形状，不是内容块）', async () => {
    /*
     * 这一条盯的是一个**只在真实工具调用时才出现**的死循环（实测踩过）：
     *
     * `deriveMessages()` 从 `tool/result` 派生出的是一条 `ToolResultMessage`——
     * `role:'user'` + **消息上**的 `toolCallId` + 普通字符串 content。
     *
     * 而原来这里只判了"内容块里有没有 `tool_result` 块"，那个形状引擎**从来不产出**。
     * 于是工具结果落进普通分支、以 `role:'user'` 发出去：模型看到的是一串用户消息，
     * 完全看不出工具跑过，**于是反复调同一个工具**。
     *
     * 现象：9 秒内 1095 次 `tool/call`，日志里没有 `turn/end`。纯文本对话永远碰不到，
     * 所以之前所有测试都是绿的。
     */
    let sent: { messages: { role: string; tool_call_id?: string; content?: unknown }[] } | undefined
    const adapter = makeAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
      }) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const withBody = {
      ...call,
      request: {
        ...call.request,
        body: {
          system: '',
          messages: [
            { role: 'user', content: '读一下 hello.txt' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'hello.txt' } }],
            },
            // ⚠️ 引擎产出的正是这个形状：toolCallId 在消息上，content 是字符串
            { role: 'user', toolCallId: 'call_1', content: '{"lines":[{"number":1,"text":"hi"}]}', isError: false },
          ],
          tools: [],
        },
      },
    }
    await collect(adapter.stream(withBody, new AbortController().signal))

    expect(sent?.messages).toEqual([
      { role: 'user', content: '读一下 hello.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"hello.txt"}' } }],
      },
      // **必须是 role:'tool' 且带 tool_call_id**——发成 user 会让模型看不出工具跑过
      { role: 'tool', tool_call_id: 'call_1', content: '{"lines":[{"number":1,"text":"hi"}]}' },
    ])
  })

  it('base_url 的末尾斜杠被归一（避免拼出 //chat/completions）', async () => {
    const adapter = makeAdapter({
      fetch: (async () => sse([])) as typeof globalThis.fetch,
      baseUrl: 'https://api.example.com/v1///',
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    expect(call.request.endpoint).toBe('https://api.example.com/v1/chat/completions')
  })

  it('设置页的覆盖立即生效（base_url 改了下一个请求就用新值）', async () => {
    let baseUrl = 'https://old.example.com/v1'
    const adapter = makeAdapter({
      fetch: (async () => sse([])) as typeof globalThis.fetch,
      overrides: () => ({ baseUrl }),
    })
    const first = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    expect(first.request.endpoint).toContain('old.example.com')

    baseUrl = 'https://new.example.com/v1' // 用户在设置页改完
    const second = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    expect(second.request.endpoint).toContain('new.example.com')
  })

  it('apiKeyRef 为空串 = 不需要密钥（本地模型），不发 authorization', async () => {
    const adapter = makeAdapter({ fetch: (async () => sse([])) as typeof globalThis.fetch, apiKeyRef: '' })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'llama3' }, { signal: new AbortController().signal })
    expect(call.request.headers['authorization']).toBeUndefined()
  })

  it('D22：凭据**每次**重新解析（轮换 key 下一个请求就生效）', async () => {
    const seen: string[] = []
    let current = 'key-1'
    const credentials: CredentialsService = {
      resolve: async (refName) => {
        seen.push(current)
        return { refName, value: current, source: 'keychain' }
      },
      describeSource: async () => 'keychain',
    }
    const adapter = makeAdapter({ fetch: (async () => sse([])) as typeof globalThis.fetch, credentials })

    const a = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    current = 'key-2' // 用户轮换
    const b = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })

    expect(a.request.headers['authorization']).toBe('Bearer key-1')
    expect(b.request.headers['authorization']).toBe('Bearer key-2')
    expect(seen).toEqual(['key-1', 'key-2']) // 两次都真的去解析了，没有缓存
  })

  it('缺凭据 → EL-CREDENTIAL_MISSING（不是静默发一个无鉴权请求）', async () => {
    const adapter = makeAdapter({ fetch: (async () => sse([])) as typeof globalThis.fetch, credentials: NO_CREDENTIAL })
    await expect(
      adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EL_CREDENTIAL_MISSING })
  })
})

describe('① 流式翻译：SSE → StreamChunk', () => {
  it('文本增量 → text-delta，finish_reason → done', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { content: '改完' } }] },
          { choices: [{ delta: { content: '了' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = await collect(adapter.stream(call, new AbortController().signal))

    expect(chunks).toEqual([
      { type: 'text-delta', text: '改完' },
      { type: 'text-delta', text: '了' },
      {
        type: 'done',
        // ⚠️ done 必须带**完整正文**：引擎以它为准落盘 assistant/message
        //（空 content 会让界面上什么都看不到——这个 bug 实测踩过）
        message: { role: 'assistant', content: [{ type: 'text', text: '改完了' }], provider: 'custom', model: 'm' },
      },
    ])
  })

  it('响应尚未结束时立即产出首个文本增量', async () => {
    const encoder = new TextEncoder()
    let release!: () => void
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"先"}}]}\n\n'))
          void new Promise<void>((resolve) => {
            release = resolve
          }).then(() => {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
            )
            controller.close()
          })
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const adapter = makeAdapter({ fetch: (async () => response) as typeof globalThis.fetch })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const iterator = adapter.stream(call, new AbortController().signal)[Symbol.asyncIterator]()
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const first = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('首个增量在响应结束前没有产出')), 100)
        }),
      ])
      expect(first).toEqual({ value: { type: 'text-delta', text: '先' }, done: false })
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      release()
    }

    const rest: unknown[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      rest.push(next.value)
    }
    expect(rest).toContainEqual({
      type: 'done',
      message: { role: 'assistant', content: [{ type: 'text', text: '先' }], provider: 'custom', model: 'm' },
    })
  })

  it('**done 携带完整正文**（引擎把 done.message 当权威，空 content 会让 UI 啥都看不到）', async () => {
    // 这个用例是补出来的：原来只断言了 chunk 翻译，没断言 done 的内容完整性，
    // 于是单测全绿、而真实对话在界面上是空回复（实测踩过）。
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { content: '改完了，' } }] },
          { choices: [{ delta: { content: '测试也过了。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as {
      type: string
      message?: { content: readonly { type: string; text?: string }[] }
    }[]
    const done = chunks.find((c) => c.type === 'done')!
    // 关键断言：**内容必须拼回来**，而不是空数组
    expect(done.message?.content).toEqual([{ type: 'text', text: '改完了，测试也过了。' }])
  })

  it('done 携带工具调用（参数拼成对象）', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as {
      type: string
      message?: { content: readonly { type: string; id?: string; name?: string; input?: unknown }[] }
    }[]
    const done = chunks.find((c) => c.type === 'done')!
    expect(done.message?.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }])
  })

  it('工具参数不是合法 JSON → input 落空对象，**不猜**（引擎仍保留原始串，D9）', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '这不是 JSON' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as {
      type: string
      message?: { content: readonly { type: string; input?: unknown }[] }
    }[]
    const done = chunks.find((c) => c.type === 'done')!
    expect(done.message?.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'read', input: {} }])
  })

  it('reasoning_content → reasoning-delta（DeepSeek 等）', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { reasoning_content: '先看类型' } }] },
          { choices: [{ delta: { content: '好' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as { type: string }[]
    expect(chunks.map((c) => c.type)).toEqual(['reasoning-delta', 'text-delta', 'done'])
  })

  it('工具调用按 **index** 累积：后续分片只有 index、没有 id/name，也不能丢参数', async () => {
    // 这是 OpenAI 流式协议最容易做错的地方：第一个分片带 id 与 name，之后只有 index。
    // 按 id 累积会把后半截 arguments 丢掉，导致工具调用参数不完整。
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as {
      type: string
      callId?: string
      name?: string
      argsDelta?: string
    }[]

    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas).toHaveLength(2)
    // 两片的 callId 都是 call_1（第二片靠 index 找回 id）
    expect(deltas.every((d) => d.callId === 'call_1')).toBe(true)
    // 参数能拼回完整 JSON
    expect(deltas.map((d) => d.argsDelta).join('')).toBe('{"path":"a.ts"}')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'done' })
  })

  it('多个并行工具调用各归各的 index', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'a', function: { name: 'read', arguments: '{}' } },
                    { index: 1, id: 'b', function: { name: 'glob', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as {
      type: string
      callId?: string
      name?: string
    }[]
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas.map((d) => [d.callId, d.name])).toEqual([
      ['a', 'read'],
      ['b', 'glob'],
    ])
  })

  it('usage 带上（含缓存命中），随 done 一起给出', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } } },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as { type: string; usage?: unknown }[]
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({
      usage: { input: 120, output: 8, cacheRead: 100 },
    })
    const done = chunks.find((c) => c.type === 'done') as { usage?: unknown }
    expect(done.usage).toMatchObject({ input: 120, output: 8 })
  })

  it('**每个分片都带 `usage: null` 也不能崩**（DeepSeek 的真实形状）', async () => {
    // 这是实测踩过的一个真 bug：判断写成了 `!== undefined`，而流式协议里
    // 绝大多数分片给的是 `null`（只有最后一片才有真 usage）。
    // `null !== undefined` 为真 → 去读 `null.prompt_tokens` → TypeError → **整轮流被中断**。
    //
    // 特别阴的地方：设置页「测试连接」是成功的（那只打 `/models`，不流式），
    // 于是一路绿灯到对话才炸，而界面上只剩一句笼统的"没能跑起来"。
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' }, finish_reason: null }], usage: null },
          { choices: [{ delta: { content: '你好' }, finish_reason: null }], usage: null },
          { choices: [{ delta: { content: '，世界' }, finish_reason: null }], usage: null },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4 } },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    // 不抛错本身就是主断言——以前这里会 TypeError
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as {
      type: string
      text?: string
      message?: { content: readonly { type: string; text?: string }[] }
      usage?: { input: number; output: number }
    }[]

    // 正文不能因为 null 分片而丢
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['你好', '，世界'])
    const done = chunks.find((c) => c.type === 'done')
    expect(done?.message?.content).toEqual([{ type: 'text', text: '你好，世界' }])
    // 最后一个分片的真 usage 仍然被取到
    expect(done?.usage).toMatchObject({ input: 7, output: 4 })
  })

  it('缺 usage 字段（不是 null，是压根没有）同样不崩', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        sse([
          { choices: [{ delta: { content: 'hi' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as { type: string }[]
    expect(chunks.some((c) => c.type === 'usage')).toBe(false)
    expect(chunks[chunks.length - 1]!.type).toBe('done')
  })

  it('流断在半路（没有 finish_reason）也补一个 done，不让循环永久等待', async () => {
    const adapter = makeAdapter({
      fetch: (async () => sse([{ choices: [{ delta: { content: '半截' } }] }])) as typeof globalThis.fetch,
    })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as { type: string }[]
    expect(chunks[chunks.length - 1]!.type).toBe('done')
  })

  it('单个畸形分片被跳过，不影响其余分片', async () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"前"}}]}',
      '',
      'data: {这不是 JSON',
      '',
      'data: {"choices":[{"delta":{"content":"后"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const adapter = makeAdapter({ fetch: (async () => new Response(raw, { status: 200 })) as typeof globalThis.fetch })
    const call = await adapter.prepareCall({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal })
    const chunks = (await collect(adapter.stream(call, new AbortController().signal))) as { type: string; text?: string }[]
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['前', '后'])
  })
})

describe('① 错误归因（六类，与 model-api 的 probe 对齐）', () => {
  async function probeWith(status: number): Promise<unknown> {
    const adapter = makeAdapter({
      fetch: (async () => new Response('{"error":"nope"}', { status })) as typeof globalThis.fetch,
    })
    try {
      await adapter.listModels(new AbortController().signal)
      throw new Error('应当抛错')
    } catch (err) {
      return (err as LcodeErrorImpl).code
    }
  }

  it('401/403 → EL-CREDENTIAL_REJECTED', async () => {
    expect(await probeWith(401)).toBe(ERROR_CODES.EL_CREDENTIAL_REJECTED)
    expect(await probeWith(403)).toBe(ERROR_CODES.EL_CREDENTIAL_REJECTED)
  })

  it('404 → EL-UNKNOWN_MODEL（地址或模型名不对）', async () => {
    expect(await probeWith(404)).toBe(ERROR_CODES.EL_UNKNOWN_MODEL)
  })

  it('400 + 上下文超限文案 → EL-CONTEXT_OVERFLOW；普通 400 仍是 EL-MODEL_ERROR', async () => {
    const overflow = makeAdapter({
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: "This model's maximum context length is 8192 tokens" } }), {
          status: 400,
        })) as typeof globalThis.fetch,
    })
    await expect(overflow.listModels(new AbortController().signal)).rejects.toMatchObject({
      code: ERROR_CODES.EL_CONTEXT_OVERFLOW,
    })

    const generic = makeAdapter({
      fetch: (async () => new Response('{"error":"invalid temperature"}', { status: 400 })) as typeof globalThis.fetch,
    })
    await expect(generic.listModels(new AbortController().signal)).rejects.toMatchObject({
      code: ERROR_CODES.EL_MODEL_ERROR,
    })
  })

  it('429 → EL-RATE_LIMITED，且标为可重试', async () => {
    expect(await probeWith(429)).toBe(ERROR_CODES.EL_RATE_LIMITED)
    const adapter = makeAdapter({ fetch: (async () => new Response('', { status: 429 })) as typeof globalThis.fetch })
    expect(adapter.providerRetryPolicy().shouldRetry(ERROR_CODES.EL_RATE_LIMITED)).toBe(true)
  })

  it('连不上 → EL-ENDPOINT_UNREACHABLE，且标为可重试', async () => {
    const adapter = makeAdapter({
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as typeof globalThis.fetch,
    })
    await expect(adapter.listModels(new AbortController().signal)).rejects.toMatchObject({
      code: ERROR_CODES.EL_ENDPOINT_UNREACHABLE,
      retryable: true,
    })
  })

  it('错误信息里不含凭据值（I7）', async () => {
    const adapter = makeAdapter({
      fetch: (async () => {
        throw new Error('boom')
      }) as typeof globalThis.fetch,
    })
    try {
      await adapter.listModels(new AbortController().signal)
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-secret-value')
    }
  })

  it('URL 里的查询串在错误信息里被打码（可能是 ?key=…）', async () => {
    const adapter = makeAdapter({
      fetch: (async () => {
        throw new Error('boom')
      }) as typeof globalThis.fetch,
      baseUrl: 'https://api.example.com/v1?key=supersecret',
    })
    try {
      await adapter.listModels(new AbortController().signal)
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('?…')
      expect(message).not.toContain('supersecret')
    }
  })
})

describe('① 模型清单与重试策略', () => {
  it('listModels 解析 { data: [{id}] } 形状', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'deepseek-chat', name: 'DeepSeek Chat' }, { noId: true }] }), {
          status: 200,
        })) as typeof globalThis.fetch,
    })
    const models = await adapter.listModels(new AbortController().signal)
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'deepseek-chat'])
    expect(models[1]!.name).toBe('DeepSeek Chat')
  })

  it('listModels 读取供应商返回的 context_window（官方 DeepSeek 形态）', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', context_window: 1_048_576, max_output_tokens: 393_216 }] }), {
          status: 200,
        })) as typeof globalThis.fetch,
    })
    const models = await adapter.listModels(new AbortController().signal)
    expect(models[0]).toMatchObject({ id: 'deepseek-flash', contextWindow: 1_048_576 })
  })

  it('listModels 读取 input_modalities 的图片能力（官方 DeepSeek 形态）', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        new Response(JSON.stringify({
          data: [
            { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
            { id: 'deepseek-chat', input_modalities: ['text'] },
          ],
        }), { status: 200 })) as typeof globalThis.fetch,
    })
    const models = await adapter.listModels(new AbortController().signal)
    expect(models.find((m) => m.id === 'deepseek-flash')?.vision).toBe(true)
    expect(models.find((m) => m.id === 'deepseek-chat')?.vision).toBe(false)
  })

  it('describeModel 读取 /models/{id} 的百炼额外字段', async () => {
    let requested = ''
    const adapter = makeAdapter({
      fetch: (async (url: string) => {
        requested = url
        return new Response(JSON.stringify({
          id: 'deepseek-v4.1-flash',
          extra_info: { default_envs: { max_input_tokens: 129_024, max_output_tokens: 8_192 } },
        }), { status: 200 })
      }) as typeof globalThis.fetch,
    })
    const limits = await adapter.describeModel(
      { provider: 'custom', model: 'deepseek-v4.1-flash' },
      { signal: new AbortController().signal },
    )
    expect(requested).toBe('https://api.example.com/v1/models/deepseek-v4.1-flash')
    expect(limits).toEqual({ contextWindow: 129_024, maxOutputTokens: 8_192 })
  })

  it('describeModel 兼容把详情包在 data: 帧里的网关', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        new Response(
          `data:${JSON.stringify({ id: 'm', extra_info: { default_envs: { max_input_tokens: 200_000 } } })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )) as typeof globalThis.fetch,
    })
    await expect(
      adapter.describeModel({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ contextWindow: 200_000 })
  })

  it('describeModel 遇到无字段的响应时返回空对象，不猜', async () => {
    const adapter = makeAdapter({
      fetch: (async () => new Response(JSON.stringify({ id: 'm' }), { status: 200 })) as typeof globalThis.fetch,
    })
    await expect(
      adapter.describeModel({ provider: 'custom', model: 'm' }, { signal: new AbortController().signal }),
    ).resolves.toEqual({})
  })

  it('listModels 兼容百炼以 SSE data 帧包装的模型清单', async () => {
    const adapter = makeAdapter({
      fetch: (async () =>
        new Response('data:{"object":"list","data":[{"id":"deepseek-v4.1-flash"}]}\n\ndata: [DONE]\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof globalThis.fetch,
    })

    const models = await adapter.listModels(new AbortController().signal)
    expect(models).toMatchObject([{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }])
  })

  it('不重试确定性拒绝（认证失败、模型不存在）', async () => {
    const adapter = makeAdapter({ fetch: (async () => sse([])) as typeof globalThis.fetch })
    const policy = adapter.providerRetryPolicy()
    expect(policy.shouldRetry(ERROR_CODES.EL_CREDENTIAL_REJECTED)).toBe(false)
    expect(policy.shouldRetry(ERROR_CODES.EL_UNKNOWN_MODEL)).toBe(false)
    expect(policy.shouldRetry(ERROR_CODES.EN_TIMEOUT)).toBe(true)
  })

  it('providerInfo 声明流式与工具调用能力', async () => {
    const adapter = makeAdapter({ fetch: (async () => sse([])) as typeof globalThis.fetch })
    expect(adapter.providerInfo()).toMatchObject({
      id: 'custom',
      capabilities: { streaming: true, toolCalls: true },
    })
  })
})

describe('① SSE 解析器', () => {
  it('只取 data: 行，跳过空行与注释，兼容 CRLF', () => {
    const text = 'event: message\r\ndata: {"a":1}\r\n\r\n: keep-alive\r\ndata: [DONE]\r\n\r\n'
    expect([...parseSse(text)]).toEqual(['{"a":1}', '[DONE]'])
  })
})

describe('① DashScope 原生目录（model_info.context_window）', () => {
  it('原生目录的 context_window 优先于 /models/{id} 的 default_envs', async () => {
    const adapter = makeAdapter({
      baseUrl: 'https://ds-catalog-a.example.com/compatible-mode/v1',
      fetch: (async (url: string) => {
        const u = String(url)
        if (u.includes('/api/v1/models')) {
          return new Response(JSON.stringify({
            output: {
              total: 1,
              page_no: 1,
              page_size: 100,
              models: [{ model: 'deepseek-v4.1-flash-1017', model_info: { context_window: 1_000_000, max_input_tokens: 1_000_000, max_output_tokens: 393_216 } }],
            },
          }), { status: 200 })
        }
        if (u.includes('/compatible-mode/v1/models/')) {
          return new Response(JSON.stringify({ id: 'deepseek-v4.1-flash-1017', extra_info: { default_envs: { max_input_tokens: 129_024 } } }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }) as typeof globalThis.fetch,
    })
    await expect(
      adapter.describeModel({ provider: 'custom', model: 'deepseek-v4.1-flash-1017' }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ contextWindow: 1_000_000, maxOutputTokens: 393_216 })
  })

  it('原生目录的 inference_metadata.request_modality 带出图片能力', async () => {
    const adapter = makeAdapter({
      baseUrl: 'https://ds-catalog-vision.example.com/compatible-mode/v1',
      fetch: (async (url: string) => {
        const u = String(url)
        if (u.includes('/api/v1/models')) {
          return new Response(JSON.stringify({
            output: {
              total: 1,
              page_no: 1,
              page_size: 100,
              models: [{
                model: 'deepseek-v4.1-flash-1017',
                capabilities: ['TG', 'Reasoning', 'VU'],
                inference_metadata: { request_modality: ['Text', 'Image'], response_modality: ['Text'] },
                model_info: { context_window: 1_000_000 },
              }],
            },
          }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }) as typeof globalThis.fetch,
    })
    await expect(
      adapter.describeModel({ provider: 'custom', model: 'deepseek-v4.1-flash-1017' }, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ contextWindow: 1_000_000, vision: true })
  })

  it('listModels 用原生目录补齐 /models 缺失的窗口', async () => {
    const adapter = makeAdapter({
      baseUrl: 'https://ds-catalog-b.example.com/compatible-mode/v1',
      fetch: (async (url: string) => {
        const u = String(url)
        if (u.includes('/api/v1/models')) {
          return new Response(JSON.stringify({
            output: { total: 1, page_no: 1, page_size: 100, models: [{ model: 'qwen3.8-flash', model_info: { context_window: 1_000_000, max_output_tokens: 131_072 } }] },
          }), { status: 200 })
        }
        if (u.endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-flash' }, { id: 'other-model' }] }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }) as typeof globalThis.fetch,
    })
    const models = await adapter.listModels(new AbortController().signal)
    expect(models.find((m) => m.id === 'qwen3.8-flash')?.contextWindow).toBe(1_000_000)
    expect(models.find((m) => m.id === 'other-model')?.contextWindow).toBeUndefined()
  })
})
