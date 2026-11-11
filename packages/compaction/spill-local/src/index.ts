import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@lcode/context'
import type {} from '@lcode/agent-loop'
import { deriveVisibleSurfaceItems } from '@lcode/session'
import type { SessionService } from '@lcode/session'
import { spillRoot } from '@lcode/util'
import type { Disposer } from '@lcode/util'

export interface SpillRef { readonly locator: string; readonly bytes: number }
export interface SpillRead { readonly text: string; readonly totalLines: number; readonly truncated: boolean }
export interface SpillStore {
  save(input: { readonly sessionId: string; readonly text: string }): Promise<SpillRef>
  read(input: { readonly sessionId: string; readonly locator: string; readonly offset?: number; readonly limit?: number }): Promise<SpillRead>
}

declare module '@lcode/context' {
  interface Services { spill: SpillStore }
}

/** 本机 spill provider：文件名带 session id，读取必须带同一会话身份。 */
export function createLocalSpillStore(home: string): SpillStore {
  const root = spillRoot(home)
  return {
    async save({ sessionId, text }) {
      const id = randomUUID()
      await mkdir(root, { recursive: true })
      await writeFile(join(root, `${sessionId}-${id}.txt`), text, { encoding: 'utf8', flag: 'wx' })
      return { locator: `lcode://spill/${id}`, bytes: Buffer.byteLength(text, 'utf8') }
    },
    async read({ sessionId, locator, offset = 1, limit = 2_000 }) {
      const id = parseLocator(locator)
      const text = await readFile(join(root, `${sessionId}-${id}.txt`), 'utf8')
      const all = text === '' ? [] : text.replace(/\n$/, '').split('\n')
      const start = Math.max(1, offset)
      const count = Math.max(1, limit)
      const lines = all.slice(start - 1, start - 1 + count)
      return { text: lines.join('\n'), totalLines: all.length, truncated: start - 1 + lines.length < all.length }
    },
  }
}

/**
 * 第二层零模型成本处理：外置原文并以 locator 替换可见结果。
 *
 * ## 触发时机（docs/09 §3.2.5，2026-11-11 修正）
 *
 * **只在压缩流程中按需运行，不再每结果主动触发。**
 *
 * 曾经的实现挂在 `agent/tool-result-appended` 上：任何一个超过 4000 字符的
 * 工具结果都会立刻触发 spill/prune，用 `surfaceOp: replace` 改写历史。
 * 看似无害（"结果刚写入、还没发出去"），**实际不是**：工具结果总是写在
 * 两请求之间，改写它=改写下一步请求的历史；再下一次请求里，这个位置
 * 已经被替换过——提供方的前缀缓存从那个位置起全部失效。
 *
 * 实测（真实会话 36 次请求）：回退后每次请求命中 99%，随后 6 次 spill/prune
 * 改写让命中率永远卡在 4~7%；单轮浪费 800K tokens。
 *
 * 现在的定位与 DSH 一致：spill 是**压缩策略的一部分**，只由压缩流程调用
 * （手动压缩 / 上下文占用达到窗口阈值自动压缩）。平时大结果原样留在上下文里——
 * 它们是前缀的一部分，反而省钱；真到窗口吃紧时由压缩一次性处理。
 */
export function registerLocalSpill(input: { readonly ctx: Context; readonly home: string; readonly thresholdChars?: number | undefined }): Disposer {
  const store = createLocalSpillStore(input.home)
  const unregisterService = input.ctx.set('spill', store)
  return () => {
    unregisterService()
  }
}

/**
 * 把可见表面里"超过阈值的工具结果"替换成 locator 预览。
 *
 * 由**压缩流程**调用（docs/09 §3.2.5）：原来挂在每结果事件上主动触发，
 * 会改写下一步请求的历史，让前缀缓存从那个位置起失效（实测单轮浪费
 * 800K tokens）。压缩本来就要接受一次缓存失效，合并到同一时点只失效一次。
 *
 * 返回替换发生的可见位置（-1 表示一条都没替换）。
 */
export function applySpillToSurface(input: {
  readonly sessionId: string
  readonly session: SessionService
  readonly spill: SpillStore
  readonly thresholdChars?: number | undefined
}): number {
  const threshold = input.thresholdChars ?? 4_000
  const visible = deriveVisibleSurfaceItems(input.session.events())
  let lastReplaced = -1
  for (const [index, item] of visible.entries()) {
    // 只处理工具结果消息（role=user + 顶层 toolCallId 的那种）
    const message = item.message as {
      readonly toolCallId?: unknown
      readonly isError?: unknown
      readonly turn?: unknown
      readonly step?: unknown
      readonly content?: unknown
    }
    if (typeof message.toolCallId !== 'string' || message.toolCallId === '') continue
    if (message.toolCallId.startsWith('read')) continue // 防止 read→spill→read 循环
    if (typeof message.content !== 'string') continue
    if (message.isError === true) continue
    if (message.content.length <= threshold) continue
    if (message.content.includes('lcode://spill/')) continue // 已经是 spill 预览
    const text = message.content
    const turn = typeof message.turn === 'number' ? message.turn : 0
    const step = typeof message.step === 'number' ? message.step : 0
    void input.spill
      .save({ sessionId: input.sessionId, text })
      .then((saved) => {
        input.session.append({
          type: 'tool/result',
          data: {
            turn,
            step,
            message: {
              role: 'user',
              ...(item.message as { toolCallId: string; isError: boolean }),
              content: spillPreview(text, saved.locator),
            },
          },
          surfaceOp: { op: 'replace', start: index, end: index + 1 },
          sourceEventSeqs: [item.sourceSeq],
        })
        // 审计事件：回放时能看出"这条结果被外置过、原文在哪"
        input.session.append({
          type: 'spill/created',
          data: { locator: saved.locator, sourceEventSeq: item.sourceSeq, originalChars: text.length, storedBytes: saved.bytes },
        })
      })
      .catch(() => {
        // best-effort：单条失败保留原文
      })
    lastReplaced = index
  }
  return lastReplaced
}

function parseLocator(locator: string): string {
  const match = /^lcode:\/\/spill\/([0-9a-f-]{36})$/i.exec(locator)
  if (match?.[1] === undefined) throw new Error('invalid spill locator')
  return match[1]
}

function spillPreview(text: string, locator: string): string {
  return `${text.slice(0, 1_600)}\n\n... [${text.length} characters stored as ${locator}; use read({ path: \"${locator}\" }) to retrieve it]`
}
