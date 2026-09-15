import { describe, expect, it, vi } from 'vitest'
import { createContext } from '@lcode/context'
import { createApprovalService } from '@lcode/approval'
import type { ApprovalChannel } from '@lcode/approval'
import type { ApprovalResult } from '@lcode/session'
import { InMemoryToolRegistry } from '@lcode/tools'
import type { ToolCall } from '@lcode/tools'
import { InMemoryPermissionPresets } from './permission-presets.ts'
import { installPolicyHook } from './hook.ts'

/**
 * 审批钩子验收（12 §6.4；14 §3.4 的 M-SEC-02/03）。
 *
 * 这一组是**整条权限链的端到端**：`describeAction` → `pre-execute` waterfall →
 * 策略判定 → 审批 → **副作用到底有没有发生**。
 *
 * 最后一点最重要：拒绝必须真的拦住写入，而不只是回一个错误。
 * 只断言"返回了 ET-DENIED"会漏掉"其实文件已经写了"这一类最严重的事故。
 */

const ROOT = '/repo/web'

interface Harness {
  ctx: ReturnType<typeof createContext>
  tools: InMemoryToolRegistry
  presets: InMemoryPermissionPresets
  /** 被实际执行过的调用（用来断言"副作用有没有发生"） */
  executed: string[]
  setPreset(p: Parameters<InMemoryPermissionPresets['set']>[0]): Promise<void>
}

function harness(opts: {
  answer?: ApprovalResult | undefined
  hasChannel?: boolean
  preset?: '只读' | '标准' | '自动' | '完全访问' | '无人值守'
  workspaceRoot?: string
}): Harness {
  const ctx = createContext()
  const tools = new InMemoryToolRegistry(ctx)
  const presets = new InMemoryPermissionPresets(opts.preset ?? '标准')
  const executed: string[] = []

  // 一个"会写文件"的假工具：describeAction 如实申报 write
  tools.register({
    name: 'write',
    description: '写文件',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describeAction: (parsed) => {
      const p = parsed as { path: string }
      return { summary: `写入 ${p.path}`, paths: [{ path: p.path, mode: 'write' as const }] }
    },
    execute: (call) => {
      executed.push((call.parsed as { path: string }).path)
      return { wrote: (call.parsed as { path: string }).path }
    },
  })
  // 一个不申报意图的工具（纯计算）
  tools.register({
    name: 'noop',
    description: '无副作用',
    inputSchema: { type: 'object', properties: {} },
    execute: () => {
      executed.push('noop')
      return { ok: true }
    },
  })

  const channel: ApprovalChannel | undefined =
    opts.hasChannel === false ? undefined : { ask: async () => opts.answer ?? 'allowed-once' }
  const approval =
    channel === undefined ? undefined : createApprovalService({ channel })

  installPolicyHook({
    ctx,
    ...(approval === undefined ? {} : { approval }),
    presets,
    workspaceOf: () => opts.workspaceRoot ?? ROOT,
    getSession: () => undefined,
  })

  return {
    ctx,
    tools,
    presets,
    executed,
    setPreset: (p) => presets.set(p),
  }
}

/** 走真实注册表；scope 就是引擎会传的那个形状 */
function run(h: Harness, name: string, args: unknown, sessionId = 'sess_1'): Promise<Awaited<ReturnType<InMemoryToolRegistry['execute']>>> {
  const call: ToolCall = { callId: 'c1', name, arguments: JSON.stringify(args) }
  return h.tools.execute(call, { signal: new AbortController().signal, scope: { sessionId } })
}

describe('工作区内写：「标准」档放行，且**真的执行了**', () => {
  it('allow → 工具体执行', async () => {
    const h = harness({ preset: '标准' })
    const r = await run(h, 'write', { path: 'src/a.ts' })
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['src/a.ts'])
  })
})

describe('工作区外写：审批通过才执行（M-SEC-02）', () => {
  it('用户允许 → 执行', async () => {
    const h = harness({ answer: 'allowed-once' })
    const r = await run(h, 'write', { path: '/etc/passwd' })
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['/etc/passwd'])
  })

  it('**用户拒绝 → 副作用没有发生**（不只是回了个错）', async () => {
    const h = harness({ answer: 'rejected' })
    const r = await run(h, 'write', { path: '/etc/passwd' })
    expect(r).toMatchObject({ ok: false, error: { code: 'ET-DENIED' } })
    // ⚠️ 这一条是整组测试的重点：文件**没被写**
    expect(h.executed).toEqual([])
  })

  it('**没有审批通道 → 拒绝，且没执行**（fail-closed，D11）', async () => {
    const h = harness({ hasChannel: false })
    const r = await run(h, 'write', { path: '/etc/passwd' })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r.meta)).toContain('没有人能确认')
    expect(h.executed).toEqual([])
  })

  it('取消 → 拒绝，且没执行', async () => {
    const h = harness({ answer: 'cancelled' })
    const r = await run(h, 'write', { path: '/etc/passwd' })
    expect(r.ok).toBe(false)
    expect(h.executed).toEqual([])
  })
})

