import { describe, expect, it } from 'vitest'
import { compactBlockedReason, isContextTooShort } from './ContextBar.tsx'

describe('ContextBar', () => {
  it('窗口占用不超过 20% 时视为上下文较短，关闭手动压缩', () => {
    expect(isContextTooShort(0.1)).toBe(true)
    expect(isContextTooShort(8)).toBe(true)
    expect(isContextTooShort(20)).toBe(true)
  })

  it('超过 20% 才允许压缩；没有窗口信息时不拦截', () => {
    expect(isContextTooShort(20.1)).toBe(false)
    expect(isContextTooShort(35)).toBe(false)
    expect(isContextTooShort(null)).toBe(false)
  })

  it('任务进行中优先提示运行中，正在压缩时不再叠加提示', () => {
    expect(compactBlockedReason(false, true, false)).toBe('running')
    expect(compactBlockedReason(false, true, true)).toBe('running')
    expect(compactBlockedReason(false, false, true)).toBe('short')
    expect(compactBlockedReason(false, false, false)).toBe(null)
    expect(compactBlockedReason(true, true, true)).toBe(null)
  })
})
