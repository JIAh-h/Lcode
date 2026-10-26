import { describe, expect, it, vi } from 'vitest'
import { normalizePath } from '@lcode/fs'
import { resolve } from 'node:path'
import { createContext } from '@lcode/context'
import { createApprovalService } from '@lcode/approval'
import type { ApprovalChannel } from '@lcode/approval'
import type { ApprovalResult, SessionService } from '@lcode/session'
import type { SandboxService, SandboxStatus } from '@lcode/sandbox'
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
  grants: Array<{ sessionId: string; callId: string; paths: readonly string[] }>
  scopes: unknown[]
  events: Array<{ type: string; data: unknown }>
  session: SessionService
  auditEntries: Array<{
    sessionId: string
    workspace: string
    tool: string
    domain: string
    decision: 'allowed' | 'denied'
    url?: string
    detail?: string
  }>
  askCount: number
}

function harness(opts: {
  answer?: ApprovalResult | undefined
  hasChannel?: boolean
  preset?: '只读' | '工作区内修改' | '完全访问'
  workspaceRoot?: string
  sandbox?: SandboxService
  withMutationAuthority?: boolean
  webAllowlist?: {
    listFor(workspace: string): readonly string[]
    add(workspace: string, domains: readonly string[]): void
    removeWorkspace?(workspace: string): void
  }
  networkAudit?: { append(entry: Harness['auditEntries'][number]): void }
  maxWebSearchesPerTurn?: number
}): Harness {
  let askCount = 0
  const ctx = createContext()
  const tools = new InMemoryToolRegistry(ctx)
  const presets = new InMemoryPermissionPresets(opts.preset ?? '工作区内修改')
  const executed: string[] = []
  const grants: Array<{ sessionId: string; callId: string; paths: readonly string[] }> = []
  const scopes: unknown[] = []
  const events: Array<{ type: string; data: unknown }> = []
  const auditEntries: Harness['auditEntries'] = []
  const session = {
    append: (event: { type: string; data: unknown }) => { events.push(event) },
    events: () => events.map((event, index) => ({ ...event, seq: index, time: 0 })),
  } as unknown as SessionService

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
  // 一个 web 工具：申报域名，用于白名单记忆
  tools.register({
    name: 'web',
    description: '访问网页',
    inputSchema: { type: 'object', properties: {} },
    describeAction: () => ({ summary: '访问网页', domains: ['example.com'], url: 'https://example.com/page?q=1' }),
    execute: (_call, opts) => {
      executed.push('web')
      scopes.push(opts.scope)
      return { ok: true }
    },
  })
  // 一个申报 argv 的工具（shell 族）：只读档的沙箱硬约束靠它验收
  tools.register({
    name: 'web_search',
    description: '搜索网页',
    inputSchema: { type: 'object', properties: {} },
    describeAction: () => ({ summary: '搜索网页', domains: ['api.tavily.com'] }),
    execute: () => {
      executed.push('web_search')
      return { ok: true }
    },
  })
  // 一个申报 argv 的工具（shell 族）：只读档的沙箱硬约束靠它验收
  tools.register({
    name: 'shell',
    description: '运行命令',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, network: { type: 'boolean' } }, required: ['command'] },
    describeAction: (parsed) => {
      const p = parsed as { command: string; network?: boolean }
      return {
        summary: `运行 ${p.command}`,
        argv: ['echo', p.command],
        ...(p.network === true ? { network: true } : {}),
      }
    },
    execute: (_call, opts) => {
      executed.push('shell')
      scopes.push(opts.scope)
      return { ok: true }
    },
  })

  const channel: ApprovalChannel | undefined =
    opts.hasChannel === false ? undefined : { ask: async () => { askCount += 1; return opts.answer ?? 'allowed-once' } }
  const approval =
    channel === undefined ? undefined : createApprovalService({ channel })

  installPolicyHook({
    ctx,
    ...(approval === undefined ? {} : { approval }),
    presets,
    ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
    workspaceOf: () => opts.workspaceRoot ?? ROOT,
    getSession: () => session,
    ...(opts.withMutationAuthority === true
      ? { mutationAuthority: { grant: (grant) => { grants.push(grant) }, consume: () => undefined } }
      : {}),
    ...(opts.webAllowlist === undefined ? {} : { webAllowlist: opts.webAllowlist }),
    ...(opts.networkAudit === undefined ? {} : { networkAudit: opts.networkAudit }),
    ...(opts.maxWebSearchesPerTurn === undefined ? {} : { maxWebSearchesPerTurn: opts.maxWebSearchesPerTurn }),
  })

  return {
    ctx,
    tools,
    presets,
    executed,
    grants,
    scopes,
    events,
    session,
    auditEntries,
    get askCount() { return askCount },
    setPreset: (p) => presets.set(p),
  }
}

