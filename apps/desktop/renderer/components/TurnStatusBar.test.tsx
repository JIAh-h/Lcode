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
  it('没有任务清单时不渲染', () => {
    expect(renderToStaticMarkup(<TurnStatusBar todos={[]} />)).toBe('')
  })

  it('任务清单芯片：进度、当前项，悬停列表里带状态', () => {
    const html = renderToStaticMarkup(<TurnStatusBar todos={todos} />)
    expect(html).toContain('1/3')
    expect(html).toContain('改代码')
    expect(html).toContain('turnchip-done')
    expect(html).toContain('turnchip-in-progress')
    expect(html).toContain('turnchip-pending')
  })

  /*
   * 文件变更**不再**出现在这个组件里（docs/10）：被编辑的文件是产物，
   * 渲染在回复末尾的 EditedFilesCard；之前这里聚合文件变更，
   * 用户反馈"这个组件一直在"——状态条只管任务清单。
   */
  it('状态条只承载任务清单，不再显示文件变更', () => {
    const html = renderToStaticMarkup(<TurnStatusBar todos={todos} />)
    expect(html).not.toContain('个文件已修改')
    expect(html).not.toContain('src/b.ts')
    expect(html.match(/turnchip-pop"/g)).toHaveLength(1)
  })
})
