export interface TurnChange {
  readonly path: string
  readonly additions: number
  readonly deletions: number
}

export interface TurnChangeSummary {
  readonly files: readonly TurnChange[]
  readonly additions: number
  readonly deletions: number
}

/** 同一文件多次修改只算一次，取最后一次的增删行数（diff 卡片是按事件投影的）。 */
export function aggregateTurnChanges(changes: readonly TurnChange[]): TurnChangeSummary {
  const byPath = new Map<string, TurnChange>()
  for (const change of changes) byPath.set(change.path, change)
  const files = [...byPath.values()]
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}
