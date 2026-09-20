import { describe, expect, it } from 'vitest'
import { createContext } from '@lcode/context'
import { InMemoryToolRegistry } from '@lcode/tools'
import type { ToolCall } from '@lcode/tools'
import type { TerminalService } from '@lcode/terminal'
import { createTerminalTool } from './tools.ts'

function call(args: unknown): ToolCall {
  return { callId: 'terminal-call', name: 'terminal', arguments: JSON.stringify(args) }
}

function harness(): {
  readonly terminals: TerminalService
  readonly opened: Array<{ readonly ownerAgentId: string; readonly cwd?: string | undefined }>
  readonly sent: Array<{ readonly ownerAgentId: string; readonly terminalId: string; readonly data: string }>
  readonly tools: InMemoryToolRegistry
} {
  const opened: Array<{ ownerAgentId: string; cwd?: string | undefined }> = []
  const sent: Array<{ ownerAgentId: string; terminalId: string; data: string }> = []
  const terminals: TerminalService = {
    async open(input) {
      opened.push({ ownerAgentId: input.ownerAgentId, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) })
      return { terminalId: 'term-1' }
    },
    async send(input) {
      sent.push(input)
      return { written: Buffer.byteLength(input.data) }
    },
    async read() {
      return { data: 'terminal output', offset: 15, exited: false }
    },
    async signal() { return { sent: true } },
    async close() { return { closed: true } },
    list(input = {}) {
      return input.ownerAgentId === 'agent-a'
        ? [{ terminalId: 'term-1', ownerAgentId: 'agent-a', cwd: 'D:/repo', shell: 'cmd.exe', offset: 15, exited: false }]
        : []
    },
    async disposeOwner() {},
    async dispose() {},
  }
  const ctx = createContext()
  const tools = new InMemoryToolRegistry(ctx)
  tools.register(createTerminalTool({ terminals, workspaceRoot: 'D:/repo' }))
  return { terminals, opened, sent, tools }
}

function run(h: ReturnType<typeof harness>, args: unknown, scope: unknown = { sessionId: 's1', agentId: 'agent-a' }) {
  return h.tools.execute(call(args), { signal: new AbortController().signal, scope })
}

describe('terminal tool', () => {
  it('从执行 scope 获取 owner，不采信模型提供的 ownerAgentId', async () => {
    const h = harness()
    const result = await run(h, { op: 'open', cwd: 'packages', ownerAgentId: 'agent-other' })
    expect(result).toMatchObject({ ok: true, value: { terminalId: 'term-1' } })
    expect(h.opened).toEqual([{ ownerAgentId: 'agent-a', cwd: 'D:\\repo\\packages' }])
  })

  it('send/read/list 都以当前 agent 作为 owner，read 生成终端卡片输出', async () => {
    const h = harness()
    const sent = await run(h, { op: 'send', terminalId: 'term-1', data: 'echo ok\n' })
    const read = await run(h, { op: 'read', terminalId: 'term-1' })
    const listed = await run(h, { op: 'list' })
    expect(sent).toMatchObject({ ok: true, value: { written: 8 } })
    expect(h.sent).toEqual([{ ownerAgentId: 'agent-a', terminalId: 'term-1', data: 'echo ok\n' }])
    expect(read).toMatchObject({ ok: true, value: { data: 'terminal output', offset: 15 }, meta: { card: 'terminal', stdout: 'terminal output' } })
    expect(listed).toMatchObject({ ok: true, value: { terminals: [{ ownerAgentId: 'agent-a' }] } })
  })

  it('缺少运行时 agent scope 或条件参数时，返回结构化工具错误', async () => {
    const h = harness()
    await expect(run(h, { op: 'open' }, { sessionId: 's1' })).resolves.toMatchObject({ ok: false, error: { code: 'EC-NOT_READY' } })
    await expect(run(h, { op: 'send', terminalId: 'term-1' })).resolves.toMatchObject({ ok: false, error: { code: 'ET-INVALID_ARGS' } })
    await expect(run(h, { op: 'unknown' })).resolves.toMatchObject({ ok: false, error: { code: 'ET-INVALID_ARGS' } })
  })
})
