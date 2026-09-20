import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionEvent, SessionService } from '@lcode/session'
import { ERROR_CODES, LcodeErrorImpl, normalizePath, nowEpochMs } from '@lcode/util'

const FORMAT_VERSION = 1
const DEFAULT_MAX_FILE_BYTES = 1_000_000

export interface FileCheckpointSkipped {
  readonly path: string
  readonly reason: 'missing' | 'binary' | 'too-large' | 'symlink' | 'unreadable'
}

export interface FileCheckpoint {
  readonly checkpointId: string
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly turn: number
  readonly endSeq: number
  readonly createdAt: number
  readonly files: readonly { readonly path: string; readonly blob: string; readonly bytes: number }[]
  readonly trackedPaths: readonly string[]
  readonly partial: boolean
  readonly skipped: readonly FileCheckpointSkipped[]
}

export interface FileCheckpointService {
  capture(input: { readonly sessionId: string; readonly workspaceRoot: string; readonly session: SessionService; readonly turn: number; readonly endSeq: number }): Promise<FileCheckpoint>
  list(sessionId: string): Promise<readonly FileCheckpoint[]>
  restore(input: { readonly sessionId: string; readonly workspaceRoot: string; readonly session: SessionService; readonly checkpointId: string }): Promise<{ readonly restoredPaths: readonly string[]; readonly removedPaths: readonly string[] }>
}

export interface LocalFileCheckpointOptions {
  readonly home: string
  readonly maxFileBytes?: number | undefined
  readonly now?: (() => number) | undefined
}

/**
 * P6-01 文件检查点。
 *
 * 它只追踪本轮成功 `write/edit` 的工具结果，绝不扫盘或猜测用户手改的文件。每个
 * manifest 都是已跟踪路径的完整状态，因此恢复旧检查点可以准确移除后续新建文件。
 */
export class LocalFileCheckpointService implements FileCheckpointService {
  private readonly maxFileBytes: number
  private readonly now: () => number

