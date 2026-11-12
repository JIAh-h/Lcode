import { useMemo, useRef, useState } from 'react'
import { t } from '../i18n/index.ts'

/** 一个 diff 块：edit/write 工具结果 meta.hunks 的旧/新行 */
export interface EditedFileHunk {
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
}

export interface EditedFile {
  readonly path: string
  readonly kind: string
  readonly additions: number
  readonly deletions: number
  readonly hunks?: readonly EditedFileHunk[] | undefined
}

/** 单个 diff 块：旧/新行成对，颜色与右侧 Git 工作区（gdiff）一致 */
function HunkView({ hunk }: { readonly hunk: EditedFileHunk }) {
  return (
    <div className="gdiff-part">
      <div className="gdiff-body">
        {hunk.oldLines.map((line, index) => (
          <div className="gline delete" key={`o-${index}`}>
            <span className="old" />
            <span className="new" />
            <span className="mark">-</span>
            <span className="code">{line}</span>
          </div>
        ))}
        {hunk.newLines.map((line, index) => (
          <div className="gline add" key={`n-${index}`}>
            <span className="old" />
            <span className="new" />
            <span className="mark">+</span>
            <span className="code">{line}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 悬停弹窗：显示一个文件的 diff（复用右侧 Git 工作区的 gdiff 观感）。
 * 内部滚动看全量；位置自适应由外层 `.edhover-anchor.above` 控制。
 */
function EditedFileHover({ file }: { readonly file: EditedFile }) {
  const hunks = file.hunks ?? []
  return (
    <div className="edhover-pop" role="tooltip">
      <div className="edhover-head">
        <span className="edhover-path mono" title={file.path}>{file.path}</span>
        <span className="edhover-nums">
          <span className="add">+{file.additions}</span> <span className="del">-{file.deletions}</span>
        </span>
      </div>
      {hunks.length === 0 ? (
        <div className="gdiff-note">{t('这个文件的变更内容不可用（可能是旧会话或非文件工具）')}</div>
      ) : (
        <div className="edhover-diff">
          {hunks.map((hunk, index) => <HunkView hunk={hunk} key={index} />)}
        </div>
      )}
    </div>
  )
}

/** 悬停弹窗的自适应上下翻转逻辑：行太靠视口底部就弹到上方 */
function EditedFileRow({ file }: { readonly file: EditedFile }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [above, setAbove] = useState(false)
  const [hover, setHover] = useState(false)
  const onEnter = (): void => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    // 弹窗高约 320px + 余量；下方放不下且上方放得下就翻上去
    setAbove(window.innerHeight - rect.bottom < 360 && rect.top > 380)
  }
  return (
    <div
      className={'editfiles-row' + (above ? ' flip' : '')}
      ref={rowRef}
      onMouseEnter={() => { onEnter(); setHover(true) }}
      onMouseLeave={() => setHover(false)}
    >
      <span className="editfiles-path mono" title={file.path}>{file.path}</span>
      <span className="editfiles-nums">
        <span className="add">+{file.additions}</span> <span className="del">-{file.deletions}</span>
      </span>
      {hover && <EditedFileHover file={file} />}
    </div>
  )
}

/**
 * 「已编辑 N 个文件」卡片：渲染在**回复末尾**（仿 DSH）。
 *
 * 不再走执行过程组件——被编辑的文件是产物，不是过程；它们有自己的展示位。
 * 每个文件行悬停（无需点击）即弹出 diff 弹窗，内部滚动。
 */
export function EditedFilesCard({ files }: { readonly files: readonly EditedFile[] }) {
  const additions = useMemo(() => files.reduce((sum, file) => sum + file.additions, 0), [files])
  const deletions = useMemo(() => files.reduce((sum, file) => sum + file.deletions, 0), [files])
  return (
    <div className="editfiles">
      <div className="editfiles-head">
        <span>{t('已编辑 {n} 个文件', { n: files.length })}</span>
        <span className="editfiles-nums">
          <span className="add">+{additions}</span> <span className="del">-{deletions}</span>
        </span>
      </div>
      <div className="editfiles-list">
        {files.map((file) => <EditedFileRow file={file} key={file.path} />)}
      </div>
    </div>
  )
}