function degradedSandbox(reason = 'Windows 原生隔离尚未接入'): SandboxService {
  const status: SandboxStatus = {
    available: false,
    mechanism: 'none',
    knownEscapeSurfaces: ['文件系统（无约束）', '进程（无约束）'],
    degraded: true,
    reason,
    providerAvailable: false,
    capabilities: {
      platform: 'win32',
      mechanism: 'none',
      boundaries: {
        filesystem: { state: 'unavailable', plannedMechanism: 'AppContainer', message: '未受约束' },
        network: { state: 'unavailable', plannedMechanism: 'AppContainer', message: '未受约束' },
        spawn: { state: 'unavailable', plannedMechanism: 'Job Object', message: '未受约束' },
      },
      reason,
    },
  }
  return {
    status: async () => status,
    wrap: async (argv) => ({ enforced: false, wrappedArgv: argv, degradationReason: reason }),
  }
}

function availableSandbox(): SandboxService {
  return {
    status: async () => ({
      available: true,
      mechanism: 'AppContainer + Job Object',
      knownEscapeSurfaces: [],
      degraded: false,
      providerAvailable: true,
      capabilities: {
        platform: 'win32',
        mechanism: 'AppContainer + Job Object',
        boundaries: {
          filesystem: { state: 'enforced', plannedMechanism: 'AppContainer', message: '已约束' },
          network: { state: 'enforced', plannedMechanism: 'AppContainer', message: '已约束' },
          spawn: { state: 'enforced', plannedMechanism: 'Job Object', message: '已约束' },
        },
        reason: '',
      },
    }),
    wrap: async (argv) => ({ enforced: true, wrappedArgv: [...argv] }),
  }
}

/** 走真实注册表；scope 就是引擎会传的那个形状 */
function run(h: Harness, name: string, args: unknown, sessionId = 'sess_1'): Promise<Awaited<ReturnType<InMemoryToolRegistry['execute']>>> {
  const call: ToolCall = { callId: 'c1', name, arguments: JSON.stringify(args) }
  return h.tools.execute(call, { signal: new AbortController().signal, scope: { sessionId } })
}

describe('工作区内写：「标准」档放行，且**真的执行了**', () => {
  it('allow → 工具体执行', async () => {
    const h = harness({ preset: '工作区内修改' })
    const r = await run(h, 'write', { path: 'src/a.ts' })
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['src/a.ts'])
  })
})

describe('P5-00：策略放行才签发文件能力', () => {
  it('工作区内 allow 会签发规范化后的精确写路径', async () => {
    const h = harness({ preset: '工作区内修改', withMutationAuthority: true })
    await run(h, 'write', { path: 'src/../approved.ts' })
    expect(h.grants).toEqual([
      { sessionId: 'sess_1', callId: 'c1', paths: [normalizePath(resolve(ROOT, 'approved.ts'))] },
    ])
  })

  it('审批拒绝、缺少通道和不可信工作区都不会签发', async () => {
    const rejected = harness({ answer: 'rejected', withMutationAuthority: true })
    await run(rejected, 'write', { path: '/etc/passwd' })
    expect(rejected.grants).toEqual([])

    const unavailable = harness({ hasChannel: false, withMutationAuthority: true })
    await run(unavailable, 'write', { path: '/etc/passwd' })
    expect(unavailable.grants).toEqual([])
  })
})

