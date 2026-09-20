import type { SpawnedPty, SubprocessService } from '@lcode/subprocess'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import type { TerminalInfo, TerminalOpenInput, TerminalReadResult, TerminalService } from '@lcode/terminal'
import { ERROR_CODES, LcodeErrorImpl, newId } from '@lcode/util'
import { resolve } from 'node:path'

const DEFAULT_MAX_TERMINALS = 8
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000

export interface LocalTerminalOptions {
  /** 新终端的默认工作目录。 */
  readonly workspaceRoot: string
  /** 进程内同时存活的终端上限。 */
  readonly maxTerminals?: number | undefined
  /** 每个终端保留的输出环形缓冲上限。 */
  readonly maxOutputBytes?: number | undefined
  /** PTY Provider；缺少此能力时明确拒绝，不能在终端层回退为裸启动。 */
  readonly subprocess?: SubprocessService | undefined
  /**
   * 可选的系统级沙箱状态来源。降级环境仍由权限钩子做一次性审批；但 Provider 一旦
   * 声称已强制隔离，PTY 必须由同一原生 Provider 创建，不能继续退回 node-pty。
   */
  readonly sandbox?: PtySandboxStatusSource | undefined
}

export interface PtySandboxStatusSource {
  status(): Promise<{ readonly degraded: boolean; readonly reason?: string | undefined }>
  wrapPty?(argv: readonly string[], policy: PtySandboxPolicy): Promise<PtySandboxWrapResult>
}

/** 终端只需要这一小段沙箱契约，避免 terminal 层反向依赖平台 Provider。 */
interface PtySandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot: string
}

interface PtySandboxWrapResult {
  readonly enforced: boolean
  readonly wrappedArgv: readonly string[]
  readonly degradationReason?: string | undefined
}

interface OutputChunk {
  readonly start: number
  readonly data: Buffer
}

interface TerminalRecord {
  readonly terminalId: string
  readonly ownerAgentId: string
  readonly cwd: string
  readonly shell: string
  readonly pty: SpawnedPty
  readonly chunks: OutputChunk[]
  baseOffset: number
  offset: number
  bufferedBytes: number
  exited: boolean
  exitCode: number | undefined
  closed: boolean
}

/**
 * 进程内 PTY 注册表。它刻意不负责审批或沙箱策略：调用方须在 open 之前完成
 * 权限决策；这里的边界是 owner 隔离、生命周期和可断点读取。
 */
