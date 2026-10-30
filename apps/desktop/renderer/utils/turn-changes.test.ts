import { describe, expect, it } from 'vitest'
import { aggregateTurnChanges } from './turn-changes.ts'

describe('aggregateTurnChanges', () => {
  it('同一文件多次修改只算一次，取最后一次的增删行数', () => {
    const summary = aggregateTurnChanges([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'src/b.ts', additions: 2, deletions: 1 },
      { path: 'src/a.ts', additions: 5, deletions: 2 },
    ])
    expect(summary.files).toHaveLength(2)
    expect(summary.files.find((file) => file.path === 'src/a.ts')).toMatchObject({ additions: 5, deletions: 2 })
    expect(summary.additions).toBe(7)
    expect(summary.deletions).toBe(3)
  })

  it('空清单', () => {
    expect(aggregateTurnChanges([])).toEqual({ files: [], additions: 0, deletions: 0 })
  })
})
