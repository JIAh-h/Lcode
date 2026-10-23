import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentRefsOf, gcAttachments } from '@lcode/session-api'
import { frameToEvent, listSessionFiles, loadLog } from '@lcode/session-persistence-jsonl'
import { trashRoot } from '@lcode/util'

/**
 * 清理所有会话（含归档与回收站）都不再引用的附件。
 *
 * 只要有一个日志读不出来就整体放弃：附件是内容寻址的共享文件，
 * "猜哪些没被引用"删错一次就无法恢复。宁可留下垃圾，也不删活数据。
 */
export function gcSessionAttachments(home: string): { readonly removed: number; readonly bytes: number } {
  const referenced = new Set<string>()
  try {
    for (const { file } of listSessionFiles(home)) {
      const loaded = loadLog(file)
      for (const ref of attachmentRefsOf(loaded.events.map(frameToEvent))) referenced.add(ref.hash)
    }
    const trash = trashRoot(home)
    if (existsSync(trash)) {
      for (const name of readdirSync(trash)) {
        const file = join(trash, name)
        if (!name.includes('.jsonl')) continue
        const loaded = loadLog(file)
        for (const ref of attachmentRefsOf(loaded.events.map(frameToEvent))) referenced.add(ref.hash)
      }
    }
  } catch {
    return { removed: 0, bytes: 0 }
  }
  return gcAttachments({ home, referenced })
}
