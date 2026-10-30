import { renderToStaticMarkup } from 'react-dom/server'
import type { TodoItem } from '@lcode/session'
import { describe, expect, it } from 'vitest'
import { TurnStatusBar } from './TurnStatusBar.tsx'

const todos: readonly TodoItem[] = [
  { id: 't1', text: '读代码', status: 'done' },
  { id: 't2', text: '改代码', status: 'in-progress' },
  { id: 't3', text: '跑测试', status: 'pending' },
]

describe('TurnStatusBar', () => {
  it('没有任务清单也没有改动时不渲染', () => {
    expect(renderToStaticMarkup(<TurnStatusBar todos={[]} changes={[]} />)).toBe('')
  })

  it('任务清单芯片：进度、当前项，悬停列表里带状态', () => {
    const html = renderToStaticMarkup(<TurnStatusBar todos={todos} changes={[]} />)
    expect(html).toContain('1/3')
    expect(html).toContain('改代码')
    expect(html).toContain('turnchip-done')
    expect(html).toContain('turnchip-in-progress')
    expect(html).toContain('turnchip-pending')
  })

  it('文件芯片：按路径去重、汇总增删、逐文件行', () => {
    const html = renderToStaticMarkup(
      <TurnStatusBar
        todos={[]}
        changes={[
          { path: 'src/a.ts', additions: 3, deletions: 1 },
          { path: 'src/a.ts', additions: 5, deletions: 2 },
          { path: 'src/b.ts', additions: 1, deletions: 0 },
        ]}
      />,
    )
    expect(html).toContain('2 个文件已修改')
    expect(html).toContain('+6')
    expect(html).toContain('-2')
    expect(html).toContain('src/b.ts')
  })

  it('两个芯片可以同时出现', () => {
    const html = renderToStaticMarkup(<TurnStatusBar todos={todos} changes={[{ path: 'a.ts', additions: 1, deletions: 0 }]} />)
    expect(html.match(/turnchip-pop"/g)).toHaveLength(2)
  })
})
