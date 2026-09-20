import type { JobCompletion, JobReadResult, JobSnapshot, JobStartInput, JobStatus, JobsService } from '@lcode/jobs'
import type { ErrorCode } from '@lcode/util'
import { ERROR_CODES, LcodeErrorImpl, newId, nowEpochMs } from '@lcode/util'

const DEFAULT_OUTPUT_LIMIT_BYTES = 1_000_000
const DEFAULT_MAX_JOBS = 256

export interface LocalJobsOptions {
  readonly maxJobs?: number | undefined
  readonly defaultOutputLimitBytes?: number | undefined
}

interface OutputChunk {
  readonly start: number
  readonly data: Buffer
}

interface JobRecord {
  readonly jobId: string
  readonly kind: string
  readonly label: string
  readonly ownerAgentId?: string | undefined
  readonly createdAt: number
  readonly limitBytes: number
  readonly controller: AbortController
  readonly run: JobStartInput['run']
  readonly chunks: OutputChunk[]
  readonly done: Promise<void>
  status: JobStatus
  stopRequested: boolean
  settled: boolean
  bufferedBytes: number
  baseOffset: number
  offset: number
  endedAt?: number | undefined
  exitCode?: number | undefined
  signal?: string | null | undefined
  errorCode?: ErrorCode | undefined
}

/** 本地进程内 JobsService：输出有界、按 owner 隔离、终态 first-wins。 */
export class LocalJobsService implements JobsService {
  private readonly records = new Map<string, JobRecord>()
  private readonly maxJobs: number
  private readonly defaultOutputLimitBytes: number
  private disposed = false

  constructor(options: LocalJobsOptions = {}) {
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS
    this.defaultOutputLimitBytes = options.defaultOutputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES
    assertPositiveInteger(this.maxJobs, 'maxJobs')
    assertPositiveInteger(this.defaultOutputLimitBytes, 'defaultOutputLimitBytes')
  }