export class LocalTerminalService implements TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly maxTerminals: number
  private readonly maxOutputBytes: number
  private readonly subprocess: SubprocessService
  private readonly sandbox: PtySandboxStatusSource | undefined

  constructor(private readonly options: LocalTerminalOptions) {
    this.maxTerminals = options.maxTerminals ?? DEFAULT_MAX_TERMINALS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.subprocess = options.subprocess ?? createLocalSubprocess()
    this.sandbox = options.sandbox
    if (!Number.isInteger(this.maxTerminals) || this.maxTerminals < 1) {
      throw invalidParams('maxTerminals 必须是正整数')
    }
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw invalidParams('maxOutputBytes 必须是正整数')
    }
  }

  async open(input: TerminalOpenInput): Promise<{ readonly terminalId: string }> {
    assertOwner(input.ownerAgentId)
    if (this.terminals.size >= this.maxTerminals) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EJ_LIMIT_REACHED,
        message: `终端数量已达到上限 ${this.maxTerminals}`,
        userMessage: '已打开的终端太多，请先关闭一个终端。',
      })
    }

    const cwd = resolve(input.cwd ?? this.options.workspaceRoot)
    const shell = input.shell ?? defaultShell()
    const terminalId = `term-${newId(16).toLowerCase()}`
    const launch = await this.preparePtyLaunch(shell, cwd)
    const spawnPty = this.subprocess.spawnPty
    if (spawnPty === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: '当前子进程 Provider 不支持受控 PTY',
        userMessage: '当前安全环境不支持打开交互终端。',
      })
    }
    let pty: SpawnedPty
    try {
      pty = await spawnPty({
        shell: launch.argv[0]!,
        ...(launch.argv.length === 1 ? {} : { args: launch.argv.slice(1) }),
        cols: 100,
        rows: 30,
        cwd,
        env: terminalEnv(),
      })
    } catch (cause) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EF_PERMISSION_DENIED,
        message: `无法启动终端 shell：${shell}`,
        userMessage: '无法启动这个终端。',
        cause,
      })
    }

    const record: TerminalRecord = {
      terminalId,
      ownerAgentId: input.ownerAgentId,
      cwd,
      shell,
      pty,
      chunks: [],
      baseOffset: 0,
      offset: 0,
      bufferedBytes: 0,
      exited: false,
      exitCode: undefined,
      closed: false,
    }
    this.terminals.set(terminalId, record)
    pty.onData((data) => this.appendOutput(record, data))
    pty.onExit(({ exitCode }) => {
      record.exited = true
      record.exitCode = exitCode
    })
    return { terminalId }
  }

  async send(input: { readonly ownerAgentId: string; readonly terminalId: string; readonly data: string }): Promise<{ readonly written: number }> {
    const record = this.getOwned(input.terminalId, input.ownerAgentId)
    if (record.exited) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_FOUND,
        message: `终端已退出：${input.terminalId}`,
        userMessage: '这个终端已经退出。',
      })
    }
    record.pty.write(input.data)
    return { written: Buffer.byteLength(input.data, 'utf8') }
  }

  async read(input: {
    readonly ownerAgentId: string
    readonly terminalId: string
    readonly sinceOffset?: number | undefined
  }): Promise<TerminalReadResult> {
    const record = this.getOwned(input.terminalId, input.ownerAgentId)
    const requested = input.sinceOffset ?? record.baseOffset
    if (!Number.isInteger(requested) || requested < 0) throw invalidParams('sinceOffset 必须是非负整数')

    // 缓冲区淘汰后，过旧游标从当前保留起点恢复；返回的新 offset 始终可安全续读。
    const start = Math.max(requested, record.baseOffset)
    const data = Buffer.concat(
      record.chunks
        .filter((chunk) => chunk.start + chunk.data.length > start)
        .map((chunk) => chunk.data.subarray(Math.max(0, start - chunk.start))),
    ).toString('utf8')
    return {
      data,
      offset: record.offset,
      exited: record.exited,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    }
  }

  async signal(input: { readonly ownerAgentId: string; readonly terminalId: string; readonly signal: string }): Promise<{ readonly sent: true }> {
    const record = this.getOwned(input.terminalId, input.ownerAgentId)
    if (input.signal.trim().length === 0) throw invalidParams('signal 不能为空')
    if (record.exited) return { sent: true }
    if (process.platform === 'win32') {
      // ConPTY 不支持 kill(signal)。SIGINT 映射 Ctrl+C，其他信号收敛为关闭 PTY。
      if (input.signal === 'SIGINT') record.pty.write('\u0003')
      else record.pty.kill()
    } else {
      record.pty.kill(input.signal)
    }
    return { sent: true }
  }

  async close(input: { readonly ownerAgentId: string; readonly terminalId: string }): Promise<{ readonly closed: true }> {
    const record = this.terminals.get(input.terminalId)
    if (record === undefined) return { closed: true }
    if (record.ownerAgentId !== input.ownerAgentId) throw crossScope(input.terminalId)
    this.terminals.delete(input.terminalId)
    record.closed = true
    if (!record.exited) {
      try {
        record.pty.kill()
      } catch {
        // PTY 在退出竞态中会拒绝 kill；close 仍保持幂等。
      }
    }
    return { closed: true }
  }

  list(input: { readonly ownerAgentId?: string | undefined } = {}): readonly TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((record) => input.ownerAgentId === undefined || record.ownerAgentId === input.ownerAgentId)
      .map((record) => this.toInfo(record))
  }

  async disposeOwner(ownerAgentId: string): Promise<void> {
    assertOwner(ownerAgentId)
    const owned = [...this.terminals.values()].filter((record) => record.ownerAgentId === ownerAgentId)
    for (const record of owned) {
      await this.close({ ownerAgentId, terminalId: record.terminalId })
    }
  }

  async dispose(): Promise<void> {
    const records = [...this.terminals.values()]
    this.terminals.clear()
    for (const record of records) {
      record.closed = true
      if (!record.exited) {
        try {
          record.pty.kill()
        } catch {
          // 服务卸载必须继续关闭其余终端。
        }
      }
    }
  }

  private getOwned(terminalId: string, ownerAgentId: string): TerminalRecord {
    assertOwner(ownerAgentId)
    const record = this.terminals.get(terminalId)
    if (record === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_FOUND,
        message: `找不到终端：${terminalId}`,
        userMessage: '找不到这个终端。',
      })
    }
    if (record.ownerAgentId !== ownerAgentId) throw crossScope(terminalId)
    return record
  }

  private async preparePtyLaunch(shell: string, cwd: string): Promise<{ readonly argv: readonly string[] }> {
    if (this.sandbox === undefined) return { argv: [shell] }
    let status: Awaited<ReturnType<PtySandboxStatusSource['status']>>
    try {
      status = await this.sandbox.status()
    } catch {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: '无法读取 PTY 的沙箱状态',
        userMessage: '无法确认终端是否会在受控环境中启动，已拒绝打开终端。',
      })
    }
    // Windows 的工作区 ACL 在首次获批启动时由原生 helper 准备。此时 status 仍可能
    // 是 degraded，但只要 Provider 能包装 PTY，就必须先走受控 helper；不能因此裸启 shell。
    if (status.degraded && this.sandbox.wrapPty === undefined) return { argv: [shell] }
    if (this.sandbox.wrapPty === undefined) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: '当前系统级沙箱 Provider 未实现受控 PTY',
        userMessage: '当前安全环境尚不支持受控交互终端，已拒绝打开终端。',
      })
    }
    let wrapped: PtySandboxWrapResult
    try {
      wrapped = await this.sandbox.wrapPty([shell], { mode: 'workspace-write', workspaceRoot: cwd })
    } catch (cause) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: `受控 PTY 包装调用失败：${cause instanceof Error ? cause.message : String(cause)}`,
        userMessage: '无法确认交互终端会在受控环境中启动，已拒绝打开终端。',
        cause,
      })
    }
    if (!wrapped.enforced || wrapped.wrappedArgv.length === 0) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EC_NOT_READY,
        message: `受控 PTY 包装失败：${wrapped.degradationReason ?? '没有返回受约束 argv'}`,
        userMessage: '无法确认交互终端会在受控环境中启动，已拒绝打开终端。',
      })
    }
    return { argv: wrapped.wrappedArgv }
  }

  private appendOutput(record: TerminalRecord, data: string): void {
    if (record.closed || data.length === 0) return
    let bytes = Buffer.from(data, 'utf8')
    const start = record.offset
    record.offset += bytes.length
    if (bytes.length > this.maxOutputBytes) {
      bytes = bytes.subarray(bytes.length - this.maxOutputBytes)
      record.chunks.length = 0
      record.bufferedBytes = 0
      record.baseOffset = record.offset - bytes.length
      record.chunks.push({ start: record.baseOffset, data: bytes })
      record.bufferedBytes = bytes.length
      return
    }
    record.chunks.push({ start, data: bytes })
    record.bufferedBytes += bytes.length
    while (record.bufferedBytes > this.maxOutputBytes) {
      const first = record.chunks.shift()
      if (first === undefined) break
      record.bufferedBytes -= first.data.length
      record.baseOffset = first.start + first.data.length
    }
  }

  private toInfo(record: TerminalRecord): TerminalInfo {
    return {
      terminalId: record.terminalId,
      ownerAgentId: record.ownerAgentId,
      cwd: record.cwd,
      shell: record.shell,
      offset: record.offset,
      exited: record.exited,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    }
  }
}

export function createLocalTerminal(options: LocalTerminalOptions): TerminalService {
  return new LocalTerminalService(options)
}

function defaultShell(): string {
  return process.platform === 'win32' ? (process.env['COMSPEC'] ?? 'cmd.exe') : (process.env['SHELL'] ?? '/bin/sh')
}

function terminalEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function assertOwner(ownerAgentId: string): void {
  if (ownerAgentId.trim().length === 0) throw invalidParams('ownerAgentId 不能为空')
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EC_INVALID_PARAMS,
    message,
    userMessage: '终端请求参数无效。',
  })
}

function crossScope(terminalId: string): LcodeErrorImpl {
  return new LcodeErrorImpl({
    code: ERROR_CODES.EP_DENIED_CROSS_SCOPE,
    message: `终端不属于当前 agent：${terminalId}`,
    userMessage: '这个终端属于另一个任务，不能在这里操作。',
  })
}
