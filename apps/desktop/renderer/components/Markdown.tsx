import { Fragment, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { t } from '../i18n/index.ts'

/**
 * 轻量 Markdown 渲染（不注入 HTML）。
 *
 * 模型输出是不可信内容，所以这里**不使用 dangerouslySetInnerHTML**：
 * 解析成块/行内片段后交给 React 渲染，文本天然转义，链接只放行 http(s) 并走系统浏览器。
 * 支持：围栏代码块、标题、列表、引用、分隔线、GFM 表格、段落；行内代码、粗体、斜体、链接。
 */

export type MdBlock =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][]; align: ('left' | 'center' | 'right' | null)[] }
  | { kind: 'hr' }

/** 行内 `\|` 是字面竖线；用占位符切开单元格后再还原。 */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  if (text === '') return []
  return text
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .map((cell) => cell.trim().replace(/\u0000/g, '|'))
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function alignmentOf(cells: string[]): ('left' | 'center' | 'right' | null)[] {
  return cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let paragraph: string[] = []
  let i = 0
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      flushParagraph()
      i += 1
      continue
    }

    const fence = /^```([\w#+.-]*)\s*$/.exec(line)
    if (fence !== null) {
      flushParagraph()
      const lang = fence[1] ?? ''
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ kind: 'code', lang, text: code.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      i += 1
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      flushParagraph()
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      continue
    }

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      flushParagraph()
      const isOrdered = ordered !== null
      const pattern = isOrdered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
      const items: string[] = []
      while (i < lines.length) {
        const match = pattern.exec(lines[i] ?? '')
        if (match === null) break
        items.push(match[1] ?? '')
        i += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    /* GFM 表格：当前行含 | 且下一行是 `---` 分隔行 */
    const nextLine = lines[i + 1] ?? ''
    if (line.includes('|') && splitRow(line).length > 0 && isDelimiterRow(nextLine)) {
      flushParagraph()
      const header = splitRow(line)
      const align = alignmentOf(splitRow(nextLine))
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const row = lines[i] ?? ''
        const trimmed = row.trim()
        if (trimmed === '' || !row.includes('|')) break
        // 围栏/标题/引用明显不是表格行，停掉避免把后续内容吞进表格
        if (/^```/.test(trimmed) || /^#{1,6}\s/.test(trimmed) || /^\s*>/.test(row)) break
        const cells = splitRow(row)
        // 单元格里有未转义的 | 会多出列：并回最后一列，不丢内容
        if (header.length > 0 && cells.length > header.length) {
          cells.splice(header.length - 1, cells.length - header.length, cells.slice(header.length - 1).join(' | '))
        }
        while (cells.length < header.length) cells.push('')
        rows.push(cells)
        i += 1
      }
      blocks.push({ kind: 'table', header, rows, align })
      continue
    }

    paragraph.push(line)
    i += 1
  }

  flushParagraph()
  return blocks
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g

function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const bridge = (globalThis as unknown as { lcode?: { openExternal?: (target: string) => Promise<unknown> } }).lcode
  if (bridge?.openExternal !== undefined) {
    void bridge.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener')
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    const index = match.index ?? 0
    if (index > last) out.push(text.slice(last, index))
    last = index + token.length
    if (token.startsWith('`')) {
      out.push(<code key={index}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={index}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(<em key={index}>{token.slice(1, -1)}</em>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link === null) {
        out.push(token)
      } else {
        out.push(
          <a
            key={index}
            href={link[2]}
            onClick={(event) => {
              event.preventDefault()
              openExternal(link[2] ?? '')
            }}
          >
            {link[1]}
          </a>,
        )
      }
    }
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => undefined)
  }
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang === '' ? 'text' : lang}</span>
        <button type="button" onClick={copy}>
          {copied ? t('已复制') : t('复制')}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="md">
      {blocks.map((block, index) => {
        if (block.kind === 'code') return <CodeBlock key={index} lang={block.lang} text={block.text} />
        if (block.kind === 'hr') return <hr key={index} />
        if (block.kind === 'heading') {
          const Tag = (`h${Math.min(block.level + 1, 6)}`) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
          return <Tag key={index}>{renderInline(block.text)}</Tag>
        }
        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
        }
        if (block.kind === 'table') {
          const alignStyle = (cellIndex: number): CSSProperties | undefined => {
            const align = block.align[cellIndex] ?? null
            return align === null ? undefined : { textAlign: align }
          }
          return (
            <div className="md-tblwrap" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex} style={alignStyle(cellIndex)}>{renderInline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={alignStyle(cellIndex)}>{renderInline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (block.kind === 'quote') {
          return <blockquote key={index}>{renderInline(block.text)}</blockquote>
        }
        return (
          <p key={index}>
            {block.text.split('\n').map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
