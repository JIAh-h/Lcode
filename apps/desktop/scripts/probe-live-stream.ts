import { createDesktopModelFeature } from '@lcode/lcode-desktop'
import type { PreparedCall, StreamChunk } from '@lcode/llm'

/**
 * 真实模型流协议探针。
 *
 * 它只通过本机已保存的默认模型和凭据引用发出一个最小请求，绝不接收命令行密钥，
 * 也不打印请求头或模型文本。用于区分“端点可连通”与“实际 chat/completions 能出流”。
 *
 * 用法：LCODE_HOME=<已配置目录> tsx apps/desktop/scripts/probe-live-stream.ts
 */

const home = process.env.LCODE_HOME
if (home === undefined || home === '') throw new Error('需要 LCODE_HOME')
if (process.env.LCODE_E2E_LIVE !== '1') {
  console.log('跳过：真实模型探针需要显式设 LCODE_E2E_LIVE=1')
  process.exit(0)
}

const startedAt = performance.now()
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 125_000)

const summary = {
  http: undefined as undefined | { status: number; contentType: string | null },
  chunks: {} as Record<string, number>,
  textChars: 0,
  reasoningChars: 0,
  firstEventMs: undefined as number | undefined,
  firstTextMs: undefined as number | undefined,
  firstReasoningMs: undefined as number | undefined,
  done: false,
}

const observedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  summary.http = {
    status: response.status,
    contentType: response.headers.get('content-type'),
  }
  return response
}

function withMinimalUserMessage(call: PreparedCall): PreparedCall {
  return {
    ...call,
    request: {
      ...call.request,
      body: {
        system: '',
        messages: [{ role: 'user', content: '只回复：OK' }],
        tools: [],
      },
    },
  }
}

function observe(chunk: StreamChunk): void {
  const now = Math.round(performance.now() - startedAt)
  summary.chunks[chunk.type] = (summary.chunks[chunk.type] ?? 0) + 1
  summary.firstEventMs ??= now
  if (chunk.type === 'text-delta') {
    summary.textChars += chunk.text.length
    summary.firstTextMs ??= now
  }
  if (chunk.type === 'reasoning-delta') {
    summary.reasoningChars += chunk.text.length
    summary.firstReasoningMs ??= now
  }
  if (chunk.type === 'done') summary.done = true
}

async function main(): Promise<void> {
  const feature = await createDesktopModelFeature({ home, fetch: observedFetch })
  try {
  const selection = await feature.api.getDefault()
  if (selection === undefined) throw new Error('没有已配置的默认模型')
  const adapter = feature.ctx.get('llm').get(selection.provider)
  if (adapter === undefined) throw new Error(`默认模型供应商未注册：${selection.provider}`)

  const call = await adapter.prepareCall(selection, { signal: controller.signal })
  for await (const chunk of adapter.stream(withMinimalUserMessage(call), controller.signal)) observe(chunk)

  console.log(
    JSON.stringify({
      result: summary.done && summary.textChars > 0 ? 'passed' : 'no-visible-text',
      provider: selection.provider,
      model: selection.model,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...summary,
    }),
  )
    process.exitCode = summary.done && summary.textChars > 0 ? 0 : 1
  } catch (error) {
    const record = error as { code?: unknown; name?: unknown; userMessage?: unknown }
    console.log(
      JSON.stringify({
        result: 'failed',
        errorCode: typeof record.code === 'string' ? record.code : undefined,
        errorName: typeof record.name === 'string' ? record.name : 'Error',
        userMessage: typeof record.userMessage === 'string' ? record.userMessage : undefined,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...summary,
      }),
    )
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    feature.dispose()
  }
}

void main()
