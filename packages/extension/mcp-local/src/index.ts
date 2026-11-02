import type { SpawnedProcess, SubprocessService } from '@lcode/subprocess'
import type { ToolDefinition, ToolRegistry } from '@lcode/tools'
import type {} from '@lcode/context'

/** 一个 MCP 服务（stdio）。命令与参数逐项给出，不接受 shell 字符串。 */
export interface McpServerConfig {
  readonly command: string
  readonly args?: readonly string[] | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  /** 缺省视为启用 */
  readonly enabled?: boolean | undefined
}

export interface McpServerStatus {
  readonly name: string
  readonly command: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly tools: number
  readonly error?: string | undefined
}

export interface McpToolInfo {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export interface McpManagerDeps {
  readonly servers: Readonly<Record<string, McpServerConfig>>
  readonly subprocess: SubprocessService
  readonly workspaceRoot: string
  readonly tools: ToolRegistry
  /** 只读预设下拒绝所有 MCP 工具（服务器无法被 OS 沙箱约束） */
  readonly isReadOnly: () => boolean
  readonly requestTimeoutMs?: number
}

export interface McpManager {
  connect(): Promise<void>
  reload(servers: Readonly<Record<string, McpServerConfig>>): Promise<void>
  status(): readonly McpServerStatus[]
  close(): Promise<void>
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** MCP stdio 使用按行分隔的 JSON-RPC（不是 LSP 的 Content-Length 帧）。 */
class StdioMcpClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stderr = ''
  private closed = false

