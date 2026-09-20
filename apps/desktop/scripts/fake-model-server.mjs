import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 冒烟用的假模型服务端。
 *
 * 按对话的**轮次**切换行为：第一轮调一个工具，拿到工具结果之后收尾。
 *
 * ## 为什么它要独立成一个文件
 *
 * 一开始把它内联在冒烟脚本的模板字符串里，结果 `\n` 的转义层级绕得看不清，
 * 一度写成了字面 `\n`（两个字符）——SSE 里没有真换行，解析不出任何分片，
 * 表现为"什么都没发生"。独立文件没有转义问题。
 *
 * ## 为什么按 `role:'tool'` 判断轮次
 *
 * 这正是**测什么**的关键：如果适配器把工具结果发成 `role:'user'`（曾经的 bug），
 * 这里会一直认为是第一轮 → **无限调工具**（实测 9 秒 1095 次）。
 * 所以这个假服务端同时是一条断言：它只有在工具结果被正确标注时才停得下来。
 */

/** 要调用的工具与参数（由环境变量给，便于不同冒烟复用本文件） */
const toolName = process.env.FAKE_TOOL ?? 'read'
const toolArgs = process.env.FAKE_TOOL_ARGS ?? JSON.stringify({ path: 'hello.txt' })
/** 收尾时回给用户的文本 */
const finalText = process.env.FAKE_FINAL ?? '读到了'
/**
 * 第一轮回什么：`tool` = 调一个工具（默认）；`text` = 直接回一段文字。
 *
 * 纯文本模式给"只想验对话链路"的冒烟用（`smoke-e2e`）——它不该被卷进工具链，
 * 那样一个冒烟会同时测两件事，失败时说不清是哪一件坏了。
 */
const mode = process.env.FAKE_MODE ?? 'tool'
/** 纯文本模式下回的文本 */
const scriptedText = process.env.FAKE_TEXT ?? '你好，我是一条真实的流式回复。'
/** 每个文本片段的延迟；默认 0，暂停/续跑冒烟用小延迟制造真实的活动流。 */
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 0)
const port = Number(process.env.FAKE_PORT ?? 8898)

createServer((req, res) => {
  if (req.url !== null && req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', async () => {
    const parsed = JSON.parse(body === '' ? '{}' : body)
    const messages = parsed.messages ?? []
    const hasToolResult = messages.some((m) => m.role === 'tool')

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

    if (mode === 'text') {
      // 逐字发，这样流式渲染与 chunk 合帧也一并被验到
      for (const piece of scriptedText) {
        send({ choices: [{ delta: { content: piece } }], usage: null })
        if (delayMs > 0) await delay(delayMs)
      }
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    } else if (!hasToolResult) {
      send({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: toolName, arguments: toolArgs } }],
            },
          },
        ],
        usage: null,
      })
      send({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    } else {
      send({ choices: [{ delta: { content: finalText } }], usage: null })
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }

    res.write('data: [DONE]\n\n')
    res.end()
  })
}).listen(port, () => {
  console.log(`fake model on ${port}, mode=${mode}`)
})
