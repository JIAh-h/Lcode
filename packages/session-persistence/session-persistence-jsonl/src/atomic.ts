/**
 * 持久化原语已提到基础层：`@lcode/util/fs-atomic`。
 *
 * 原因：写日志（本包）、写设置（`settings-file`）、写凭据文件（`credentials-local`）
 * 三个互不相关的消费者都要用同一套「tmp → fsync → rename」逻辑。放在任何一个
 * 消费者里都会造成跨界依赖（例如 settings 被迫依赖 session-persistence-jsonl），
 * 所以它属于基础层；又因为 `@lcode/util` 主入口要保持无 `node:fs`，
 * 故走子路径导出。
 *
 * 这里保留再导出，让本包既有的 `import { writeFileAtomicSync } from './atomic.ts'`
 * 与对外 API 都不变。
 */
export { appendFileSyncDurable, writeFileAtomicSync } from '@lcode/util/fs-atomic'