  constructor(
    private readonly process: SpawnedProcess,
    private readonly timeoutMs: number,
  ) {
    process.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()))
    process.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2_000)
    })
    void process.exited.then(() => this.fail(new Error(`MCP 服务已退出${this.stderr === '' ? '' : `：${this.stderr.trim()}`}`)))
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP 连接已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时（${method}）`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    this.fail(new Error('MCP 连接已关闭'))
    await this.process.killTree().catch(() => undefined)
  }

  private send(message: unknown): void {
    const accepted = this.process.writeStdin?.(`${JSON.stringify(message)}\n`)
    if (accepted !== true) throw new Error('MCP stdin 已关闭')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof message['method'] === 'string') {
        // 服务器发来的请求：用 null 应答，避免卡住；通知直接忽略
        if (message['id'] !== undefined) {
          try {
            this.send({ jsonrpc: '2.0', id: message['id'], result: null })
          } catch {
            // 连接已断开
          }
        }
        continue
      }
      const id = message['id']
      if (typeof id !== 'number') continue
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const error = message['error']
      if (error !== undefined) {
        const text = typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['message'] === 'string'
          ? String((error as Record<string, unknown>)['message'])
          : 'unknown error'
        pending.reject(new Error(`MCP 请求失败：${text}`))
        continue
      }
      pending.resolve(message['result'])
    }
  }

  private fail(reason: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
  }
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
}

/** MCP 的 inputSchema 原样透传；注册表只校验必填字段，复杂约束由服务器自己校验。 */
function adaptSchema(schema: unknown): ToolDefinition['inputSchema'] {
  if (typeof schema !== 'object' || schema === null) return { type: 'object', properties: {} }
  const record = schema as Record<string, unknown>
  const properties = typeof record['properties'] === 'object' && record['properties'] !== null && !Array.isArray(record['properties'])
    ? record['properties'] as ToolDefinition['inputSchema']['properties']
    : {}
  const required = Array.isArray(record['required'])
    ? record['required'].filter((item): item is string => typeof item === 'string')
    : []
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
}

function toolResultValue(result: unknown): { readonly isError: boolean; readonly content: unknown } {
  if (typeof result !== 'object' || result === null) return { isError: false, content: result }
  const record = result as Record<string, unknown>
  return {
    isError: record['isError'] === true,
    content: record['content'] ?? record,
  }
}

export function createMcpManager(deps: McpManagerDeps): McpManager {
  const timeoutMs = deps.requestTimeoutMs ?? 20_000
  let servers = deps.servers
  let clients = new Map<string, { readonly client: StdioMcpClient; readonly tools: number }>()
  let disposers: (() => void)[] = []
  let statuses: McpServerStatus[] = []

  const closeAll = async (): Promise<void> => {
    for (const disposer of disposers) disposer()
    disposers = []
    const current = [...clients.values()]
    clients = new Map()
    for (const entry of current) await entry.client.close()
  }

  const connectServer = async (
    config: McpServerConfig,
  ): Promise<{ readonly client: StdioMcpClient; readonly tools: readonly McpToolInfo[] }> => {
    const env = config.env === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries({ ...process.env, ...config.env })
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
    const child = await deps.subprocess.spawn({
      argv: [config.command, ...(config.args ?? [])],
      cwd: deps.workspaceRoot,
      ...(env === undefined ? {} : { env }),
    })
    const client = new StdioMcpClient(child, timeoutMs)
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lcode', version: '0.1.0' },
      })
      client.notify('notifications/initialized')
      const tools: McpToolInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page += 1) {
        const result = await client.request('tools/list', cursor === undefined ? {} : { cursor })
        const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
        const items = Array.isArray(record['tools']) ? record['tools'] : []
        for (const item of items) {
          if (typeof item !== 'object' || item === null) continue
          const tool = item as Record<string, unknown>
          if (typeof tool['name'] !== 'string' || tool['name'] === '') continue
          tools.push({
            name: tool['name'],
            description: typeof tool['description'] === 'string' ? tool['description'] : '',
            inputSchema: tool['inputSchema'],
          })
        }
        const next = record['nextCursor']
        if (typeof next !== 'string' || next === '') break
        cursor = next
      }
      return { client, tools }
    } catch (error) {
      await client.close()
      throw error
    }
  }

  const connect = async (): Promise<void> => {
    const entries = Object.entries(servers)
    statuses = entries.map(([name, config]) => ({
      name,
      command: config.command,
      enabled: config.enabled !== false,
      connected: false,
      tools: 0,
    }))
    await Promise.all(entries.map(async ([name, config]) => {
      if (config.enabled === false) return
      try {
        const { client, tools } = await connectServer(config)
        clients.set(name, { client, tools: tools.length })
        for (const tool of tools) {
          const toolName = `mcp__${sanitizeToolName(name)}__${sanitizeToolName(tool.name)}`
          const definition: ToolDefinition = {
            name: toolName,
            description: `${tool.description === '' ? tool.name : tool.description}（MCP 服务：${name}）`,
            card: 'generic',
            inputSchema: adaptSchema(tool.inputSchema),
            describeAction: () => ({ summary: `调用 MCP 工具 ${name}/${tool.name}` }),
            execute: async (call) => {
              if (deps.isReadOnly()) throw new Error('只读预设下不调用 MCP 工具（服务器无法被 OS 沙箱约束）')
              const result = await client.request('tools/call', { name: tool.name, arguments: call.parsed })
              return { server: name, tool: tool.name, ...toolResultValue(result) } as never
            },
          }
          disposers.push(deps.tools.register(definition))
        }
        statuses = statuses.map((status) =>
          status.name === name ? { ...status, connected: true, tools: tools.length } : status,
        )
      } catch (error) {
        statuses = statuses.map((status) =>
          status.name === name
            ? { ...status, connected: false, error: error instanceof Error ? error.message : String(error) }
            : status,
        )
      }
    }))
  }

  return {
    connect,
    async reload(nextServers) {
      await closeAll()
      servers = nextServers
      await connect()
    },
    status() {
      return statuses
    },
    async close() {
      await closeAll()
    },
  }
}

declare module '@lcode/context' {
  interface Services {
    /** MCP 连接管理（桌面设置页据此查询状态与重连） */
    mcp: McpManager
  }
}
