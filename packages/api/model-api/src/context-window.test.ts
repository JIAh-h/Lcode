import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_STEP, FALLBACK_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from './context-window.ts'

describe('context window constants', () => {
  it('兜底窗口保持保守，滑块步进与最小值合法', () => {
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000)
    expect(MIN_CONTEXT_WINDOW).toBe(8_192)
    expect(CONTEXT_WINDOW_STEP).toBe(1)
  })
})
