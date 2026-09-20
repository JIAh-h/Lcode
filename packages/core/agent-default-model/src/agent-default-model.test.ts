import { describe, expect, it, vi } from 'vitest'
import { InMemoryAgentDefaultModelService } from './agent-default-model.ts'

describe('InMemoryAgentDefaultModelService', () => {
  it('按作用域解析模型并通知 watcher', async () => {
    const service = new InMemoryAgentDefaultModelService()
    const seen: unknown[] = []
    const dispose = service.watch((selection) => seen.push(selection))
    const selection = { provider: 'replay', model: 'test' }

    expect(service.get()).toBeUndefined()
    await service.set(selection)
    expect(service.get()).toEqual(selection)
    expect(seen).toEqual([selection])

    dispose()
    await service.set({ provider: 'other', model: 'next' })
    expect(seen).toHaveLength(1)
  })

  it('支持父作用域回退和同层后写覆盖', async () => {
    const service = new InMemoryAgentDefaultModelService()
    const parent = { parent: undefined } as unknown as string
    const child = { parent } as unknown as string
    const parentSelection = { provider: 'p', model: 'parent' }
    const childSelection = { provider: 'p', model: 'child' }

    await service.set(parentSelection, parent)
    expect(service.get(child)).toEqual(parentSelection)
    await service.set(childSelection, child)
    expect(service.get(child)).toEqual(childSelection)
    expect(service.get('missing')).toBeUndefined()
    vi.restoreAllMocks()
  })
})
