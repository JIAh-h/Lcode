/**
 * 上下文窗口的兜底常量。
 *
 * **不再维护"模型族 → 窗口"的表**：窗口以供应商返回的模型信息为准
 * （OpenAI 兼容的 `/models/{id}` 或 `/models` 列表里的 `context_window` /
 * `max_input_tokens` 等字段）。供应商没有返回时才用这里的保守值，并在设置页明确标注。
 */
const FALLBACK_CONTEXT_WINDOW = 128_000

/** 滑块的最小值：再小就没有压缩意义了 */
export const MIN_CONTEXT_WINDOW = 8_192

/** 滑块步进：1 token。上限可能是 1000000 这类非 1024 对齐的值，用大 step 会吸附到 999424 */
export const CONTEXT_WINDOW_STEP = 1

export { FALLBACK_CONTEXT_WINDOW }
