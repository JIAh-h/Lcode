import type { GitFileKind } from '../store/sessionBridge.ts'

export interface FileTreeNode {
  readonly name: string
  readonly path: string
  readonly dir: boolean
  readonly children: readonly FileTreeNode[]
}

/** 目录圆点的取色优先级：同一目录下多种状态时取最需要注意的那个 */
const MARK_PRIORITY: Record<GitFileKind, number> = {
  conflicted: 6,
  modified: 5,
  renamed: 4,
  copied: 3,
  deleted: 2,
  added: 1,
  untracked: 1,
}

/** 把文件级 Git 标记向上聚合：每个包含改动的目录得到一条状态，供目录行显示圆点。 */
export function collectDirectoryMarks(files: Iterable<readonly [string, GitFileKind]>): Map<string, GitFileKind> {
  const marks = new Map<string, GitFileKind>()
  for (const [path, kind] of files) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const dir = segments.slice(0, index).join('/')
      if (dir === '') continue
      const current = marks.get(dir)
      if (current === undefined || MARK_PRIORITY[kind] > MARK_PRIORITY[current]) marks.set(dir, kind)
    }
  }
  return marks
}

interface Builder {
  readonly name: string
  readonly path: string
  dir: boolean
  readonly children: Map<string, Builder>
}

const MAX_SEGMENTS = 64

/** 把相对路径清单折成目录树：目录在前、忽略大小写排序；越界路径（含 `..`）整条丢弃。 */
export function buildFileTree(paths: readonly string[]): readonly FileTreeNode[] {
  const root = new Map<string, Builder>()
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw === '') continue
    const segments = raw.replace(/\\/g, '/').split('/')
    if (segments.includes('..')) continue
    const names = segments.filter((segment) => segment !== '' && segment !== '.')
    if (names.length === 0 || names.length > MAX_SEGMENTS) continue
    let level = root
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] ?? ''
      const path = names.slice(0, index + 1).join('/')
      const leaf = index === names.length - 1
      let node = level.get(name)
      if (node === undefined) {
        node = { name, path, dir: !leaf, children: new Map() }
        level.set(name, node)
      } else if (!leaf) {
        node.dir = true
      }
      if (!leaf) level = node.children
    }
  }
  return sortLevel(root)
}

export function countFiles(nodes: readonly FileTreeNode[]): number {
  let count = 0
  for (const node of nodes) count += node.dir ? countFiles(node.children) : 1
  return count
}

function sortLevel(level: Map<string, Builder>): FileTreeNode[] {
  return [...level.values()]
    .sort((left, right) => {
      if (left.dir !== right.dir) return left.dir ? -1 : 1
      const a = left.name.toLowerCase()
      const b = right.name.toLowerCase()
      if (a !== b) return a < b ? -1 : 1
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    .map((node) => ({
      name: node.name,
      path: node.path,
      dir: node.dir,
      children: node.dir ? sortLevel(node.children) : [],
    }))
}