describe('P5-00：沙箱降级不能静默放行', () => {
  it('标准档：工作区内写也带着降级影响进入一次审批', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    const executed: string[] = []
    const seen: unknown[] = []
    tools.register({
      name: 'write',
      description: '写',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describeAction: (parsed) => ({ summary: '写入工作区', paths: [{ path: (parsed as { path: string }).path, mode: 'write' as const }] }),
      execute: () => {
        executed.push('write')
        return { ok: true }
      },
    })
    installPolicyHook({
      ctx,
      approval: createApprovalService({ channel: { ask: async (request) => { seen.push(request); return 'allowed-once' } } }),
      presets: new InMemoryPermissionPresets('工作区内修改'),
      sandbox: degradedSandbox(),
      workspaceOf: () => ROOT,
      getSession: () => undefined,
    })
    const result = await tools.execute(
      { callId: 'degraded-standard', name: 'write', arguments: JSON.stringify({ path: 'src/a.ts' }) },
      { signal: new AbortController().signal, scope: { sessionId: 's1' } },
    )
    expect(result.ok).toBe(true)
    expect(executed).toEqual(['write'])
    expect(seen).toMatchObject([{ impact: { sandbox: { status: 'degraded', mechanism: 'none' } } }])
  })


  it('受影响动作落 sandbox/degraded 审计事件', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    const audit: unknown[] = []
    tools.register({
      name: 'write',
      description: '写',
      inputSchema: { type: 'object', properties: {}, required: [] },
      describeAction: () => ({ summary: '写', paths: [{ path: 'a.ts', mode: 'write' as const }] }),
      execute: () => ({ ok: true }),
    })
    const session = { append: (event: unknown) => { audit.push(event); return event } } as unknown as SessionService
    installPolicyHook({
      ctx,
      approval: createApprovalService({ channel: { ask: async () => 'rejected' } }),
      presets: new InMemoryPermissionPresets('工作区内修改'),
      sandbox: degradedSandbox('AppContainer 未启用'),
      workspaceOf: () => ROOT,
      getSession: () => session,
    })
    await tools.execute(
      { callId: 'degraded-audit', name: 'write', arguments: '{}' },
      { signal: new AbortController().signal, scope: { sessionId: 's1' } },
    )
    expect(audit).toContainEqual({ type: 'sandbox/degraded', data: { reason: 'AppContainer 未启用', mechanism: 'none' } })
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

  it('暂停执行会中断正在等待的审批，且工具不执行', async () => {
    const ctx = createContext()
    const tools = new InMemoryToolRegistry(ctx)
    const executed: string[] = []
    tools.register({
      name: 'write',
      description: '写',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      describeAction: (parsed) => ({
        summary: '写',
        paths: [{ path: (parsed as { path: string }).path, mode: 'write' as const }],
      }),
      execute: () => {
        executed.push('write')
        return { ok: true }
      },
    })
    installPolicyHook({
      ctx,
      approval: createApprovalService({
        channel: { ask: async () => new Promise<never>(() => {}) },
      }),
      presets: new InMemoryPermissionPresets('工作区内修改'),
      workspaceOf: () => ROOT,
      getSession: () => undefined,
    })
    const controller = new AbortController()
    const pending = tools.execute(
      { callId: 'wait-approval', name: 'write', arguments: JSON.stringify({ path: '/etc/passwd' }) },
      { signal: controller.signal, scope: { sessionId: 's1' } },
    )
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'ET-DENIED' } })
    expect(executed).toEqual([])
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
      presets: new InMemoryPermissionPresets('工作区内修改'),
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
    expect(request.basis.presetName).toBe('工作区内修改')
    // UI 靠这个字段显著标注（EP-OUTSIDE_WORKSPACE 的要求）
    expect(request.impact.paths?.[0]?.outsideWorkspace).toBe(true)
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
      presets: new InMemoryPermissionPresets('工作区内修改'),
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
      presets: new InMemoryPermissionPresets('工作区内修改'),
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
      presets: new InMemoryPermissionPresets('工作区内修改'),
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

describe('只读档：没有系统级沙箱时不裸跑副作用调用', () => {
  it('shell + 沙箱不可用 → 直接拒绝且不执行', async () => {
    const h = harness({ preset: '只读', sandbox: degradedSandbox() })
    const r = await run(h, 'shell', { command: 'echo hi' })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r.meta)).toContain('只读')
    expect(h.executed).toEqual([])
  })

  it('shell + 沙箱可用 → 放行；OS 只读 ACL 负责拒绝写入', async () => {
    const h = harness({ preset: '只读', sandbox: availableSandbox() })
    const r = await run(h, 'shell', { command: 'echo hi' })
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['shell'])
  })

  it('执行 scope 带上当前预设的沙箱档位', async () => {
    const h = harness({ preset: '完全访问', sandbox: availableSandbox() })
    const r = await run(h, 'shell', { command: 'echo hi' })
    expect(r.ok).toBe(true)
    expect((h.scopes[0] as { sandboxPolicy?: { mode?: string; workspaceRoot?: string } } | undefined)?.sandboxPolicy).toMatchObject({
      mode: 'danger-full-access',
      workspaceRoot: ROOT,
    })
  })
})

