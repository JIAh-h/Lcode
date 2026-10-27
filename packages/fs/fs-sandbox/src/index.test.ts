import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '@lcode/fs'
import { createFsMutationAuthority, createLocalFs } from '@lcode/fs-local'
import { createLocalSubprocess } from '@lcode/subprocess-local'
import type { SandboxMode, SandboxService, SandboxStatus } from '@lcode/sandbox'
import { createSandboxedFs } from './index.ts'

let workspace = ''
let outside = ''
let fs: ReturnType<typeof createSandboxedFs> | undefined

afterEach(async () => {
  await fs?.dispose()
  fs = undefined
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
  if (outside !== '') rmSync(outside, { recursive: true, force: true })
  workspace = ''
  outside = ''
})

const workerSource = readFileSync(fileURLToPath(new URL('./fs-worker.cjs', import.meta.url)), 'utf8')

function makeSandbox(available = true, onWrap?: (mode: SandboxMode) => void): SandboxService {
  return {
    async status() {
      return {
        available,
        providerAvailable: available,
        mechanism: 'test',
        knownEscapeSurfaces: [],
        degraded: !available,
        ...(available ? {} : { reason: 'missing' }),
        capabilities: {},
      } as unknown as SandboxStatus
    },
    async wrap(argv: readonly string[], policy: { readonly mode: SandboxMode }) {
      onWrap?.(policy.mode)
      return available
        ? { enforced: true, wrappedArgv: [...argv], mechanism: 'test' }
        : { enforced: false, wrappedArgv: [...argv], degradationReason: 'missing' }
    },
    async releaseWorkspace() { return { released: true } },
    async probe() { return { available } as never },
  } as unknown as SandboxService
}

function makeService(options: {
  readonly available?: boolean
  readonly mode?: () => SandboxMode
  readonly onWrap?: (mode: SandboxMode) => void
} = {}): { service: ReturnType<typeof createSandboxedFs>; authority: ReturnType<typeof createFsMutationAuthority> } {
  if (workspace === '') workspace = mkdtempSync(join(tmpdir(), 'lcode-fs-sandbox-ws-'))
  if (outside === '') outside = mkdtempSync(join(tmpdir(), 'lcode-fs-sandbox-out-'))
  const authority = createFsMutationAuthority()
  const base = createLocalFs({ workspaceRoot: workspace, mutationAuthority: authority })
  const service = createSandboxedFs({
    base,
    sandbox: makeSandbox(options.available !== false, options.onWrap),
    subprocess: createLocalSubprocess(),
    workspaceRoot: workspace,
    workerSource,
    mode: options.mode ?? (() => 'workspace-write'),
    mutationAuthority: authority,
  })
  fs = service
  return { service, authority }
}

describe('fs-sandbox', () => {
  it('工作区内读写/编辑/搜索走受控 worker', async () => {
    const { service, authority } = makeService()
    const file = join(workspace, 'src', 'a.ts')
    authority.grant({ sessionId: 's1', callId: 'c1', paths: [canonicalPath(file)] })
    await service.write('src/a.ts', 'one\ntwo\n', { mutationAccess: { sessionId: 's1', callId: 'c1' } })
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n')

    await expect(service.read('src/a.ts')).resolves.toMatchObject({
      totalLines: 2,
      lines: [{ number: 1, text: 'one' }, { number: 2, text: 'two' }],
    })

    authority.grant({ sessionId: 's1', callId: 'c2', paths: [canonicalPath(file)] })
    await expect(service.edit({
      path: 'src/a.ts',
      oldText: 'two',
      newText: 'three',
      mutationAccess: { sessionId: 's1', callId: 'c2' },
    })).resolves.toMatchObject({ applied: 1 })
    expect(readFileSync(file, 'utf8')).toBe('one\nthree\n')

    await expect(service.glob('**/*.ts')).resolves.toMatchObject({ paths: ['src/a.ts'], total: 1 })
    await expect(service.grep('three', { include: '*.ts' })).resolves.toMatchObject({
      matches: [{ path: 'src/a.ts', line: 2, column: 1, text: 'three' }],
      total: 1,
    })
    await expect(service.stat('src/a.ts')).resolves.toMatchObject({ kind: 'file' })
    await expect(service.readdir('src')).resolves.toEqual(['a.ts'])
  })

  it('工作区外路径委托 base，不改变已批准的越界写行为', async () => {
    const { service, authority } = makeService()
    const outsideFile = join(outside, 'outside.txt')
    authority.grant({ sessionId: 's1', callId: 'c1', paths: [canonicalPath(outsideFile)] })
    await service.write(outsideFile, 'ok', { mutationAccess: { sessionId: 's1', callId: 'c1' } })
    expect(readFileSync(outsideFile, 'utf8')).toBe('ok')
    await expect(service.read(outsideFile)).resolves.toMatchObject({ lines: [{ number: 1, text: 'ok' }] })
  })

  it('沙箱不可用时回退 base，保证 Linux/降级环境仍可用', async () => {
    const { service } = makeService({ available: false })
    writeFileSync(join(workspace, 'fallback.txt'), 'fallback', 'utf8')
    await expect(service.read('fallback.txt')).resolves.toMatchObject({
      totalLines: 1,
      lines: [{ number: 1, text: 'fallback' }],
    })
  })

  it('档位变化时重启 worker', async () => {
    const modes: SandboxMode[] = []
    let mode: SandboxMode = 'workspace-write'
    const { service } = makeService({ mode: () => mode, onWrap: (value) => modes.push(value) })
    mkdirSync(join(workspace, 'd'), { recursive: true })
    writeFileSync(join(workspace, 'd', 'x.txt'), 'x', 'utf8')
    await service.read('d/x.txt')
    mode = 'read-only'
    await service.read('d/x.txt')
    expect(modes).toEqual(['workspace-write', 'read-only'])
  })
})
