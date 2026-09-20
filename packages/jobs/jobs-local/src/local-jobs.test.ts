import { afterEach, describe, expect, it } from 'vitest'
import { LocalJobsService } from './local-jobs.ts'

const services: LocalJobsService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (jobs) => await jobs.dispose()))
})

function jobs(options: ConstructorParameters<typeof LocalJobsService>[0] = {}): LocalJobsService {
  const service = new LocalJobsService(options)
  services.push(service)
  return service
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return {
    promise,
    resolve(value) { resolve?.(value) },
  }
}

async function nextTask(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('LocalJobsService', () => {
  it('发布后独立运行，支持输出 offset 续读与完成快照', async () => {
    const service = jobs()
    const finish = deferred<{ readonly exitCode: number }>()
    const started = await service.start({
      kind: 'build',
      label: 'pnpm build',
      ownerAgentId: 'agent-a',
      run: async ({ write }) => {
        write('first\n')
        await finish.promise
        write('second\n')
        return { exitCode: 0 }
      },
    })
    await nextTask()

    const first = service.read({ jobId: started.jobId, ownerAgentId: 'agent-a' })
    expect(first).toMatchObject({ output: 'first\n', status: 'running' })
    finish.resolve({ exitCode: 0 })
    await nextTask()

    const resumed = service.read({ jobId: started.jobId, ownerAgentId: 'agent-a', sinceOffset: first.offset })
    expect(resumed).toMatchObject({ output: 'second\n', status: 'completed' })
    expect(service.status({ jobId: started.jobId, ownerAgentId: 'agent-a' })).toMatchObject({
      status: 'completed',
      exitCode: 0,
      ownerAgentId: 'agent-a',
    })
    // 正常完成已经先结算，后来的 kill 不能把已完成作业改写成 killed。
    await expect(service.kill({ jobId: started.jobId, ownerAgentId: 'agent-a' })).resolves.toEqual({ status: 'completed' })
  })

  it('缓冲按 UTF-8 字节上限淘汰旧输出，旧 offset 自动回到保留起点', async () => {
    const service = jobs({ defaultOutputLimitBytes: 5 })
    const finish = deferred<void>()
    const started = await service.start({
      kind: 'watch',
      label: 'bounded output',
      run: async ({ write }) => {
        write('0123456789')
        await finish.promise
      },
    })
    await nextTask()
    const read = service.read({ jobId: started.jobId, sinceOffset: 0 })
    expect(read).toMatchObject({ output: '56789', baseOffset: 5, offset: 10 })
    finish.resolve()
  })

  it('跨 owner 访问被拒，list 只投影自己的作业', async () => {
    const service = jobs()
    const wait = deferred<void>()
    const started = await service.start({
      kind: 'server',
      label: 'dev server',
      ownerAgentId: 'agent-a',
      run: async () => { await wait.promise },
    })
    try {
      expect(() => service.status({ jobId: started.jobId, ownerAgentId: 'agent-b' })).toThrow(expect.objectContaining({ code: 'EP-DENIED_CROSS_SCOPE' }))
      await expect(service.kill({ jobId: started.jobId, ownerAgentId: 'agent-b' })).rejects.toMatchObject({ code: 'EP-DENIED_CROSS_SCOPE' })
      expect(service.list({ ownerAgentId: 'agent-b' })).toEqual([])
      expect(service.list({ ownerAgentId: 'agent-a' })).toHaveLength(1)
    } finally {
      wait.resolve()
    }
  })

  it('kill 与 owner 清理使用作业自身 signal，终态 first-wins', async () => {
    const service = jobs()
    let aborted = false
    const started = await service.start({
      kind: 'test',
      label: 'long test',
      ownerAgentId: 'agent-a',
      run: async ({ signal, write }) => await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
          write('stopped\n')
          resolve()
        }, { once: true })
      }),
    })
    await nextTask()
    await expect(service.kill({ jobId: started.jobId, ownerAgentId: 'agent-a' })).resolves.toEqual({ status: 'killed' })
    expect(aborted).toBe(true)
    expect(service.status({ jobId: started.jobId, ownerAgentId: 'agent-a' }).status).toBe('killed')
    await expect(service.kill({ jobId: started.jobId, ownerAgentId: 'agent-a' })).resolves.toEqual({ status: 'killed' })

    const second = await service.start({
      kind: 'watch',
      label: 'owner cleanup',
      ownerAgentId: 'agent-a',
      run: async ({ signal }) => await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    })
    await nextTask()
    await service.disposeOwner('agent-a')
    expect(service.status({ jobId: second.jobId, ownerAgentId: 'agent-a' }).status).toBe('killed')
  })
})