  constructor(private readonly options: LocalFileCheckpointOptions) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.now = options.now ?? nowEpochMs
  }

  async capture(input: { readonly sessionId: string; readonly workspaceRoot: string; readonly session: SessionService; readonly turn: number; readonly endSeq: number }): Promise<FileCheckpoint> {
    assertSessionId(input.sessionId)
    const workspaceRoot = absolute(input.workspaceRoot)
    const checkpointId = `turn-${input.turn}-seq-${input.endSeq}`
    const previous = await this.latest(input.sessionId)
    const files = new Map(previous?.files.map((file) => [file.path, file]) ?? [])
    const tracked = new Set(previous?.trackedPaths ?? [])
    const skipped: FileCheckpointSkipped[] = []

    for (const path of changedPaths(input.session.events(), input.turn)) {
      if (!inside(workspaceRoot, path)) continue
      tracked.add(path)
      const snapshot = await this.snapshotFile(input.sessionId, path)
      if (snapshot.kind === 'file') files.set(path, snapshot.file)
      else if (snapshot.kind === 'missing') files.delete(path)
      else skipped.push({ path, reason: snapshot.reason })
    }

    const checkpoint: FileCheckpoint = {
      checkpointId,
      sessionId: input.sessionId,
      workspaceRoot,
      turn: input.turn,
      endSeq: input.endSeq,
      createdAt: this.now(),
      files: [...files.values()].sort(byPath),
      trackedPaths: [...tracked].sort(),
      partial: skipped.length > 0,
      skipped: skipped.sort(byPath),
    }
    await this.writeManifest(checkpoint)
    return checkpoint
  }

  async list(sessionId: string): Promise<readonly FileCheckpoint[]> {
    assertSessionId(sessionId)
    const directory = manifestsRoot(this.options.home, sessionId)
    let names: readonly string[]
    try {
      names = await readdir(directory)
    } catch (cause) {
      if (isMissing(cause)) return []
      throw checkpointIo('无法读取检查点目录', cause)
    }
    const checkpoints: FileCheckpoint[] = []
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
      checkpoints.push(await this.readManifest(sessionId, name.slice(0, -'.json'.length)))
    }
    return checkpoints.sort((left, right) => left.endSeq - right.endSeq)
  }

  async restore(input: { readonly sessionId: string; readonly workspaceRoot: string; readonly session: SessionService; readonly checkpointId: string }): Promise<{ readonly restoredPaths: readonly string[]; readonly removedPaths: readonly string[] }> {
    assertSessionId(input.sessionId)
    assertCheckpointId(input.checkpointId)
    const checkpoint = await this.readManifest(input.sessionId, input.checkpointId)
    const workspaceRoot = absolute(input.workspaceRoot)
    if (workspaceRoot !== checkpoint.workspaceRoot) {
      throw conflict('检查点属于另一个工作区，已拒绝恢复。')
    }
    if (checkpoint.partial) {
      throw conflict('该检查点含二进制、大文件、符号链接或不可读文件，无法保证完整恢复。')
    }

    const all = await this.list(input.sessionId)
    const tracked = new Set(all.flatMap((entry) => entry.trackedPaths))
    const expected = new Map(checkpoint.files.map((file) => [file.path, file]))
    const restorePaths = [...expected.keys()].sort()
    const removePaths = [...tracked].filter((path) => !expected.has(path)).sort()

    // 所有路径和 blob 先验证完，再触碰工作区；失败不会留下“已写了一半”的事件记录。
    const contents = new Map<string, Buffer>()
    for (const [path, file] of expected) {
      if (!inside(workspaceRoot, path)) throw conflict(`检查点包含工作区外路径：${path}`)
      const bytes = await this.readBlob(input.sessionId, file.blob)
      if (bytes.length !== file.bytes || digest(bytes) !== file.blob) throw conflict(`检查点文件校验失败：${path}`)
      await assertSafeDestination(path)
      contents.set(path, bytes)
    }
    for (const path of removePaths) {
      if (!inside(workspaceRoot, path)) throw conflict(`检查点包含工作区外路径：${path}`)
      await assertSafeDestination(path)
    }

    for (const path of restorePaths) {
      const bytes = contents.get(path)
      if (bytes === undefined) throw new Error('不可达：检查点内容缺失')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    }
    for (const path of removePaths) {
      try {
        await rm(path, { force: true })
      } catch (cause) {
        throw checkpointIo(`无法删除检查点之后创建的文件：${path}`, cause)
      }
    }
    input.session.append({
      type: 'checkpoint/restored',
      data: { checkpointId: checkpoint.checkpointId, restoredPaths: restorePaths, removedPaths: removePaths },
    })
    return { restoredPaths: restorePaths, removedPaths: removePaths }
  }

  private async latest(sessionId: string): Promise<FileCheckpoint | undefined> {
    const all = await this.list(sessionId)
    return all.at(-1)
  }

  private async snapshotFile(sessionId: string, path: string): Promise<{ readonly kind: 'file'; readonly file: FileCheckpoint['files'][number] } | { readonly kind: 'missing' } | { readonly kind: 'skipped'; readonly reason: FileCheckpointSkipped['reason'] }> {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch (cause) {
      return isMissing(cause) ? { kind: 'missing' } : { kind: 'skipped', reason: 'unreadable' }
    }
    if (info.isSymbolicLink()) return { kind: 'skipped', reason: 'symlink' }
    if (!info.isFile()) return { kind: 'skipped', reason: 'unreadable' }
    if (info.size > this.maxFileBytes) return { kind: 'skipped', reason: 'too-large' }
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      return { kind: 'skipped', reason: 'unreadable' }
    }
    if (!isUtf8Text(bytes)) return { kind: 'skipped', reason: 'binary' }
    const blob = digest(bytes)
    const target = join(blobsRoot(this.options.home, sessionId), `${blob}.utf8`)
    await mkdir(dirname(target), { recursive: true })
    try {
      await lstat(target)
    } catch (cause) {
      if (!isMissing(cause)) throw checkpointIo('无法读取检查点 blob', cause)
      await atomicWrite(target, bytes)
    }
    return { kind: 'file', file: { path, blob, bytes: bytes.length } }
  }

  private async writeManifest(checkpoint: FileCheckpoint): Promise<void> {
    const target = manifestPath(this.options.home, checkpoint.sessionId, checkpoint.checkpointId)
    await mkdir(dirname(target), { recursive: true })
    await atomicWrite(target, Buffer.from(JSON.stringify({ version: FORMAT_VERSION, ...checkpoint }), 'utf8'))
  }

  private async readManifest(sessionId: string, checkpointId: string): Promise<FileCheckpoint> {
    assertCheckpointId(checkpointId)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(manifestPath(this.options.home, sessionId, checkpointId), 'utf8')) as unknown
    } catch (cause) {
      if (isMissing(cause)) throw notFound(`找不到检查点：${checkpointId}`)
      throw checkpointIo(`无法读取检查点：${checkpointId}`, cause)
    }
    return parseManifest(raw, sessionId, checkpointId)
  }

  private async readBlob(sessionId: string, blob: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(blob)) throw conflict('检查点 blob 标识非法。')
    try {
      return await readFile(join(blobsRoot(this.options.home, sessionId), `${blob}.utf8`))
    } catch (cause) {
      throw checkpointIo(`检查点 blob 不存在：${blob}`, cause)
    }
  }
}

export function createLocalFileCheckpointService(options: LocalFileCheckpointOptions): FileCheckpointService {
  return new LocalFileCheckpointService(options)
}

