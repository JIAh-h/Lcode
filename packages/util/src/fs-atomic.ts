import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * 持久化原语（文档 22 §4.3）。
 *
 * **为什么在 `@lcode/util` 里但走子路径导出**：这是三个互不相关的消费者共用的
 * 耐久性原语——会话日志（`session-persistence-jsonl`）、用户设置（`settings-file`）、
 * 凭据文件（`credentials-local`）。放在任何一个消费者里都会造成跨界依赖，
 * 所以提到基础层。又因为 `@lcode/util` 的主入口要保持**可移植**
 * （被渲染层做值导入时不能拖进 `node:fs`），这两个函数走 `@lcode/util/fs-atomic`
 * 子路径——导入哪个模块就只加载哪个模块的依赖。
 *
 * **两条路径，不要混用**：
 * - **整文件重写**（创建、压缩归档、设置落盘、导出）→ `writeFileAtomicSync`：
 *   写 tmp → `fsync(文件)` → `rename` 原子替换 → `fsync(父目录)`。
 * - **滚动追加**（正常写日志）→ `appendFileSyncDurable`：追加 + `fsync`，**不走物化**。
 *
 * Windows 说明：libuv 的 `uv_fs_rename` 在 Win32 上用
 * `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`，因此 Node 的 `renameSync`
 * **可以覆盖**已存在文件——比 22 §4.3 写的「rename 不覆盖」宽松。仍保留退化路径：
 * 万一 rename 失败（被占用/权限），改为「目标改名留底 → 换入新文件 → 删留底」，
 * 保证**不出现半截目标文件**。
 */

const isWindows = process.platform === 'win32'

function safeUnlink(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* 本来就不在 */
  }
}

/** fsync 父目录（POSIX 语义：保证 rename 本身落盘）。Windows 无法打开目录，跳过 */
function fsyncParentDir(dir: string): void {
  if (isWindows) return
  let fd = -1
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    /* 部分文件系统不允许 fsync 目录 */
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** 整文件原子替换。中途断电 → 目标文件要么是旧内容、要么是新内容，**不会半截** */
export function writeFileAtomicSync(target: string, data: string | Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)

  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, buffer, 0, buffer.length, 0)
    fsyncSync(fd) // 内容先落盘，再换名
  } finally {
    closeSync(fd)
  }

  try {
    renameSync(tmp, target)
  } catch (err) {
    if (!isWindows) {
      safeUnlink(tmp)
      throw err
    }
    // 退化路径：目标先改名留底（不是先删），换入新文件，再删留底
    const backup = `${target}.old-${process.pid}-${Date.now()}`
    if (existsSync(target)) renameSync(target, backup)
    try {
      renameSync(tmp, target)
    } finally {
      safeUnlink(backup)
    }
  }
  fsyncParentDir(dirname(target))
}

/**
 * 追加写入 + `fsync`（持久屏障）。返回追加的字节数。
 * 调用方按「一批记录一次调用」使用，不要逐行调用（syscall 开销）。
 */
export function appendFileSyncDurable(file: string, text: string): number {
  const buffer = Buffer.from(text, 'utf8')
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, buffer, 0, buffer.length)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return buffer.length
}
