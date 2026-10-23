import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachmentRefsOf, gcAttachments, putAttachment, readAttachment } from './attachments.ts'
import type { SessionEvent } from '@lcode/session'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-attachments-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('内容寻址附件', () => {
  it('同内容只落一份，可读回；GC 只删无引用项', () => {
    const data = Buffer.from('same-image').toString('base64')
    const first = putAttachment({ home, mediaType: 'image/jpeg', data })
    const second = putAttachment({ home, mediaType: 'image/jpeg', data })
    expect(second.hash).toBe(first.hash)
    expect(readAttachment({ home, hash: first.hash, mediaType: 'image/jpeg' })).toBe(data)

    const orphan = putAttachment({ home, mediaType: 'image/png', data: Buffer.from('orphan').toString('base64') })
    const events = [{
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { role: 'user', content: [{ type: 'image-ref', mediaType: 'image/jpeg', hash: first.hash }] },
    }] as unknown as SessionEvent[]
    expect(attachmentRefsOf(events).map((ref) => ref.hash)).toEqual([first.hash])
    const result = gcAttachments({ home, referenced: new Set([first.hash]) })
    expect(result.removed).toBe(1)
    expect(readAttachment({ home, hash: orphan.hash, mediaType: 'image/png' })).toBeUndefined()
  })

  it('拒绝非法 hash / 媒体类型，不把任意路径当附件', () => {
    expect(readAttachment({ home, hash: '../../etc/passwd', mediaType: 'image/png' })).toBeUndefined()
    expect(readAttachment({ home, hash: 'a'.repeat(64), mediaType: 'text/plain' })).toBeUndefined()
  })
})
