import { describe, expect, it } from 'vitest'
import { buildFileTree, collectDirectoryMarks, countFiles } from './file-tree.ts'

describe('buildFileTree', () => {
  it('按目录折叠、目录在前、忽略大小写排序', () => {
    const tree = buildFileTree(['src/b.ts', 'src/a.ts', 'README.md', 'Apps/x.ts', 'docs/guide/intro.md'])
    expect(tree.map((node) => node.name)).toEqual(['Apps', 'docs', 'src', 'README.md'])
    expect(tree[2]?.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts'])
    expect(tree[1]?.children[0]?.children.map((node) => node.name)).toEqual(['intro.md'])
    expect(tree[2]?.path).toBe('src')
  })

  it('统一分隔符、去重、跳过空段与越界路径', () => {
    const tree = buildFileTree(['src\\a.ts', 'src/a.ts', './src/b.ts', '/src/c.ts', '../evil.ts', '', 'src//d.ts'])
    expect(tree.map((node) => node.name)).toEqual(['src'])
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
  })

  it('同名文件与目录共存时按目录处理并保留子节点', () => {
    const tree = buildFileTree(['sub', 'sub/child.ts'])
    expect(tree[0]?.dir).toBe(true)
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['child.ts'])
  })

  it('统计文件数', () => {
    expect(countFiles(buildFileTree(['a/b.ts', 'c.ts']))).toBe(2)
    expect(countFiles([])).toBe(0)
  })
})

describe('collectDirectoryMarks', () => {
  it('把文件状态向上聚合到每一层目录', () => {
    const marks = collectDirectoryMarks([
      ['apps/desktop/main.ts', 'modified'],
      ['docs/guide.md', 'untracked'],
    ])
    expect(marks.get('apps')).toBe('modified')
    expect(marks.get('apps/desktop')).toBe('modified')
    expect(marks.get('docs')).toBe('untracked')
    expect(marks.has('main.ts')).toBe(false)
  })

  it('同一目录多种状态时取优先级最高的', () => {
    const marks = collectDirectoryMarks([
      ['src/a.ts', 'untracked'],
      ['src/b.ts', 'deleted'],
      ['src/c.ts', 'modified'],
      ['lib/x.ts', 'conflicted'],
      ['lib/y.ts', 'modified'],
    ])
    expect(marks.get('src')).toBe('modified')
    expect(marks.get('lib')).toBe('conflicted')
  })

  it('根目录文件不产生目录标记', () => {
    expect(collectDirectoryMarks([['a.ts', 'modified']]).size).toBe(0)
  })
})
