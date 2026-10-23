import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, parseMarkdown } from './Markdown.tsx'

describe('Markdown', () => {
  it('解析标题、列表与围栏代码块', () => {
    const blocks = parseMarkdown('# 标题\n\n- 一\n- 二\n\n```ts\nconst a = 1\n```')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'code'])
  })

  it('行内格式渲染成元素而不是原始标记', () => {
    const html = renderToStaticMarkup(<Markdown text={'**粗体** 与 `code` 和 [链接](https://example.com)'} />)
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('**')
  })

  it('模型输出里的 HTML 只作为文本转义，不会执行', () => {
    const html = renderToStaticMarkup(<Markdown text={'<script>alert(1)</script>'} />)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('GFM 表格渲染成 table，含对齐与转义竖线', () => {
    const source = [
      '| 状态 | 表现 | 说明 |',
      '| --- | :---: | ---: |',
      '| 正常 | `a \\| b` | **加粗** |',
      '| 缺列 | |',
    ].join('\n')
    const blocks = parseMarkdown(source)
    expect(blocks[0]?.kind).toBe('table')
    if (blocks[0]?.kind !== 'table') throw new Error('not a table')
    expect(blocks[0].header).toEqual(['状态', '表现', '说明'])
    expect(blocks[0].align).toEqual([null, 'center', 'right'])
    expect(blocks[0].rows[0]).toEqual(['正常', '`a | b`', '**加粗**'])
    expect(blocks[0].rows[1]).toEqual(['缺列', '', ''])

    const html = renderToStaticMarkup(<Markdown text={source} />)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>状态</th>')
    expect(html).toContain('text-align:center')
    expect(html).toContain('text-align:right')
    expect(html).toContain('<code>a | b</code>')
    expect(html).toContain('<strong>加粗</strong>')
  })

  it('分隔线与单行 `---` 不会被误判成表格', () => {
    expect(parseMarkdown('---')[0]?.kind).toBe('hr')
    const blocks = parseMarkdown('正文一段\n---')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'hr'])
  })
})