describe('shell 联网：按回合一次性授权', () => {
  it('批准后只对本次调用放开网络', async () => {
    const h = harness({ preset: '工作区内修改', sandbox: availableSandbox() })
    const r = await run(h, 'shell', { command: 'curl example.com', network: true })
    expect(r.ok).toBe(true)
    expect(h.executed).toEqual(['shell'])
    expect((h.scopes[0] as { sandboxPolicy?: { allowNetwork?: boolean } }).sandboxPolicy?.allowNetwork).toBe(true)
  })

  it('拒绝审批则不执行，也不放开网络', async () => {
    const h = harness({ preset: '工作区内修改', sandbox: availableSandbox(), answer: 'rejected' })
    const r = await run(h, 'shell', { command: 'curl example.com', network: true })
    expect(r.ok).toBe(false)
    expect(h.executed).toEqual([])
    expect(h.scopes).toEqual([])
  })

  it('未申请联网的命令保持默认拒绝', async () => {
    const h = harness({ preset: '工作区内修改', sandbox: availableSandbox() })
    const r = await run(h, 'shell', { command: 'echo hi' })
    expect(r.ok).toBe(true)
    expect((h.scopes[0] as { sandboxPolicy?: { allowNetwork?: boolean } }).sandboxPolicy?.allowNetwork).toBe(false)
  })

  it('只读档直接拒绝联网', async () => {
    const h = harness({ preset: '只读', sandbox: availableSandbox() })
    const r = await run(h, 'shell', { command: 'curl example.com', network: true })
    expect(r.ok).toBe(false)
    expect(h.executed).toEqual([])
  })
})