function changedPaths(events: readonly SessionEvent[], turn: number): readonly string[] {
  const calls = new Map<string, string>()
  const paths = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
    if (event.type !== 'tool/result' || event.data.turn !== turn || event.data.message.isError) continue
    const name = calls.get(event.data.message.toolCallId)
    if (name !== 'write' && name !== 'edit') continue
    const meta = event.data.meta
    if (!record(meta) || !Array.isArray(meta.changes)) continue
    for (const change of meta.changes) {
      if (record(change) && typeof change.path === 'string' && isAbsolute(change.path)) paths.add(absolute(change.path))
    }
  }
  return [...paths].sort()
}

function parseManifest(raw: unknown, sessionId: string, checkpointId: string): FileCheckpoint {
  if (!record(raw) || raw.version !== FORMAT_VERSION || raw.sessionId !== sessionId || raw.checkpointId !== checkpointId) throw conflict(`检查点格式不受支持：${checkpointId}`)
  if (typeof raw.workspaceRoot !== 'string' || typeof raw.turn !== 'number' || typeof raw.endSeq !== 'number' || typeof raw.createdAt !== 'number' || typeof raw.partial !== 'boolean' || !Array.isArray(raw.files) || !Array.isArray(raw.trackedPaths) || !Array.isArray(raw.skipped)) throw conflict(`检查点格式不完整：${checkpointId}`)
  const files = raw.files.map((value) => {
    if (!record(value) || typeof value.path !== 'string' || typeof value.blob !== 'string' || typeof value.bytes !== 'number') throw conflict(`检查点文件记录非法：${checkpointId}`)
    return { path: absolute(value.path), blob: value.blob, bytes: value.bytes }
  })
  const trackedPaths = raw.trackedPaths.map((value) => {
    if (typeof value !== 'string') throw conflict(`检查点路径记录非法：${checkpointId}`)
    return absolute(value)
  })
  const skipped = raw.skipped.map((value) => {
    if (!record(value) || typeof value.path !== 'string' || !['missing', 'binary', 'too-large', 'symlink', 'unreadable'].includes(String(value.reason))) throw conflict(`检查点跳过记录非法：${checkpointId}`)
    return { path: absolute(value.path), reason: value.reason as FileCheckpointSkipped['reason'] }
  })
  return { checkpointId, sessionId, workspaceRoot: absolute(raw.workspaceRoot), turn: raw.turn, endSeq: raw.endSeq, createdAt: raw.createdAt, files, trackedPaths, partial: raw.partial, skipped }
}

async function assertSafeDestination(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw conflict(`拒绝经符号链接恢复：${path}`)
  } catch (cause) {
    if (isMissing(cause)) return
    throw cause
  }
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
}

async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, target)
  } catch (cause) {
    await rm(temporary, { force: true })
    throw checkpointIo(`无法写入检查点：${target}`, cause)
  }
}

function manifestsRoot(home: string, sessionId: string): string { return join(home, 'checkpoints', sessionId, 'manifests') }
function blobsRoot(home: string, sessionId: string): string { return join(home, 'checkpoints', sessionId, 'blobs') }
function manifestPath(home: string, sessionId: string, checkpointId: string): string { return join(manifestsRoot(home, sessionId), `${checkpointId}.json`) }
function absolute(path: string): string { return normalizePath(resolve(path)) }
function inside(root: string, path: string): boolean { const value = relative(root, path); return value !== '' && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\') && !isAbsolute(value) }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function byPath(left: { readonly path: string }, right: { readonly path: string }): number { return left.path.localeCompare(right.path) }
function isMissing(cause: unknown): boolean { return typeof cause === 'object' && cause !== null && 'code' in cause && (cause as { code?: unknown }).code === 'ENOENT' }
function assertSessionId(value: string): void { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw invalid('sessionId 非法') }
function assertCheckpointId(value: string): void { if (!/^turn-\d+-seq-\d+$/.test(value)) throw invalid('checkpointId 非法') }
function invalid(message: string): LcodeErrorImpl { return new LcodeErrorImpl({ code: ERROR_CODES.EC_INVALID_PARAMS, message, userMessage: '检查点请求参数无效。', retryable: false }) }
function notFound(message: string): LcodeErrorImpl { return new LcodeErrorImpl({ code: ERROR_CODES.EC_NOT_FOUND, message, userMessage: '找不到这个文件检查点。', retryable: false }) }
function conflict(message: string): LcodeErrorImpl { return new LcodeErrorImpl({ code: ERROR_CODES.EC_CONFLICT, message, userMessage: '这个检查点不能安全恢复。', retryable: false }) }
function checkpointIo(message: string, cause: unknown): LcodeErrorImpl { return new LcodeErrorImpl({ code: ERROR_CODES.EF_PERMISSION_DENIED, message, userMessage: '读写文件检查点失败，工作区没有被恢复。', retryable: false, cause }) }
