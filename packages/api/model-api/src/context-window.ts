/**
 * 上下文窗口的兜底常量。
 *
 * **不再维护"模型族 → 窗口"的表**：窗口以供应商返回的模型信息为准
 * （OpenAI 兼容的 `/models/{id}` 或 `/models` 列表里的 `context_window` /
 * `max_input_tokens` 等字段）。供应商没有返回时才用这里的保守值，并在设置页明确标注。
 *
 * 128K 的取舍：多数自建网关不返回 `context_window`，而现代开源模型
 * （Qwen / DeepSeek / GLM / Kimi）普遍 ≥128K；估小了会让压缩提前触发、
 * 白白丢上下文，估大了只是占用百分比显示偏低。宁大勿小。
 */
const FALLBACK_CONTEXT_WINDOW = 128_000

/** 滑块的最小值：再小就没有压缩意义了 */
export const MIN_CONTEXT_WINDOW = 8_192

/** 滑块步进：1 token。上限可能是 1000000 这类非 1024 对齐的值，用大 step 会吸附到 999424 */
export const CONTEXT_WINDOW_STEP = 1

/**
 * 供应商未报窗口时的**滑块上限**（不是默认值）。
 *
 * 为什么要单独一个：默认值 128K 是"估小了丢上下文、估大了只是百分比偏低"的
 * 兜底；而滑块上限决定用户**能不能往大调**。封在 128K 的话，自建网关跑 256K/1M
 * 模型的用户想调大都调不了（实测反馈）。1M 覆盖当前主流开源模型的最大窗口。
 */
export const CONTEXT_WINDOW_PROBE_MAX = 1_000_000

export { FALLBACK_CONTEXT_WINDOW }
