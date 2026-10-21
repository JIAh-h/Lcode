import { createLocalSubprocess } from '@lcode/subprocess-local'
import type { SandboxStatus } from '@lcode/sandbox'
import { describe, expect, it } from 'vitest'
import { createSubprocessCodeRuntime } from './index.ts'

describe('code-runtime-subprocess', () => {
  it('在强制只读沙箱的子进程中运行，并只经声明 binding 回到宿主', async () => {
    const runtime = createSubprocessCodeRuntime({
      subprocess: createLocalSubprocess(),
      sandbox: {
        status: async () => ({ available: true, mechanism: 'test', knownEscapeSurfaces: [], degraded: false, capabilities: {} } as unknown as SandboxStatus),
        wrap: async (argv) => ({ enforced: true, wrappedArgv: argv }),
      },
      workspaceRoot: process.cwd(),
    })
    const calls: unknown[] = []
    const result = await runtime.run({
      language: 'javascript',
      program: 'console.log("before"); const value = await tools.echo({ text: "ok" }); return { value };',
      bindings: [{ global: 'tools', functions: ['echo'] }],
      async invoke(binding, args) { calls.push({ binding, args }); return { echoed: 'ok' } },
    })
    expect(calls).toEqual([{ binding: 'tools.echo', args: { text: 'ok' } }])
    expect(result).toEqual({ value: { value: { echoed: 'ok' } }, logs: ['before'] })
  })

  it('无真实沙箱时明确拒绝，而不在宿主进程执行代码', async () => {
    const runtime = createSubprocessCodeRuntime({
      subprocess: createLocalSubprocess(),
      sandbox: {
        status: async () => ({ available: false, mechanism: 'none', knownEscapeSurfaces: [], degraded: true, reason: 'missing', capabilities: {} } as unknown as SandboxStatus),
        wrap: async (argv) => ({ enforced: false, wrappedArgv: argv, degradationReason: 'missing native sandbox' }),
      },
      workspaceRoot: process.cwd(),
    })
    await expect(runtime.run({ language: 'javascript', program: 'throw new Error("must not run")', bindings: [], async invoke() { return null } })).resolves.toMatchObject({ error: { code: 'CODE_SANDBOX_UNAVAILABLE' } })
  })
})
