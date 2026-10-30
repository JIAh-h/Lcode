import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { t } from '../i18n/index.ts'
import { buildFileTree, collectDirectoryMarks, countFiles, type FileTreeNode } from '../utils/file-tree.ts'
import { workspaceInfoBridge, type FilePreviewResult, type GitFileKind } from '../store/sessionBridge.ts'

export interface FileMarker {
  readonly kind: GitFileKind
  readonly label: string
}

interface FileTreeProps {
  readonly workspace: string
  readonly markers: ReadonlyMap<string, FileMarker>
  /** 回合结束 / 写入类工具调用后自增，触发重新拉取目录清单 */
  readonly epoch: number
}

const PREVIEW_KB = 256

/**
 * 右侧「文件」面板：整个工作区的文件树（Git 仓库遵守 .gitignore），
 * 点击文件就地展开只读预览。与「变更」互补：这里是全貌，那边是差异。
 */
export function FileTree({ workspace, markers, epoch }: FileTreeProps) {
  const [nodes, setNodes] = useState<readonly FileTreeNode[] | null>(null)
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localEpoch, setLocalEpoch] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('ready')
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    const bridge = workspaceInfoBridge()
    if (bridge === undefined) return
    let alive = true
    setBusy(true)
    setError(null)
    void bridge
      .tree(workspace)
      .then((result) => {
        if (!alive) return
        const built = buildFileTree(result.entries)
        setNodes(built)
        setTotal(countFiles(built))
        setTruncated(result.truncated)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setNodes(null)
        setError(cause instanceof Error ? cause.message : t('读取文件树失败'))
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [workspace, epoch, localEpoch])

  // 换工作区后旧的展开/选中状态没有意义
  useEffect(() => {
    setExpanded(new Set())
    setSelected(null)
    setPreview(null)
  }, [workspace])

  useEffect(() => {
    if (selected === null) {
      setPreview(null)
      return
    }
    const bridge = workspaceInfoBridge()
    if (bridge === undefined) return
    let alive = true
    setPreviewState('loading')
    setPreviewError('')
    setPreview(null)
    void bridge
      .readFile({ workspace, path: selected })
      .then((result) => {
        if (!alive) return
        setPreview(result)
        setPreviewState('ready')
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setPreviewState('error')
        setPreviewError(cause instanceof Error ? cause.message : t('读取文件失败'))
      })
    return () => {
      alive = false
    }
  }, [selected, workspace])

  const toggleDir = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const toggleFile = (path: string): void => {
    setSelected((current) => (current === path ? null : path))
  }

  // 目录本身没有 Git 状态，由子孙文件聚合出来，否则看不出改动埋在哪个目录
  const dirMarks = useMemo(
    () => collectDirectoryMarks([...markers].map(([path, marker]) => [path, marker.kind] as const)),
    [markers],
  )

  const rows: ReactNode[] = []
  const renderLevel = (level: readonly FileTreeNode[], depth: number): void => {
    for (const node of level) {
      const open = node.dir ? expanded.has(node.path) : selected === node.path
      const marker = node.dir ? undefined : markers.get(node.path)
      const dirKind = node.dir ? dirMarks.get(node.path) : undefined
      rows.push(
        <div
          key={node.path}
          className={'ftrow' + (node.dir ? ' dir' : '') + (open ? ' on' : '')}
          style={{ paddingLeft: 6 + depth * 12 }}
          role="button"
          tabIndex={0}
          title={node.path}
          aria-expanded={node.dir ? open : undefined}
          onClick={() => (node.dir ? toggleDir(node.path) : toggleFile(node.path))}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            if (node.dir) toggleDir(node.path)
            else toggleFile(node.path)
          }}
        >
          <span className="ftchev" aria-hidden="true">{node.dir ? (open ? '▾' : '▸') : ''}</span>
          <span className="ftname">{node.name}</span>
          {marker === undefined ? null : <span className={`ftmark ${marker.kind}`}>{marker.label}</span>}
          {dirKind === undefined ? null : (
            <span className="ftdotslot"><span className={`ftdot ${dirKind}`} /></span>
          )}
        </div>,
      )
      if (node.dir) {
        if (open) renderLevel(node.children, depth + 1)
      } else if (selected === node.path) {
        rows.push(
          <div className="ftpreview" key={`${node.path}#preview`}>
            <div className="ftpreview-head">
              <span className="ftpreview-path mono" title={node.path}>{node.path}</span>
              {preview !== null ? <span>{formatBytes(preview.size)}</span> : null}
            </div>
            {previewState === 'loading' ? (
              <div className="ftnote">{t('正在读取文件…')}</div>
            ) : previewState === 'error' ? (
              <div className="ftnote ftnote-error">{previewError}</div>
            ) : preview === null ? null : preview.binary ? (
              <div className="ftnote">{t('二进制文件，无法预览')}</div>
            ) : preview.text === '' ? (
              <div className="ftnote">{t('空文件')}</div>
            ) : (
              <>
                <pre className="ftcode mono">{preview.text}</pre>
                {preview.truncated ? <div className="ftnote">{t('文件过大，只显示前 {n} KB', { n: PREVIEW_KB })}</div> : null}
              </>
            )}
          </div>,
        )
      }
    }
  }
  if (nodes !== null) renderLevel(nodes, 0)

  return (
    <>
      <div className="rscope">
        <span className="chip">{t('工作区')}</span>
        <span className="fws mono" title={workspace}>{workspace}</span>
        <button className="mini gitrefresh" disabled={busy} onClick={() => setLocalEpoch((n) => n + 1)}>
          {busy ? t('刷新中…') : t('刷新')}
        </button>
      </div>
      {error !== null ? (
        <div className="pickhint ftnote-error">{error}</div>
      ) : nodes === null ? (
        <div className="pickhint">{t('正在读取文件树…')}</div>
      ) : nodes.length === 0 ? (
        <div className="pickhint">{t('工作区里没有可显示的文件')}</div>
      ) : (
        <>
          <div className="ftree">{rows}</div>
          <div className="ftfoot">
            {t('{n} 个文件', { n: total })}
            {truncated ? ` · ${t('文件过多，只显示前 {n} 个', { n: total })}` : ''}
          </div>
        </>
      )}
    </>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
