import { describe, expect, it } from 'vitest'
import { chunkFile } from './chunk.ts'

describe('chunkFile', () => {
  it('按行窗口分块并保留重叠', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)
    const chunks = chunkFile(lines.join('\n'))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 80 })
    expect(chunks[1]?.startLine).toBe(71)
    // 覆盖到文件末尾，且每块内容非空
    expect(chunks.at(-1)?.endLine).toBe(200)
    expect(chunks.every((chunk) => chunk.content.trim() !== '')).toBe(true)
  })

  it('超长行会收窄到字符预算内', () => {
    const content = `${'x'.repeat(20_000)}\nshort line`
    const chunks = chunkFile(content)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.content.length).toBeLessThanOrEqual(6_000)
  })

  it('空白内容不产生分块', () => {
    expect(chunkFile('   \n\n\t')).toEqual([])
  })
})
