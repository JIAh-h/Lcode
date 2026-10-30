import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@lcode/session'
import type { ToolCall } from '@lcode/tools'
import { asSessionId } from '@lcode/util'
import { createTodoWriteTool, normalizeTodoItems, renderTodoPrompt } from './index.ts'

function harness() {
  const session = new InMemorySessionStore(asSessionId('s1'))
  const tool = createTodoWriteTool({ getSession: () => session })
  const run = (todos: unknown) =>
    tool.execute(
      { callId: 'c1', name: 'todo_write', arguments: JSON.stringify({ todos }), parsed: { todos } } as ToolCall & { parsed: { todos: unknown } },
      { signal: new AbortController().signal, scope: { sessionId: 's1', agentId: 'a1' } },
    )
  return { session, run }
}

describe('normalizeTodoItems', () => {
  it('规范成带 id 的 TodoItem，并接受常见状态别名', () => {
    const todos = normalizeTodoItems([
      { text: ' 读代码 ', status: 'in_progress' },
      { text: '改代码', status: 'completed' },
      { text: '跑测试' },
    ])
    expect(todos).toEqual([
      { id: 'todo-1', text: '读代码', status: 'in-progress' },
      { id: 'todo-2', text: '改代码', status: 'done' },
      { id: 'todo-3', text: '跑测试', status: 'pending' },
    ])
  })

  it('保留模型给的稳定 id', () => {
    expect(normalizeTodoItems([{ id: 'step-a', text: 'a' }])[0]).toMatchObject({ id: 'step-a' })
  })

  it('非法输入抛错', () => {
    expect(() => normalizeTodoItems('x')).toThrow('数组')
    expect(() => normalizeTodoItems([{ text: '' }])).toThrow('text')
    expect(() => normalizeTodoItems([{ text: 'a', status: 'weird' }])).toThrow('status')
    expect(() => normalizeTodoItems(Array.from({ length: 51 }, () => ({ text: 'x' })))).toThrow('50')
  })
})

describe('todo_write 工具', () => {
  it('整表写入会话事件并返回规范值', async () => {
    const h = harness()
    const result = await h.run([{ text: '步骤一', status: 'in-progress' }])
    expect(result).toEqual({ todos: [{ id: 'todo-1', text: '步骤一', status: 'in-progress' }] })
    const event = h.session.events().find((e) => e.type === 'todo/write')
    expect(event).toMatchObject({ type: 'todo/write', data: { todos: [{ id: 'todo-1', text: '步骤一', status: 'in-progress' }] } })
  })

  it('空数组清空清单；缺会话上下文时报错', async () => {
    const h = harness()
    await h.run([])
    const event = h.session.events().find((e) => e.type === 'todo/write')
    expect(event).toMatchObject({ data: { todos: [] } })
    await expect(
      createTodoWriteTool({ getSession: () => h.session }).execute(
        { callId: 'c2', name: 'todo_write', arguments: '{}', parsed: { todos: [] } } as ToolCall & { parsed: { todos: unknown } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('会话上下文')
  })
})

describe('renderTodoPrompt', () => {
  it('渲染清单并标出状态；空清单不占提示词', () => {
    expect(renderTodoPrompt([])).toBe('')
    const text = renderTodoPrompt([
      { id: 'todo-1', text: '读代码', status: 'done' },
      { id: 'todo-2', text: '改代码', status: 'in-progress' },
      { id: 'todo-3', text: '跑测试', status: 'pending' },
    ])
    expect(text).toContain('- [x] 读代码')
    expect(text).toContain('- [>] 改代码')
    expect(text).toContain('- [ ] 跑测试')
    expect(text).toContain('未完成项要继续推进')
  })
})
