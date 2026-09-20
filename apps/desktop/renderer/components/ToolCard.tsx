import { useState } from 'react'
import type { ReactNode } from 'react'
import type { CardType, ModelMessage, ToolResultMessage } from '@lcode/session'
import { t } from '../i18n/index.ts'
import { sessionBridge, type HistoryBodyResult } from '../store/sessionBridge.ts'

export interface ToolCardCall {
  readonly seq: number
  readonly callId: string
  readonly name: string
  readonly card?: string | undefined
  readonly arguments: string
}

export interface ToolCardResult {
  readonly message: ToolResultMessage
  readonly meta?: unknown
  readonly error?: { readonly name: string; readonly code: string } | undefined
}

interface ToolCardProps {
  readonly sessionId: string
  readonly call: ToolCardCall
  readonly result?: ToolCardResult | undefined
  readonly resultSeq?: number | undefined
  /** 测试用初始展开状态；生产默认收起，避免过程信息抢占主内容。 */
  readonly initiallyExpanded?: boolean | undefined
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

function textFromContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (typeof block === 'object' && block !== null && block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('')
}

function jsonRecord(text: string): JsonRecord | null {
  try {
    return record(JSON.parse(text))
  } catch {
    return null
  }
}

function knownCard(value: unknown): CardType | undefined {
  return value === 'generic' || value === 'terminal' || value === 'diff' || value === 'search' || value === 'read' || value === 'web'
    ? value
    : undefined
}

function cardType(call: ToolCardCall, result: ToolCardResult | undefined): CardType {
  const meta = record(result?.meta)
  const fromCall = knownCard(call.card)
  const fromMeta = knownCard(meta?.['card'])
  if (fromCall !== undefined) return fromCall
  if (fromMeta !== undefined) return fromMeta
  if (call.name === 'shell') return 'terminal'
  if (call.name === 'read') return 'read'
  if (call.name === 'write' || call.name === 'edit') return 'diff'
  if (call.name === 'glob' || call.name === 'grep') return 'search'
  return 'generic'
}

function cardLabel(card: CardType): string {
  return t(
    card === 'terminal'
      ? '运行命令'
      : card === 'diff'
        ? '修改文件'
        : card === 'search'
          ? '搜索文件'
          : card === 'read'
            ? '读取文件'
            : card === 'web'
              ? '打开网页'
              : '执行操作',
  )
}

function resultData(result: ToolCardResult | undefined): JsonRecord | null {
  if (result === undefined) return null
  const meta = record(result.meta)
  if (meta !== null && Object.keys(meta).some((key) => key !== 'card')) return meta
  return jsonRecord(textFromContent(result.message.content))
}

function callArgs(call: ToolCardCall): JsonRecord | null {
  return jsonRecord(call.arguments)
}

function summary(call: ToolCardCall, result: ToolCardResult | undefined, card: CardType): string {
  const args = callArgs(call)
  const data = resultData(result)
  if (card === 'terminal') return String(data?.['description'] ?? args?.['description'] ?? t('命令执行中'))
  if (card === 'read') return String(data?.['path'] ?? args?.['path'] ?? t('文件内容'))
  if (card === 'diff') return String(data?.['path'] ?? args?.['path'] ?? t('文件变更'))
  if (card === 'search') return String(args?.['pattern'] ?? args?.['path'] ?? t('匹配文件'))
  if (card === 'web') return String(args?.['url'] ?? t('网页内容'))
  return String(data?.['summary'] ?? args?.['description'] ?? t('操作已完成'))
}

function ReadBody({ data }: { readonly data: JsonRecord }): ReactNode {
  const lines = Array.isArray(data['lines']) ? data['lines'] : []
  if (lines.length === 0) return <pre className="toolcard-pre mono">{JSON.stringify(data, null, 2)}</pre>
  return (
    <div className="tool-read-body mono">
      {lines.map((line, index) => {
        const item = record(line)
        return (
          <div className="tool-read-line" key={index}>
            <span className="tool-line-no">{String(item?.['number'] ?? '')}</span>
            <span>{String(item?.['text'] ?? '')}</span>
          </div>
        )
      })}
    </div>
  )
}

function TerminalBody({ data }: { readonly data: JsonRecord }): ReactNode {
  if (data['kind'] === 'background') {
    return (
      <div className="toolcard-text task-job-card">
        <div>{t('已在后台运行')} · <code>{String(data['jobId'] ?? '')}</code></div>
        <div className="toolcard-status">{t('可在右侧任务面板读取输出或停止作业')}</div>
      </div>
    )
  }
  const output = `${String(data['stdout'] ?? '')}${String(data['stderr'] ?? '')}`.trim()
  return (
    <>
      <pre className="toolcard-pre mono">{output || t('（没有输出）')}</pre>
      <div className="toolcard-status">
        {t('退出码')} {String(data['exitCode'] ?? '')}
        {data['timedOut'] === true ? ` · ${t('超时')}` : ''}
        {data['aborted'] === true ? ` · ${t('已中止')}` : ''}
      </div>
    </>
  )
}

function DiffBody({ data }: { readonly data: JsonRecord }): ReactNode {
  const hunks = Array.isArray(data['hunks']) ? data['hunks'] : []
  if (hunks.length === 0) {
    const changes = Array.isArray(data['changes']) ? data['changes'] : []
    return <pre className="toolcard-pre mono">{JSON.stringify(changes.length > 0 ? changes : data, null, 2)}</pre>
  }
  return (
    <div className="tool-diff mono">
      {hunks.map((hunk, index) => {
        const item = record(hunk)
        const oldLines = Array.isArray(item?.['oldLines']) ? item['oldLines'] : []
        const newLines = Array.isArray(item?.['newLines']) ? item['newLines'] : []
        return (
          <div key={index}>
            {oldLines.map((line, lineIndex) => <div className="tool-diff-line del" key={`old-${lineIndex}`}>- {String(line)}</div>)}
            {newLines.map((line, lineIndex) => <div className="tool-diff-line add" key={`new-${lineIndex}`}>+ {String(line)}</div>)}
          </div>
        )
      })}
    </div>
  )
}

function SearchBody({ data }: { readonly data: JsonRecord }): ReactNode {
  if (Array.isArray(data['matches'])) {
    return (
      <div className="tool-search-body mono">
        {(data['matches'] as unknown[]).map((match, index) => {
          const item = record(match)
          return <div key={index}>{String(item?.['path'] ?? '')}:{String(item?.['line'] ?? '')}:{String(item?.['column'] ?? '')} {String(item?.['text'] ?? '')}</div>
        })}
      </div>
    )
  }
  if (Array.isArray(data['paths'])) return <pre className="toolcard-pre mono">{(data['paths'] as unknown[]).map(String).join('\n')}</pre>
  return <pre className="toolcard-pre mono">{JSON.stringify(data, null, 2)}</pre>
}

function ResultBody({ card, result }: { readonly card: CardType; readonly result: ToolCardResult }): ReactNode {
  const data = resultData(result)
  if (result.message.isError) {
    return <pre className="toolcard-pre tool-error mono">{textFromContent(result.message.content)}</pre>
  }
  if (data === null) return <pre className="toolcard-pre mono">{textFromContent(result.message.content)}</pre>
  if (card === 'read') return <ReadBody data={data} />
  if (card === 'terminal') return <TerminalBody data={data} />
  if (card === 'diff') return <DiffBody data={data} />
  if (card === 'search') return <SearchBody data={data} />
  return <pre className="toolcard-pre mono">{JSON.stringify(data, null, 2)}</pre>
}

export function ToolCard({ sessionId, call, result, resultSeq, initiallyExpanded = false }: ToolCardProps) {
  const card = cardType(call, result)
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [why, setWhy] = useState<unknown>(undefined)
  const [whyLoading, setWhyLoading] = useState(false)
  const [whyError, setWhyError] = useState<string | null>(null)
  const [body, setBody] = useState<HistoryBodyResult | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const data = resultData(result)
  const pending = result === undefined
  const failed = result?.message.isError === true

  const loadWhy = (): void => {
    const api = sessionBridge()
    if (api === undefined || whyLoading) return
    setWhyLoading(true)
    setWhyError(null)
    void api.why({ session_id: sessionId, call_seq: call.seq })
      .then(setWhy)
      .catch((error: unknown) => setWhyError(error instanceof Error ? error.message : String(error)))
      .finally(() => setWhyLoading(false))
  }

  const loadBody = (): void => {
    const api = sessionBridge()
    if (api === undefined || resultSeq === undefined || bodyLoading) return
    setBodyLoading(true)
    setBodyError(null)
    void api.body({ session_id: sessionId, seq: resultSeq })
      .then(setBody)
      .catch((error: unknown) => setBodyError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBodyLoading(false))
  }

  return (
    <article className={`toolcard toolcard-${card}${pending ? ' pending' : ''}${failed ? ' failed' : ''}`}>
      <button className="toolcard-head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className="toolcard-marker">{pending ? '…' : failed ? '!' : '✓'}</span>
        <span className="toolcard-title">{cardLabel(card)}</span>
        <span className="toolcard-summary">{summary(call, result, card)}</span>
        <span className="toolcard-chevron">{expanded ? '⌃' : '⌄'}</span>
      </button>
      {expanded && (
        <div className="toolcard-content">
          {pending ? <div className="toolcard-pending">{t('正在执行…')}</div> : <ResultBody card={card} result={result} />}
          {result?.error !== undefined && <div className="toolcard-status tool-error">{result.error.code}</div>}
          <details className="toolcard-raw">
            <summary>{t('查看原始参数')}</summary>
            <pre className="toolcard-pre mono">{call.arguments}</pre>
          </details>
          <div className="toolcard-actions">
            <button className="btn" disabled={pending || whyLoading} onClick={loadWhy}>
              {whyLoading ? t('读取中…') : t('为什么')}
            </button>
            {resultSeq !== undefined && (
              <button className="btn" disabled={bodyLoading} onClick={loadBody}>
                {bodyLoading ? t('读取中…') : t('查看完整正文')}
              </button>
            )}
          </div>
          {whyError !== null && <div className="toolcard-feedback tool-error">{whyError}</div>}
          {why !== undefined && <pre className="toolcard-pre toolcard-feedback mono">{JSON.stringify(why, null, 2)}</pre>}
          {bodyError !== null && <div className="toolcard-feedback tool-error">{bodyError}</div>}
          {body !== null && <pre className="toolcard-pre toolcard-feedback mono">{JSON.stringify(body.data, null, 2)}</pre>}
        </div>
      )}
      {data?.['truncated'] === true && <div className="toolcard-truncated">{t('结果已截断，展开后可按需读取')}</div>}
    </article>
  )
}
