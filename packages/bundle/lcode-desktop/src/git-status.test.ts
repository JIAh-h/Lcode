import { describe, expect, it } from 'vitest'
import { mergeGitNumstat, parseGitNumstatZ, parseGitStatusZ } from './git-status.ts'

describe('git-status', () => {
  it('解析 rename、untracked 与 staged/unstaged 标志', () => {
    const files = parseGitStatusZ('RM b.txt\0a.txt\0?? u.txt\0')
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({
      path: 'b.txt',
      oldPath: 'a.txt',
      raw: 'RM',
      kind: 'renamed',
      staged: true,
      unstaged: true,
      untracked: false,
    })
    expect(files[1]).toMatchObject({
      path: 'u.txt',
      raw: '??',
      kind: 'untracked',
      staged: false,
      unstaged: false,
      untracked: true,
    })
  })

  it('区分暂存修改、未暂存修改、删除与冲突', () => {
    const files = parseGitStatusZ('M  staged.txt\0 M worktree.txt\0 D deleted.txt\0UU conflict.txt\0')
    expect(files.map((file) => [file.path, file.kind, file.staged, file.unstaged, file.conflicted])).toEqual([
      ['staged.txt', 'modified', true, false, false],
      ['worktree.txt', 'modified', false, true, false],
      ['deleted.txt', 'deleted', false, true, false],
      ['conflict.txt', 'conflicted', true, true, true],
    ])
  })

  it('解析普通与 rename numstat，二进制不伪造行数', () => {
    const normal = parseGitNumstatZ('1\t2\ta.txt\0-\t-\timage.png\0')
    expect(normal.get('a.txt')).toEqual({ additions: 1, deletions: 2 })
    expect(normal.get('image.png')).toEqual({ additions: undefined, deletions: undefined })

    const rename = parseGitNumstatZ('0\t0\t\0old.txt\0new.txt\0')
    expect(rename.get('new.txt')).toEqual({ additions: 0, deletions: 0 })
  })

  it('合并 staged + unstaged 行数', () => {
    const files = parseGitStatusZ('MM a.txt\0')
    const merged = mergeGitNumstat(
      files,
      parseGitNumstatZ('2\t1\ta.txt\0'),
      parseGitNumstatZ('3\t4\ta.txt\0'),
    )
    expect(merged[0]).toMatchObject({ additions: 5, deletions: 5 })
  })
})