describe('审批问的是**三段齐备**的问题（SEC-APPROVAL-003）', () => {
  it('action / basis / impact 都到了通道，且 impact 标出工作区外', async () => {
    const seen: unknown[] = []
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    tools.register({
      name: 'write',
      description: '写文件',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describeAction: (parsed) => {
        const p = parsed as { path: string }
        return { summary: `写入 ${p.path}`, paths: [{ path: p.path, mode: 'write' as const }] }
      },
      execute: () => ({ ok: true }),
    })
    const approval = createApprovalService({
      channel: {
        ask: async (request) => {
          seen.push(request)
          return 'allowed-once'
        },
      },
    })
    installPolicyHook({
      ctx,
      approval,
      presets: new InMemoryPermissionPresets('标准'),
      workspaceOf: () => ROOT,
      getSession: () => undefined,
    })
    await tools.execute(
      { callId: 'c1', name: 'write', arguments: JSON.stringify({ path: '/etc/passwd' }) },
      { signal: new AbortController().signal, scope: { sessionId: 's1' } },
    )

    const request = seen[0] as {
      callId: string
      action: { tool: string; summary: string }
      basis: { source: string; presetName?: string }
      impact: { paths?: readonly { path: string; outsideWorkspace: boolean }[] }
    }
    expect(request.callId).toBe('c1')
    expect(request.action.summary).toBe('写入 /etc/passwd')
    expect(request.basis.source).toBe('preset')
    expect(request.basis.presetName).toBe('标准')
    // UI 靠这个字段显著标注（EP-OUTSIDE_WORKSPACE 的要求）
    expect(request.impact.paths?.[0]?.outsideWorkspace).toBe(true)
  })
})

describe('`自动` / `无人值守` 档：直接拒绝，不打扰（12 §3.3）', () => {
  it('越界写 → 拒绝且不执行（never ≠ 放行）', async () => {
    const h = harness({ preset: '自动' })
    const r = await run(h, 'write', { path: '/etc/passwd' })
    expect(r.ok).toBe(false)
    expect(h.executed).toEqual([])
  })

  it('工作区内写仍然放行（这一档的用处就是"别打扰我"）', async () => {
    const h = harness({ preset: '自动' })
    const r = await run(h, 'write', { path: 'src/a.ts' })
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['src/a.ts'])
  })
})

describe('`只读` 档：任何写都拒绝（不是问）', () => {
  it('工作区内写也拒绝，且没执行', async () => {
    const h = harness({ preset: '只读' })
    const r = await run(h, 'write', { path: 'src/a.ts' })
    expect(r.ok).toBe(false)
    expect(h.executed).toEqual([])
  })
})

describe('判不出来就按最保守处理', () => {
  it('没有 scope（拿不到会话身份）→ 拒绝，不执行', async () => {
    const h = harness({})
    const r = await h.tools.execute(
      { callId: 'c1', name: 'write', arguments: JSON.stringify({ path: 'src/a.ts' }) },
      { signal: new AbortController().signal },
    )
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r.meta)).toContain('没有带上会话身份')
    expect(h.executed).toEqual([])
  })

  it('拿不到工作区根 → 拒绝，不执行', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    const executed: string[] = []
    tools.register({
      name: 'write',
      description: '写',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describeAction: (p) => ({ summary: '写', paths: [{ path: (p as { path: string }).path, mode: 'write' as const }] }),
      execute: () => {
        executed.push('x')
        return { ok: true }
      },
    })
    installPolicyHook({
      ctx,
      presets: new InMemoryPermissionPresets('标准'),
      workspaceOf: () => undefined, // 查不到
      getSession: () => undefined,
    })
    const r = await tools.execute(
      { callId: 'c1', name: 'write', arguments: JSON.stringify({ path: 'src/a.ts' }) },
      { signal: new AbortController().signal, scope: { sessionId: 's1' } },
    )
    expect(r.ok).toBe(false)
    expect(executed).toEqual([])
  })
})

describe('不申报意图的工具不受影响', () => {
  it('noop 直接执行（策略不该给无副作用的工具添麻烦）', async () => {
    const h = harness({ hasChannel: false })
    const r = await run(h, 'noop', {})
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['noop'])
  })
})

describe('审批去重：只对**并发**去重，不缓存历史结果', () => {
  it('**并发**执行同一个 callId → 通道只被问一次（不该弹两个框）', async () => {
    const ask = vi.fn(async () => 'allowed-once' as const)
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    tools.register({
      name: 'write',
      description: '写',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describeAction: (p) => ({ summary: '写', paths: [{ path: (p as { path: string }).path, mode: 'write' as const }] }),
      execute: () => ({ ok: true }),
    })
    installPolicyHook({
      ctx,
      approval: createApprovalService({ channel: { ask } }),
      presets: new InMemoryPermissionPresets('标准'),
      workspaceOf: () => ROOT,
      getSession: () => undefined,
    })
    const call: ToolCall = { callId: 'same', name: 'write', arguments: JSON.stringify({ path: '/etc/x' }) }
    const opts = { signal: new AbortController().signal, scope: { sessionId: 's1' } }
    await Promise.all([tools.execute(call, opts), tools.execute(call, opts)])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('**串行**执行同一个 callId → 每次都要重新问（不缓存上一次的答案）', async () => {
    /*
     * `callId` 是**模型生成**的，跨轮重复完全可能。若缓存"已答过的结果"，
     * 第 5 轮的一个动作会沿用第 1 轮用户点过的"允许"——**不再问人**。
     * 那是把一次性审批变成永久授权，方向正好反了（12 §5.1）。
     */
    const ask = vi.fn(async () => 'allowed-once' as const)
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    tools.register({
      name: 'write',
      description: '写',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describeAction: (p) => ({ summary: '写', paths: [{ path: (p as { path: string }).path, mode: 'write' as const }] }),
      execute: () => ({ ok: true }),
    })
    installPolicyHook({
      ctx,
      approval: createApprovalService({ channel: { ask } }),
      presets: new InMemoryPermissionPresets('标准'),
      workspaceOf: () => ROOT,
      getSession: () => undefined,
    })
    const call: ToolCall = { callId: 'same', name: 'write', arguments: JSON.stringify({ path: '/etc/x' }) }
    const opts = { signal: new AbortController().signal, scope: { sessionId: 's1' } }
    await tools.execute(call, opts)
    await tools.execute(call, opts)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