  async start(input: JobStartInput): Promise<{ readonly jobId: string }> {
    if (this.disposed) throw notReady('后台作业服务已卸载')
    assertNonEmpty(input.kind, 'kind')
    assertNonEmpty(input.label, 'label')
    if (typeof input.run !== 'function') throw invalidParams('run 必须是函数')
    if (input.ownerAgentId !== undefined) assertNonEmpty(input.ownerAgentId, 'ownerAgentId')
    const limitBytes = input.outputLimitBytes ?? this.defaultOutputLimitBytes
    assertPositiveInteger(limitBytes, 'outputLimitBytes')
    if (this.records.size >= this.maxJobs) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EJ_LIMIT_REACHED,
        message: `后台作业数量已达上限：${this.maxJobs}`,
        userMessage: '后台作业数量已达到上限，请先结束不需要的任务。',
      })
    }

    const jobId = newId()
    const controller = new AbortController()
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const record: JobRecord = {
      jobId,
      kind: input.kind,
      label: input.label,
      ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId }),
      createdAt: nowEpochMs(),
      limitBytes,
      controller,
      run: input.run,
      chunks: [],
      done,
      status: 'running',
      stopRequested: false,
      settled: false,
      bufferedBytes: 0,
      baseOffset: 0,
      offset: 0,
    }
    this.records.set(jobId, record)
    void this.runRecord(record, resolveDone)
    return { jobId }
  }

  list(input: { readonly ownerAgentId?: string | undefined } = {}): readonly JobSnapshot[] {
    return [...this.records.values()]
      .filter((record) => input.ownerAgentId === undefined || record.ownerAgentId === input.ownerAgentId)
      .map((record) => this.snapshot(record))
  }

  status(input: { readonly jobId: string; readonly ownerAgentId?: string | undefined }): JobSnapshot {
    return this.snapshot(this.getOwned(input.jobId, input.ownerAgentId))
  }

  read(input: { readonly jobId: string; readonly ownerAgentId?: string | undefined; readonly sinceOffset?: number | undefined }): JobReadResult {
    const record = this.getOwned(input.jobId, input.ownerAgentId)
    const requested = input.sinceOffset ?? record.baseOffset
    if (!Number.isInteger(requested) || requested < 0) throw invalidParams('sinceOffset 必须是非负整数')
    const start = Math.max(requested, record.baseOffset)
    const output = Buffer.concat(
      record.chunks
        .filter((chunk) => chunk.start + chunk.data.length > start)
        .map((chunk) => chunk.data.subarray(Math.max(0, start - chunk.start))),
    ).toString('utf8')
    return { output, status: record.status, offset: record.offset, baseOffset: record.baseOffset }
  }

  async kill(input: { readonly jobId: string; readonly ownerAgentId?: string | undefined }): Promise<{ readonly status: JobStatus }> {
    const record = this.getOwned(input.jobId, input.ownerAgentId)
    if (record.settled) return { status: record.status }
    record.stopRequested = true
    record.status = 'stopping'
    record.controller.abort()
    await record.done
    return { status: record.status }
  }

  async disposeOwner(ownerAgentId: string): Promise<void> {
    assertNonEmpty(ownerAgentId, 'ownerAgentId')
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.ownerAgentId === ownerAgentId && !record.settled)
        .map(async (record) => { await this.kill({ jobId: record.jobId, ownerAgentId }) }),
    )
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.records.values()].filter((record) => !record.settled).map(async (record) => {
      await this.kill({ jobId: record.jobId, ...(record.ownerAgentId === undefined ? {} : { ownerAgentId: record.ownerAgentId }) })
    }))
  }

  private async runRecord(record: JobRecord, resolveDone: () => void): Promise<void> {
    try {
      const completion = await record.run({
        signal: record.controller.signal,
        write: (data) => this.appendOutput(record, data),
      })
      this.settle(record, record.stopRequested ? 'killed' : 'completed', completion)
    } catch (error) {
      this.settle(record, record.stopRequested ? 'killed' : 'failed', undefined, error)
    } finally {
      resolveDone()
    }
  }

  private settle(record: JobRecord, status: Extract<JobStatus, 'completed' | 'killed' | 'failed'>, completion?: JobCompletion | void, error?: unknown): void {
    if (record.settled) return
    // 失败诊断属于本次作业的最后一段输出，必须在终态封口之前写入。
    if (status === 'failed' && error instanceof Error) this.appendOutput(record, `\n${error.message}\n`)
    record.settled = true
    record.status = status
    record.endedAt = nowEpochMs()
    if (completion?.exitCode !== undefined) record.exitCode = completion.exitCode
    if (completion?.signal !== undefined) record.signal = completion.signal
    if (completion?.errorCode !== undefined) record.errorCode = completion.errorCode
    if (status === 'failed' && record.errorCode === undefined) record.errorCode = ERROR_CODES.EN_IO_ERROR
  }

  private appendOutput(record: JobRecord, data: string | Uint8Array): void {
    if (record.settled) return
    let bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (bytes.length === 0) return
    const start = record.offset
    record.offset += bytes.length
    if (bytes.length > record.limitBytes) {
      bytes = bytes.subarray(bytes.length - record.limitBytes)
      record.chunks.length = 0
      record.bufferedBytes = 0
      record.baseOffset = record.offset - bytes.length
      record.chunks.push({ start: record.baseOffset, data: bytes })
      record.bufferedBytes = bytes.length
      return
    }
    record.chunks.push({ start, data: bytes })
    record.bufferedBytes += bytes.length
    while (record.bufferedBytes > record.limitBytes) {
      const first = record.chunks.shift()
      if (first === undefined) break
      record.bufferedBytes -= first.data.length
      record.baseOffset = first.start + first.data.length
    }
  }

  private getOwned(jobId: string, ownerAgentId: string | undefined): JobRecord {
    assertNonEmpty(jobId, 'jobId')
    const record = this.records.get(jobId)
    if (record === undefined) {
      throw new LcodeErrorImpl({ code: ERROR_CODES.EJ_NOT_FOUND, message: `找不到作业：${jobId}`, userMessage: '找不到这个后台作业。' })
    }
    if (record.ownerAgentId !== undefined && record.ownerAgentId !== ownerAgentId) {
      throw new LcodeErrorImpl({
        code: ERROR_CODES.EP_DENIED_CROSS_SCOPE,
        message: `作业不属于当前 agent：${jobId}`,
        userMessage: '这个后台作业属于另一个任务，不能在这里操作。',
      })
    }
    return record
  }

  private snapshot(record: JobRecord): JobSnapshot {
    return {
      jobId: record.jobId,
      kind: record.kind,
      label: record.label,
      ...(record.ownerAgentId === undefined ? {} : { ownerAgentId: record.ownerAgentId }),
      status: record.status,
      createdAt: record.createdAt,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      outputOffset: record.offset,
      outputBaseOffset: record.baseOffset,
    }
  }
}

export function createLocalJobs(options: LocalJobsOptions = {}): JobsService {
  return new LocalJobsService(options)
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === '') throw invalidParams(`${field} 不能为空`)
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw invalidParams(`${field} 必须是正整数`)
}

function invalidParams(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EC_INVALID_PARAMS, message, userMessage: '后台作业请求参数无效。' })
}

function notReady(message: string): LcodeErrorImpl {
  return new LcodeErrorImpl({ code: ERROR_CODES.EC_NOT_READY, message, userMessage: '后台作业服务尚未准备好。' })
}
