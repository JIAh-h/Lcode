import { createContext } from '@lcode/context'
import { describe, expect, it } from 'vitest'
import { createModelRouter, registerModelRouter } from './index.ts'

describe('model-router', () => {
  it('首个匹配规则只改写当前回合选择，并继承未显式覆盖的参数', () => {
    const router = createModelRouter({
      rules: [
        { id: 'session-fast', match: { sessionId: 's1', provider: 'primary' }, target: { provider: 'fast', model: 'fast-v1' } },
        { id: 'fallback', target: { provider: 'other', model: 'other-v1' } },
      ],
    })
    const result = router.route({
      agentId: 'a1', sessionId: 's1', turn: 2,
      selection: { provider: 'primary', model: 'primary-v1', params: { temperature: 0.2 } },
    })
    expect(result).toEqual({ provider: 'fast', model: 'fast-v1', params: { temperature: 0.2 } })
    expect(router.rules()).toHaveLength(2)
  })

  it('注销后不再路由后续回合，且不保留可变输入引用', async () => {
    const ctx = createContext()
    const dispose = registerModelRouter({
      ctx,
      routing: createModelRouter({ rules: [{ id: 'route', target: { provider: 'routed', model: 'v2', params: { maxTokens: 42 } } }] }),
    })
    const args = { agentId: 'a1', sessionId: 's1', turn: 1, selection: { provider: 'base', model: 'v1' } }
    const routed = await ctx.waterfall('agent/model-selection', args, undefined, async () => args.selection)
    expect(routed).toEqual({ provider: 'routed', model: 'v2', params: { maxTokens: 42 } })
    dispose()
    const next = { agentId: 'a1', sessionId: 's1', turn: 2, selection: { provider: 'base', model: 'v1' } }
    await expect(ctx.waterfall('agent/model-selection', next, undefined, async () => next.selection)).resolves.toEqual({ provider: 'base', model: 'v1' })
  })
})
