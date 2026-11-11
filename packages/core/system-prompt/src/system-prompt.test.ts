import { describe, expect, it } from 'vitest'
import { createSystemPromptService } from './system-prompt.ts'
import type { ToolRegistry, ToolSchema } from '@lcode/tools'

const schemas: ToolSchema[] = [
  { name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'write', description: 'write', inputSchema: { type: 'object', properties: {} } },
]

function registry(): ToolRegistry {
  return { schemas: () => schemas } as unknown as ToolRegistry
}

describe('InMemorySystemPromptService', () => {
  it('按顺序组装静态段落、动态上下文和变量', async () => {
    const service = createSystemPromptService(registry())
    const removeBase = service.section('base', 'Hello {{name}}', { order: 2 })
    service.section('first', 'First', { order: 1 })
    service.section('tie', 'Tie', { order: 1 })
    service.section('unknown', '{{unknown}}')
    service.context('dynamic', async (ctx) => `session=${ctx.sessionId};name=${ctx.variables.name}`, { order: 3 })
    service.variable('name', (ctx) => `${ctx.variables.name ?? 'missing'}!`)

    await expect(service.assemble({ variables: { name: 'Ada' }, sessionId: 's1' })).resolves.toEqual({
      system: '\n\nFirst\n\nTie\n\nHello Ada!\n\nsession=s1;name=Ada!',
      volatile: '',
      tools: schemas,
    })
    removeBase()
    expect((await service.assemble({})).system).toContain('First')
    expect((await service.assemble({})).system).not.toContain('{{unknown}}')
  })

  /*
   * 易变段（docs/09 §3.2.2）。
   *
   * 提供方按**前缀**缓存；系统提示词里只要有一个每步都变的东西，缓存就从那个
   * 位置起失效，其后整段历史全价重算。所以会变的内容（任务清单、本轮注入）
   * 必须**离开** `system`，改由引擎拼到消息末尾。
   */
  it('volatile 段落不进 system，单独返回给引擎拼接', async () => {
    const service = createSystemPromptService(registry())
    service.section('base', 'STABLE')
    service.context('todos', () => 'TODO-LIST', { volatile: true, order: 1 })
    service.context('stable-ctx', () => 'STABLE-CTX', { order: 2 })

    const a = await service.assemble({})
    expect(a.system).toContain('STABLE')
    expect(a.system).toContain('STABLE-CTX')
    // 关键：易变段绝不能出现在 system 里
    expect(a.system).not.toContain('TODO-LIST')
    expect(a.volatile).toBe('TODO-LIST')
  })

  it('拒绝重复静态段落，动态段落可替换，撤销只删除自己的注册', async () => {
    const service = createSystemPromptService(registry())
    const remove = service.section('same', 'one')
    expect(() => service.section('same', 'two')).toThrow()
    remove()
    service.context('ctx', () => '')
    const removeContext = service.context('ctx', () => 'two')
    removeContext()
    const removeVariable = service.variable('unused', () => 'value')
    removeVariable()
    expect((await service.assemble({})).system).toBe('')
  })

  it('工具只能逐层收窄，越权扩展时失败', async () => {
    const service = createSystemPromptService(registry())
    const removeFirst = service.tools(['read'])
    expect((await service.assemble({})).tools).toEqual([schemas[0]])
    removeFirst()
    expect((await service.assemble({})).tools).toEqual(schemas)

    service.tools(() => [...schemas, { name: 'delete', description: 'x', inputSchema: { type: 'object', properties: {} } }])
    await expect(service.assemble({})).rejects.toMatchObject({ code: 'EC-VALIDATION_FAILED' })
  })

  it('工具收窄器可按会话上下文过滤，不影响其它会话', async () => {
    const service = createSystemPromptService(registry())
    service.tools((all, ctx) => (ctx.sessionId === 'plan' ? all.filter((tool) => tool.name === 'read') : all))
    await expect(service.assemble({ sessionId: 'plan' })).resolves.toMatchObject({ tools: [schemas[0]] })
    await expect(service.assemble({ sessionId: 'execute' })).resolves.toMatchObject({ tools: schemas })
  })
})
