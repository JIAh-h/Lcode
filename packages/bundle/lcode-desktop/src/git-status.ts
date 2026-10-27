export type GitFileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface ParsedGitFile {
  readonly path: string
  readonly oldPath?: string | undefined
  readonly index: string
  readonly worktree: string
  readonly raw: string
  readonly kind: GitFileKind
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
  readonly additions?: number | undefined
  readonly deletions?: number | undefined
}

interface Numstat {
  readonly additions?: number | undefined
  readonly deletions?: number | undefined
}

/** 解析 `git status --porcelain=v1 -z`；rename/copy 的第二个 NUL 字段是旧路径。 */
export function parseGitStatusZ(output: string): ParsedGitFile[] {
  const tokens = output.split('\0')
  const files: ParsedGitFile[] = []
  let index = 0
  while (index < tokens.length) {
    const entry = tokens[index]
    index += 1
    if (entry === undefined || entry.length < 3) continue
    const indexStatus = entry[0] ?? ' '
    const worktreeStatus = entry[1] ?? ' '
    if (indexStatus === '!' && worktreeStatus === '!') continue
    const path = entry.slice(3)
    const rename = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const oldPath = rename ? tokens[index++] : undefined
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    const conflicted = isConflict(indexStatus, worktreeStatus)
    files.push({
      path,
      ...(oldPath === undefined || oldPath === '' ? {} : { oldPath }),
      index: indexStatus,
      worktree: worktreeStatus,
      raw: `${indexStatus}${worktreeStatus}`,
      kind: kindOf(indexStatus, worktreeStatus, untracked, conflicted),
      staged: !untracked && indexStatus !== ' ' && indexStatus !== '?',
      unstaged: !untracked && worktreeStatus !== ' ' && worktreeStatus !== '?',
      untracked,
      conflicted,
    })
  }
  return files
}

/**
 * 解析 `git diff [--cached] --numstat -z`。
 * rename 的 -z 形式是 `add\tdel\t\0old\0new\0`，必须按新路径归并。
 */
export function parseGitNumstatZ(output: string): Map<string, Numstat> {
  const tokens = output.split('\0')
  const result = new Map<string, Numstat>()
  let index = 0
  while (index < tokens.length) {
    const entry = tokens[index]
    index += 1
    if (entry === undefined || entry === '') continue
    const firstTab = entry.indexOf('\t')
    const secondTab = entry.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = numberOrUndefined(entry.slice(0, firstTab))
    const deletions = numberOrUndefined(entry.slice(firstTab + 1, secondTab))
    let path = entry.slice(secondTab + 1)
    if (path === '') {
      const oldPath = tokens[index++] ?? ''
      const nextPath = tokens[index++] ?? ''
      if (oldPath === '' || nextPath === '') continue
      path = nextPath
    }
    result.set(path, { additions, deletions })
  }
  return result
}

export function mergeGitNumstat(
  files: readonly ParsedGitFile[],
  staged: ReadonlyMap<string, Numstat>,
  unstaged: ReadonlyMap<string, Numstat>,
): ParsedGitFile[] {
  return files.map((file) => {
    const a = staged.get(file.path)
    const b = unstaged.get(file.path)
    const additions = sumDefined(a?.additions, b?.additions)
    const deletions = sumDefined(a?.deletions, b?.deletions)
    return {
      ...file,
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
    }
  })
}

function kindOf(indexStatus: string, worktreeStatus: string, untracked: boolean, conflicted: boolean): GitFileKind {
  if (conflicted) return 'conflicted'
  if (untracked) return 'untracked'
  if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed'
  if (indexStatus === 'C' || worktreeStatus === 'C') return 'copied'
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added'
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted'
  return 'modified'
}

function isConflict(indexStatus: string, worktreeStatus: string): boolean {
  return indexStatus === 'U' || worktreeStatus === 'U' ||
    (indexStatus === 'A' && worktreeStatus === 'A') ||
    (indexStatus === 'D' && worktreeStatus === 'D')
}

function numberOrUndefined(value: string): number | undefined {
  if (value === '-' || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}