describe('web_search 每轮次数上限', () => {
  it('超过上限直接拒绝，不进入审批也不执行', async () => {
    const h = harness({ preset: '工作区内修改', maxWebSearchesPerTurn: 5 })
    for (let index = 1; index <= 6; index += 1) {
      h.session.append({
        type: 'tool/call',
        data: {
          turn: 1,
          step: index,
          // 当前调用是 c1；再补 5 条历史，凑满第 6 次
          callId: index === 6 ? 'c1' : `c${index + 1}`,
          name: 'web_search',
          arguments: '{}',
        },
      } as never)
    }
    const result = await run(h, 'web_search', {})
    expect(result.ok).toBe(false)
    expect(h.executed).toEqual([])
    expect(h.askCount).toBe(0)
    expect(JSON.stringify(result.meta)).toContain('上限')
  })

  it('未超上限时正常走审批和执行', async () => {
    const h = harness({ preset: '工作区内修改', maxWebSearchesPerTurn: 5 })
    for (let index = 1; index <= 5; index += 1) {
      h.session.append({
        type: 'tool/call',
        data: { turn: 1, step: index, callId: `c${index}`, name: 'web_search', arguments: '{}' },
      } as never)
    }
    // 当前调用 c1，加上 4 条历史正好 5 次
    const result = await run(h, 'web_search', {})
    expect(result.ok).toBe(true)
    expect(h.executed).toEqual(['web_search'])
    expect(h.askCount).toBe(1)
  })
})

describe('web 域名白名单', () => {
  it('审批通过后按工作区记住，下次同域名不再询问', async () => {
    const added: Array<{ workspace: string; domains: readonly string[] }> = []
    const first = harness({
      preset: '工作区内修改',
      sandbox: availableSandbox(),
      webAllowlist: { listFor: () => [], add: (workspace, domains) => added.push({ workspace, domains }) },
    })
    expect((await run(first, 'web', {})).ok).toBe(true)
    expect(added).toEqual([{ workspace: ROOT, domains: ['example.com'] }])
    expect(first.askCount).toBe(1)
    expect((first.scopes[0] as { webNetworkPolicy?: unknown }).webNetworkPolicy).toEqual({
      approvedHosts: ['example.com'],
      allowlistedHosts: [],
    })
    expect(first.events).toContainEqual({
      type: 'network/request',
      data: { domain: 'example.com', decision: 'allowed', url: 'https://example.com/page?q=1', detail: 'approved' },
    })

    const secondAudit: Harness['auditEntries'] = []
    const second = harness({
      preset: '工作区内修改',
      sandbox: availableSandbox(),
      webAllowlist: { listFor: () => ['example.com'], add: () => undefined },
      networkAudit: { append: (entry) => secondAudit.push(entry) },
    })
    expect((await run(second, 'web', {})).ok).toBe(true)
    expect(second.askCount).toBe(0)
    expect((second.scopes[0] as { webNetworkPolicy?: unknown }).webNetworkPolicy).toEqual({
      approvedHosts: ['example.com'],
      allowlistedHosts: ['example.com'],
    })
    expect(secondAudit).toContainEqual({
      sessionId: 'sess_1',
      workspace: ROOT,
      tool: 'web',
      domain: 'example.com',
      decision: 'allowed',
      url: 'https://example.com/page?q=1',
      detail: 'allowlisted',
    })
  })

  it('审批通过后写跨会话审计', async () => {
    const audit: Harness['auditEntries'] = []
    const h = harness({
      preset: '工作区内修改',
      sandbox: availableSandbox(),
      networkAudit: { append: (entry) => audit.push(entry) },
    })
    expect((await run(h, 'web', {})).ok).toBe(true)
    expect(audit).toContainEqual({
      sessionId: 'sess_1',
      workspace: ROOT,
      tool: 'web',
      domain: 'example.com',
      decision: 'allowed',
      url: 'https://example.com/page?q=1',
      detail: 'approved',
    })
  })

  it('拒绝审批则不写入白名单', async () => {
    const added: unknown[] = []
    const h = harness({
      preset: '工作区内修改',
      sandbox: availableSandbox(),
      answer: 'rejected',
      webAllowlist: { listFor: () => [], add: (...args) => added.push(args) },
    })
    expect((await run(h, 'web', {})).ok).toBe(false)
    expect(added).toEqual([])
    expect(h.scopes).toEqual([])
    expect(h.events).toContainEqual({
      type: 'network/request',
      data: { domain: 'example.com', decision: 'denied', url: 'https://example.com/page?q=1', detail: 'rejected' },
    })
  })
})
