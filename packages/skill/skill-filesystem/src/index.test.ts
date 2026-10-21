import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalSkillFilesystem } from './index.ts'

let root = ''
afterEach(async () => { if (root !== '') await rm(root, { recursive: true, force: true }); root = '' })

describe('LocalSkillFilesystem', () => {
  it('keeps a source-aware catalog small and reads instructions only on explicit load', async () => {
    root = await mkdtemp(join(tmpdir(), 'lcode-skills-'))
    await mkdir(join(root, 'release-check'), { recursive: true })
    await writeFile(join(root, 'release-check', 'SKILL.md'), '---\nname: Release check\ndescription: Verify release quality\n---\n# Release\n\nRun the documented checks.')
    const skills = createLocalSkillFilesystem({ roots: [{ path: root, source: 'workspace' }] })
    await expect(skills.catalog()).resolves.toEqual([{ id: 'release-check', name: 'Release check', description: 'Verify release quality', source: 'workspace' }])
    await expect(skills.load('release-check')).resolves.toMatchObject({ instructions: expect.stringContaining('Run the documented checks.'), path: join(root, 'release-check', 'SKILL.md') })
    await expect(skills.load('../escape')).resolves.toBeUndefined()
  })

  it('ignores oversized SKILL.md files instead of making them prompt-visible', async () => {
    root = await mkdtemp(join(tmpdir(), 'lcode-skills-'))
    await mkdir(join(root, 'oversized'), { recursive: true })
    await writeFile(join(root, 'oversized', 'SKILL.md'), 'x'.repeat(128 * 1024 + 1))
    await expect(createLocalSkillFilesystem({ roots: [{ path: root, source: 'user' }] }).catalog()).resolves.toEqual([])
  })
})
