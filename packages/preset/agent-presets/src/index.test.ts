import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAgentPresets } from './index.ts'

let root = ''
afterEach(async () => { if (root !== '') await rm(root, { recursive: true, force: true }); root = '' })

describe('LocalAgentPresets', () => {
  it('creates a source-aware, deterministic session snapshot with recursive patch semantics', async () => {
    root = await mkdtemp(join(tmpdir(), 'lcode-presets-'))
    const user = join(root, 'user'); const workspace = join(root, 'workspace')
    await mkdir(user); await mkdir(workspace)
    await writeFile(join(user, 'base.yml'), 'id: base\nname: Base\nmodel:\n  provider: openai\n  maxTokens: 4096\nplugins:\n  web:\n    enabled: true\n')
    await writeFile(join(workspace, 'project.yml'), 'id: project\nname: Project\nmodel:\n  maxTokens: 8192\nplugins:\n  web:\n    enabled: false\n')
    const presets = createLocalAgentPresets({ roots: [{ path: user, source: 'user' }, { path: workspace, source: 'workspace' }] })
    await expect(presets.list()).resolves.toEqual([{ id: 'base', name: 'Base', source: 'user' }, { id: 'project', name: 'Project', source: 'workspace' }])
    const snapshot = await presets.snapshot('session-1', ['base', 'project'])
    expect(snapshot).toEqual({ sessionId: 'session-1', ids: ['base', 'project'], sources: ['user', 'workspace'], config: { model: { provider: 'openai', maxTokens: 8192 }, plugins: { web: { enabled: false } } } })
    expect(presets.export(snapshot)).toContain('maxTokens: 8192')
  })

  it('rejects secret values in a preset before it becomes a session snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'lcode-presets-'))
    await writeFile(join(root, 'unsafe.yml'), 'id: unsafe\nname: Unsafe\napiKey: should-not-live-here\n')
    const presets = createLocalAgentPresets({ roots: [{ path: root, source: 'user' }] })
    await expect(presets.snapshot('session-1', ['unsafe'])).rejects.toMatchObject({ code: 'EC-VALIDATION_FAILED' })
  })
})
