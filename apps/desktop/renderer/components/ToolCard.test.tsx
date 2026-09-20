import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolResultMessage } from '@lcode/session'
import { describe, expect, it } from 'vitest'
import { ToolCard } from './ToolCard.tsx'

function markup(
  name: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string {
  const message: ToolResultMessage = {
    role: 'user',
    toolCallId: 'call-1',
    content: JSON.stringify(result),
    isError: false,
  }
  return renderToStaticMarkup(
    <ToolCard
      sessionId="session-1"
      call={{ seq: 3, callId: 'call-1', name, arguments: JSON.stringify(args) }}
      result={{ message, meta: result }}
      resultSeq={4}
      initiallyExpanded
    />,
  )
}

describe('ToolCard structural snapshots', () => {
  it('renders read cards with action title and numbered content', () => {
    const html = markup('read', { path: 'src/index.ts' }, {
      card: 'read',
      path: 'src/index.ts',
      lines: [{ number: 1, text: 'export const answer = 42' }],
    })

    expect(html).toContain('toolcard-read')
    expect(html).toContain('读取文件')
    expect(html).toContain('src/index.ts')
    expect(html).toContain('export const answer = 42')
    expect(html).not.toContain('toolcard-title">读取文件 ·')
  })

  it('renders terminal cards with output and exit status', () => {
    const html = markup('shell', { command: 'node test.mjs' }, {
      card: 'terminal',
      description: '运行测试',
      stdout: 'PASS',
      stderr: '',
      exitCode: 0,
    })

    expect(html).toContain('toolcard-terminal')
    expect(html).toContain('运行命令')
    expect(html).toContain('PASS')
    expect(html).toContain('退出码')
    expect(html).not.toContain('toolcard-title">运行命令 ·')
  })

  it('renders published background jobs as an observable task card', () => {
    const html = markup('shell', { command: 'pnpm dev' }, {
      card: 'terminal',
      description: '启动开发服务',
      kind: 'background',
      jobId: 'job-123',
    })

    expect(html).toContain('task-job-card')
    expect(html).toContain('job-123')
    expect(html).toContain('右侧任务面板')
  })

  it('renders diff cards and keeps a large body inside the diff viewport', () => {
    const newLines = Array.from({ length: 240 }, (_, index) => `new line ${index}`)
    const html = markup('write', { path: 'src/large.ts' }, {
      card: 'diff',
      path: 'src/large.ts',
      hunks: [{ oldLines: [], newLines }],
      changes: [{ path: 'src/large.ts', additions: 240, deletions: 0 }],
    })

    expect(html).toContain('toolcard-diff')
    expect(html).toContain('修改文件')
    expect(html).toContain('tool-diff')
    expect(html).toContain('+ new line 239')
    expect(html).toContain('src/large.ts')
    expect(html).not.toContain('toolcard-title">修改文件 ·')
  })

  it('renders search cards with a stable match summary', () => {
    const html = markup('grep', { pattern: 'TODO' }, {
      card: 'search',
      matches: [{ path: 'src/app.ts', line: 7, column: 3, text: '// TODO' }],
    })

    expect(html).toContain('toolcard-search')
    expect(html).toContain('搜索文件')
    expect(html).toContain('TODO')
    expect(html).toContain('src/app.ts:7:3')
    expect(html).not.toContain('toolcard-title">搜索文件 ·')
  })
})
