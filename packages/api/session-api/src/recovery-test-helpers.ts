import { readFileSync } from 'node:fs'
import { loadLog } from '@lcode/session-persistence-jsonl'
import { deriveMessages, type SessionEvent } from '@lcode/session'

/**
 * 恢复测试的读盘辅助。
 *
 * 为什么直接读 JSONL 而不用 `sessions.*`：T6.1 的验收判据是「补出的事件**写回日志**」
 * （11 §6.1），所以断言必须落在**磁盘上的字节**——走 API 读路径会把"内存里有、盘上没有"
 * 这种失败漏掉。这里复用 `loadLog`（与生产读路径同一个解析器），避免测试自己写一套解析。
 */

/** 从磁盘读出会话日志的全部事件（用生产解析器，不做二次解析） */
export function readLogFromDisk(file: string): SessionEvent[] {
  return loadLog(file).events as unknown as SessionEvent[]
}

/** 磁盘上的事件类型序列 */
export function eventTypesOf(file: string): string[] {
  return readLogFromDisk(file).map((event) => event.type)
}

/** 磁盘上的原始行数（含头部帧）——用来断言"没有多写" */
export function lineCountOf(file: string): number {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0).length
}

/** 派生模型可见历史（断言补记没制造非法结构） */
export function deriveFromDisk(file: string): ReturnType<typeof deriveMessages> {
  return deriveMessages(readLogFromDisk(file))
}
