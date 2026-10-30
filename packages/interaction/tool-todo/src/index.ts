import type { SessionService, TodoItem } from '@lcode/session'
import type { ToolDefinition, ToolRegistry } from '@lcode/tools'
import type { Disposer } from '@lcode/util'

const MAX_ITEMS = 50

/**
 * 模型常见的状态写法都收进来，避免为一个下划线让整次调用失败。
 * 事件里的规范值是 `pending | in-progress | done`（06 §2.2）。
 */
const STATUS_ALIASES: Readonly<Record<string, TodoItem['status']>> = {
  pending: 'pending',
  todo: 'pending',
  'in-progress': 'in-progress',
  in_progress: 'in-progress',
  doing: 'in-progress',
  active: 'in-progress',
  done: 'done',
  completed: 'done',
  complete: 'done',
}

export interface TodoWriteToolDeps {
  readonly getSession: (sessionId: string) => SessionService
}

interface RawTodoItem {
  readonly id?: unknown
  readonly text?: unknown
  readonly status?: unknown
}

/** 把模型给的清单规范成事件里的 TodoItem；不合法就抛错（错误会作为工具结果返回给模型）。 */
export function normalizeTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) throw new Error('todos 必须是数组')
  if (raw.length > MAX_ITEMS) throw new Error(`清单最多 ${MAX_ITEMS} 项，请先合并`)
  return raw.map((value, index) => {
    const item = typeof value === 'object' && value !== null ? (value as RawTodoItem) : {}
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text === '') throw new Error(`第 ${index + 1} 项缺少 text`)
    const status = typeof item.status === 'string' ? STATUS_ALIASES[item.status.trim().toLowerCase()] : undefined
    if (item.status !== undefined && status === undefined) {
      throw new Error(`第 ${index + 1} 项的 status 非法：${String(item.status)}（只接受 pending / in-progress / done）`)
    }
    const id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `todo-${index + 1}`
    return { id, text, status: status ?? 'pending' }
  })
}

/** 清单渲染进系统提示：打断、改方向或压缩后，模型据此恢复剩余工作。 */
export function renderTodoPrompt(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return ''
  const glyph: Record<TodoItem['status'], string> = { pending: '[ ]', 'in-progress': '[>]', done: '[x]' }
  return [
    '## 当前任务清单（最近一次 todo_write）',
    '',
    ...todos.map((todo) => `- ${glyph[todo.status]} ${todo.text}`),
    '',
    '未完成项要继续推进；只有当清单全部完成或用户明确结束任务时才收尾。',
  ].join('\n')
}

function sessionIdOf(scope: unknown): string | undefined {
  const record = typeof scope === 'object' && scope !== null ? (scope as Record<string, unknown>) : null
  const id = record?.['sessionId']
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function createTodoWriteTool(deps: TodoWriteToolDeps): ToolDefinition<{ todos: unknown }, { todos: readonly TodoItem[] }> {
  return {
    name: 'todo_write',
    description:
      '维护本会话的任务清单（整表替换，last-write-wins）。多步骤任务开始时建立清单，每完成一步就更新状态；' +
      '被打断或改变方向后，先看清单里还剩哪些未完成项再继续。每项：{ text: string, status: "pending" | "in-progress" | "done" }；传空数组清空清单。',
    card: 'todo',
    inputSchema: {
      type: 'object',
      properties: {
        todos: { type: 'array', description: '完整清单（整表替换）：每项 { text, status }' },
      },
      required: ['todos'],
    },
    describeAction: (parsed) => ({ summary: `更新任务清单（${Array.isArray(parsed.todos) ? parsed.todos.length : 0} 项）` }),
    execute: async (call, opts) => {
      const sessionId = sessionIdOf(opts.scope)
      if (sessionId === undefined) throw new Error('todo_write 需要会话上下文')
      const todos = normalizeTodoItems(call.parsed.todos)
      deps.getSession(sessionId).append({ type: 'todo/write', data: { todos } })
      return { todos }
    },
    presentationMeta: (_args, value) => {
      const result = typeof value === 'object' && value !== null ? (value as { todos?: unknown }) : {}
      return { items: Array.isArray(result.todos) ? result.todos : [] }
    },
  }
}

export function registerTodoTools(tools: ToolRegistry, deps: TodoWriteToolDeps): Disposer {
  return tools.register(createTodoWriteTool(deps))
}
