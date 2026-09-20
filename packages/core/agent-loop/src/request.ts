import { createHash } from 'node:crypto'
import type { PreparedCall } from '@lcode/llm'
import type { ToolSchema } from '@lcode/tools'
import type { EpochHeader, ModelMessage, RequestHeaderReason, RequestToolSnapshot, SessionEvent } from '@lcode/session'
import type { JsonValue } from '@lcode/util'

/**
 * 请求快照的确定性部分（文档 06 §2.2 `request/header`、09 EpochHeader 骨架）。
 * 全部输入来自日志派生结果——这也是 I1「可重建」的组成部分。
 */

/** system 指纹（装配结果的哈希；system 变了 = 新 epoch） */
export function fingerprintOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** 把工具装配结果变成可持久化的、与运行时无关的请求快照。 */
export function snapshotTools(tools: readonly ToolSchema[]): readonly RequestToolSnapshot[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // `ToolInputSchema` 是 JSON 子集，但接口本身没有索引签名；深拷贝后作为
    // 会话层的 JSON 事实保存，避免 session 反向依赖 `@lcode/tools`。
    inputSchema: structuredCopy(tool.inputSchema) as unknown as JsonValue,
  }))
}

/** 工具清单指纹（包含 schema，任何模型可见变化都会开启新 epoch）。 */
export function toolsFingerprintOf(tools: readonly ToolSchema[]): string {
  return fingerprintOf(JSON.stringify(snapshotTools(tools)))
}

/** 组装一次调用的最终请求体（I1：system / messages 一律来自日志派生，不得从内存拼装） */
export function buildRequestBody(system: string, messages: readonly ModelMessage[], tools: readonly ToolSchema[]): unknown {
  return {
    system,
    messages: messages.map((m) => structuredCopy(m)),
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 把调用配置合并成最终 PreparedCall（协作点替换后的 call + 循环组装的 body） */
export function withBody(call: PreparedCall, body: unknown): PreparedCall {
  return { ...call, request: { ...call.request, body } }
}

/**
 * 请求快照原因（22 §6.2 reason 枚举）：
 * - 日志里没有上一个快照 → `new-epoch`
 * - provider/model 变了 → `model-switch`
 * - system 或工具指纹变了 → `new-epoch`
 * - 其余 → `continuation`
 */
export function headerReason(log: readonly SessionEvent[], header: EpochHeader): RequestHeaderReason {
  let last: { readonly header: EpochHeader } | undefined
  for (const event of log) {
    if (event.type === 'request/header') last = event.data
  }
  if (last === undefined) return 'new-epoch'
  if (last.header.provider !== header.provider || last.header.model !== header.model) return 'model-switch'
  if (last.header.systemFingerprint !== header.systemFingerprint || last.header.toolsFingerprint !== header.toolsFingerprint) {
    return 'new-epoch'
  }
  return 'continuation'
}
