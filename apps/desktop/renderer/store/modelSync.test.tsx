import { describe, expect, it } from 'vitest'
import { modelSupportsImages } from './modelSync.ts'

describe('modelSupportsImages', () => {
  it('识别常见视觉模型家族', () => {
    expect(modelSupportsImages('qwen3-vl-plus')).toBe(true)
    expect(modelSupportsImages('qwen3.5-omni-plus')).toBe(true)
    expect(modelSupportsImages('gpt-4o')).toBe(true)
    expect(modelSupportsImages('claude-4-sonnet')).toBe(true)
  })

  it('DeepSeek 的 flash/vision 模型按图片能力处理', () => {
    expect(modelSupportsImages('deepseek-v4.1-flash')).toBe(true)
    expect(modelSupportsImages('deepseek-flash')).toBe(true)
  })

  it('文本模型、embedding/rerank/生成模型不接受图片', () => {
    expect(modelSupportsImages('deepseek-chat')).toBe(false)
    expect(modelSupportsImages('tongyi-embedding-vision-flash')).toBe(false)
    expect(modelSupportsImages('qwen3-vl-rerank')).toBe(false)
    expect(modelSupportsImages('kling/kling-v3-omni-video-generation')).toBe(false)
    expect(modelSupportsImages('')).toBe(false)
  })
})
