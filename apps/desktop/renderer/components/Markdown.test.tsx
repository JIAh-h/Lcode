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
})
