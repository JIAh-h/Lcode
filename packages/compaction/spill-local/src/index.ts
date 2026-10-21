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

/** 第二层零模型成本处理：外置原文并以 locator 替换当前可见结果。 */
export function registerLocalSpill(input: { readonly ctx: Context; readonly home: string; readonly thresholdChars?: number | undefined }): Disposer {
  const store = createLocalSpillStore(input.home)
  const threshold = input.thresholdChars ?? 4_000
  const unregisterService = input.ctx.set('spill', store)
  const unregisterEvent = input.ctx.on('agent/tool-result-appended', async ({ sessionId, session, sourceEventSeq, tool }) => {
    if (tool.name === 'read') return
    const source = session.events().find((event) => event.seq === sourceEventSeq)
    if (source?.type !== 'tool/result') return
    const text = source.data.message.content
    if (source.data.message.isError || typeof text !== 'string' || text.length <= threshold) return
    try {
      const saved = await store.save({ sessionId, text })
      const visible = deriveVisibleSurfaceItems(session.events())
      const index = visible.findIndex((item) => isDescendedFrom(session, item.sourceSeq, sourceEventSeq))
      if (index < 0) return
      session.append({
        type: 'tool/result',
        data: { ...source.data, message: { ...source.data.message, content: spillPreview(text, saved.locator) } },
        surfaceOp: { op: 'replace', start: index, end: index + 1 },
        sourceEventSeqs: [sourceEventSeq],
      })
      session.append({ type: 'spill/created', data: { locator: saved.locator, sourceEventSeq, originalChars: text.length, storedBytes: saved.bytes } })
    } catch {
      // spill 是 best-effort：磁盘失败时保留原有可见结果，不把已成功的工具调用变成失败。
    }
  })
  return () => {
    unregisterEvent()
    unregisterService()
  }
}

function isDescendedFrom(session: SessionService, seq: number, sourceSeq: number): boolean {
  if (seq === sourceSeq) return true
  const event = session.events().find((candidate) => candidate.seq === seq)
  return event?.sourceEventSeqs?.includes(sourceSeq) === true
}

function parseLocator(locator: string): string {
  const match = /^lcode:\/\/spill\/([0-9a-f-]{36})$/i.exec(locator)
  if (match?.[1] === undefined) throw new Error('invalid spill locator')
  return match[1]
}

function spillPreview(text: string, locator: string): string {
  return `${text.slice(0, 1_600)}\n\n... [${text.length} characters stored as ${locator}; use read({ path: \"${locator}\" }) to retrieve it]`
}
