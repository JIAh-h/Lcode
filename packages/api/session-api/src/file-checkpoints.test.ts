import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@lcode/session'
import { asSessionId } from '@lcode/util'
import { createLocalFileCheckpointService } from './file-checkpoints.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('LocalFileCheckpointService', () => {
  it('恢复旧检查点会恢复已跟踪文本并删除后续工具创建的文件，历史只追加 restore 事件', async () => {
    const { home, workspace, session, checkpoints } = harness()
    void home
    const existing = join(workspace, 'tracked.txt')
    const createdLater = join(workspace, 'later.txt')
    writeFileSync(existing, 'first', 'utf8')
    const first = await captureTurn(session, checkpoints, workspace, 1, [{ callId: 'c1', path: existing }])

    writeFileSync(existing, 'second', 'utf8')
    writeFileSync(createdLater, 'later', 'utf8')
    await captureTurn(session, checkpoints, workspace, 2, [
      { callId: 'c2', path: existing },
      { callId: 'c3', path: createdLater },
    ])
    const historyBeforeRestore = session.events()

    await expect(checkpoints.restore({ sessionId: 'session-1', workspaceRoot: workspace, session, checkpointId: first.checkpointId })).resolves.toEqual({
      restoredPaths: [existing.replaceAll('\\', '/')],
      removedPaths: [createdLater.replaceAll('\\', '/')],
      unrestoredPaths: [],
    })
    await expect(readFile(existing, 'utf8')).resolves.toBe('first')
    await expect(readFile(createdLater, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(session.events().slice(0, historyBeforeRestore.length)).toEqual(historyBeforeRestore)
    expect(session.events().at(-1)).toMatchObject({ type: 'checkpoint/restored', data: { checkpointId: first.checkpointId } })
  })

  it('二进制或超过上限的文件生成 partial 检查点，恢复时明确拒绝', async () => {
    const { workspace, session } = harness()
    const checkpoints = createLocalFileCheckpointService({ home: roots.at(-1)!, maxFileBytes: 8 })
    const binary = join(workspace, 'binary.bin')
    writeFileSync(binary, Buffer.from([0, 1, 2]))
    const checkpoint = await captureTurn(session, checkpoints, workspace, 1, [{ callId: 'binary', path: binary }])

    expect(checkpoint).toMatchObject({ partial: true, files: [], skipped: [{ path: binary.replaceAll('\\', '/'), reason: 'binary' }] })
    await expect(checkpoints.restore({ sessionId: 'session-1', workspaceRoot: workspace, session, checkpointId: checkpoint.checkpointId })).rejects.toMatchObject({
      code: 'EC-CONFLICT',
    })
  })

  it('allowPartial 回退能回退的文本，绝不删除没有备份的二进制文件', async () => {
    const { workspace, session } = harness()
    const checkpoints = createLocalFileCheckpointService({ home: roots.at(-1)!, maxFileBytes: 8 })
    const text = join(workspace, 'note.txt')
    const binary = join(workspace, 'asset.bin')
    writeFileSync(text, 'before', 'utf8')
    const first = await captureTurn(session, checkpoints, workspace, 1, [{ callId: 't1', path: text }])

    writeFileSync(text, 'after', 'utf8')
    writeFileSync(binary, Buffer.from([0, 1, 2]))
    const second = await captureTurn(session, checkpoints, workspace, 2, [
      { callId: 't2', path: text },
      { callId: 'b1', path: binary },
    ])
    expect(second).toMatchObject({ partial: true, skipped: [{ path: binary.replaceAll('\\', '/'), reason: 'binary' }] })

    const restored = await checkpoints.restore({
      sessionId: 'session-1',
      workspaceRoot: workspace,
      session,
      checkpointId: first.checkpointId,
      allowPartial: true,
    })
    // 文本恢复到第一轮之后；二进制没有备份 → 原样保留并如实上报，而不是当作“后来新建的文件”删掉
    expect(restored.restoredPaths).toEqual([text.replaceAll('\\', '/')])
    expect(restored.unrestoredPaths).toEqual([binary.replaceAll('\\', '/')])
    await expect(readFile(text, 'utf8')).resolves.toBe('before')
    await expect(readFile(binary)).resolves.toEqual(Buffer.from([0, 1, 2]))
  })

  it('只使用成功 write/edit 的受影响路径，不会因为伪造元数据快照工作区外文件', async () => {
    const { workspace, root, session, checkpoints } = harness()
    const inside = join(workspace, 'inside.txt')
    const outside = join(root, 'outside.txt')
    writeFileSync(inside, 'inside', 'utf8')
    writeFileSync(outside, 'outside', 'utf8')
    session.append({ type: 'turn/start', data: { turn: 1 } })
    appendToolResult(session, 1, 'write-ok', 'write', inside)
    session.append({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'not-write', name: 'shell', arguments: '{}' } })
    session.append({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'user', toolCallId: 'not-write', content: '', isError: false }, meta: { changes: [{ path: outside }] } } as never })
    const end = session.append({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    const checkpoint = await checkpoints.capture({ sessionId: 'session-1', workspaceRoot: workspace, session, turn: 1, endSeq: end.seq })

    expect(checkpoint.files.map((file) => file.path)).toEqual([inside.replaceAll('\\', '/')])
  })
})

function harness(): { readonly root: string; readonly home: string; readonly workspace: string; readonly session: InMemorySessionStore; readonly checkpoints: ReturnType<typeof createLocalFileCheckpointService> } {
  const root = mkdtempSync(join(tmpdir(), 'lcode-checkpoints-'))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const session = new InMemorySessionStore(asSessionId('session-1'))
  return { root, home, workspace, session, checkpoints: createLocalFileCheckpointService({ home }) }
}

async function captureTurn(
  session: InMemorySessionStore,
  checkpoints: ReturnType<typeof createLocalFileCheckpointService>,
  workspace: string,
  turn: number,
  changes: readonly { readonly callId: string; readonly path: string }[],
) {
  session.append({ type: 'turn/start', data: { turn } })
  for (const change of changes) appendToolResult(session, turn, change.callId, 'write', change.path)
  const end = session.append({ type: 'turn/end', data: { turn, reason: 'completed' } })
  return await checkpoints.capture({ sessionId: 'session-1', workspaceRoot: workspace, session, turn, endSeq: end.seq })
}

function appendToolResult(session: InMemorySessionStore, turn: number, callId: string, name: 'write' | 'edit', path: string) {
  session.append({ type: 'tool/call', data: { turn, step: 1, callId, name, arguments: '{}' } })
  return session.append({
    type: 'tool/result',
    data: { turn, step: 1, message: { role: 'user', toolCallId: callId, content: '', isError: false }, meta: { changes: [{ path }] } },
  })
}
