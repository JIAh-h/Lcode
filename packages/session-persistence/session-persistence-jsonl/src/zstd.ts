import { createRequire } from 'node:module'
import { ERROR_CODES, LcodeErrorImpl } from '@lcode/util'

/**
 * zstd 编解码（文档 22 §4.1 / §9.4；实施计划 T6.2）。
 *
 * ## 为什么用 WASM 而不是原生模块
 *
 * 会话日志要同时被**两套运行时**读写：系统 Node 22（CLI / vitest，ABI 127）与
 * Electron 内置的 Node 20（桌面主进程，ABI 130）。原生模块一份 `.node` **只能服务一个 ABI**
 * ——`better-sqlite3` 已经因此付了"双构建 + `native.ts` 运行时选择"的代价（docs/24 §7.1）。
 * WASM 没有这个约束：同一份实现两端都能加载（已实测两端往返一致），
 * 且**与原生 `node:zlib` 的 zstd 产物互解**（已实测），于是将来升到 Electron ≥ 35
 * （内置 Node 22.16+）可以直接换成内置实现，不留格式债。
 *
 * `@mongodb-js/zstd` 被排除还有两条独立理由：它仍是原生模块，且 `engines` 要求
 * node ≥ 20.19.0，而 Electron 33 是 20.18.3。
 *
 * ## 同步语义
 *
 * `compress` / `decompress` 本身同步，只有 WASM 模块初始化异步。这里把它收口在一个槽里，
 * 让**调用方保持全同步**——`loadLog()` 是同步 API，为一个"模块已加载"的前置条件把它改成
 * `async` 会牵动一大片（含契约层与全部调用点）。
 *
 * `@bokuweb/zstd-wasm` 的 emscripten 模块内部持有实例，**重复 `init()` 会重新实例化并
 * 丢弃旧实例**（`compress` 会抛 `Aborted()`）。所以初始化只做一次、且必须 await 完成。
 *
 * 就绪性有三种来源，优先级从高到低：
 * 1. 装配层启动时 `await initZstd()`（桌面 / CLI 的正常路径）
 * 2. `ensureZstdReadySync()` 的兜底
 * 3. 都没有 → `compress`/`decompress` 抛 `ES-FORMAT_UNSUPPORTED`（可路由，不静默）
 */

const require = createRequire(import.meta.url)

/** zstd 帧魔数 `0xFD2FB528` 的小端字节序（RFC 8878 §3.1.1） */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const

/** 压缩级别（1–3 是 zstd 的"快"档；会话日志是长文本，默认级别已足够且更快） */
export const DEFAULT_ZSTD_LEVEL = 3

type CompressFn = (input: Uint8Array, level?: number) => Uint8Array
type DecompressFn = (input: Uint8Array, opts?: { defaultHeapSize?: number }) => Uint8Array

export interface ZstdImpl {
  readonly compress: CompressFn
  readonly decompress: DecompressFn
}

let moduleSlot: ZstdImpl | null = null
let syncInitAttempted = false

function zstdUnavailable(cause?: unknown): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.ES_FORMAT_UNSUPPORTED,
    message:
      'zstd 模块未就绪：本进程尚未初始化压缩支持' +
      (cause === undefined ? '' : `（${cause instanceof Error ? cause.message : String(cause)}）`),
    userMessage: '这个对话是压缩归档的，当前环境还不能读取。',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  })
}

/**
 * 初始化 zstd（装配层启动时调用一次）。幂等，且**并发安全**：
 * 多个调用方同时进来只会真的实例化一次。
 */
let inflight: Promise<void> | null = null

export async function initZstd(): Promise<void> {
  if (moduleSlot !== null) return
  if (inflight !== null) return inflight
  inflight = (async () => {
    const wasm = (await import('@bokuweb/zstd-wasm')) as unknown as ZstdImpl & { init: () => Promise<void> }
    await wasm.init()
    moduleSlot = { compress: wasm.compress, decompress: wasm.decompress }
  })()
  try {
    await inflight
  } finally {
    inflight = null
  }
}

/**
 * 同步兜底：用原生 `node:zlib` 的 zstd（Node 22.15+ 提供）。
 *
 * 存在的唯一理由是让 `loadLog()` 保持同步。正常路径（装配层已 `await initZstd()`）
 * 不会走到这里；只有"绕开装配层直接调用"的场景（部分单测、临时脚本）才会。
 *
 * **拿不到就保持未就绪**，不假装成功——`compress`/`decompress` 会给出明确错误。
 * Electron 33 的 Node 20 没有原生 zstd，所以桌面端**必须**走 `initZstd()`。
 */
export function ensureZstdReadySync(): void {
  if (moduleSlot !== null || syncInitAttempted) return
  syncInitAttempted = true
  try {
    const zlib = require('node:zlib') as {
      zstdCompressSync?: (input: Uint8Array) => Buffer
      zstdDecompressSync?: (input: Uint8Array) => Buffer
    }
    const { zstdCompressSync, zstdDecompressSync } = zlib
    if (typeof zstdCompressSync !== 'function' || typeof zstdDecompressSync !== 'function') return
    moduleSlot = {
      compress: (input) => new Uint8Array(zstdCompressSync(input)),
      decompress: (input) => new Uint8Array(zstdDecompressSync(input)),
    }
  } catch {
    // 落到"未就绪"：压缩类操作会给可路由的错误（22 §4.4 的不猜）
  }
}

/** 当前是否有可用的 zstd 实现（诊断用） */
export function zstdReady(): boolean {
  return moduleSlot !== null
}

/** 注入实现（测试用：让"没有 zstd"的分支可被验证） */
export function setZstdForTest(impl: ZstdImpl | null): void {
  moduleSlot = impl
  if (impl !== null) syncInitAttempted = true
}

function requireImpl(): ZstdImpl {
  if (moduleSlot === null) ensureZstdReadySync()
  if (moduleSlot === null) throw zstdUnavailable()
  return moduleSlot
}

/**
 * 压缩（纯函数）。
 *
 * 前置条件是"zstd 已就绪"；**不做隐式异步等待**——同步函数里等不了。
 * 未就绪时抛可路由的错误，由调用方决定重试还是降级。
 */
export function zstdCompress(input: Uint8Array, level: number = DEFAULT_ZSTD_LEVEL): Uint8Array {
  return requireImpl().compress(input, level)
}

/** 解压（纯函数，返回 `Uint8Array`；需要文本时调用方自己 `toString('utf8')`） */
export function zstdDecompress(input: Uint8Array): Uint8Array {
  return requireImpl().decompress(input)
}

/**
 * 内容是否是 zstd 帧：只看**魔数**，不看扩展名。
 *
 * 读路径用它而不是看文件名——`.jsonl.zst` 被改名成 `.jsonl` 不该让加载器按明文解析，
 * 那会产生一堆莫名其妙的"行解析失败"（22 §4.4 的"不猜"）。
 */
export function looksLikeZstd(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  return (
    bytes[0] === ZSTD_MAGIC[0] &&
    bytes[1] === ZSTD_MAGIC[1] &&
    bytes[2] === ZSTD_MAGIC[2] &&
    bytes[3] === ZSTD_MAGIC[3]
  )
}
