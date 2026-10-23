import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { importSkill, removeUserSkill, seedBuiltinSkills } from './skill-import.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lcode-skill-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const markdown = `---
name: Review Flow
description: 检查改动
---

先读文件。`

describe('skill-import', () => {
  it('导入 SKILL.md 到用户技能目录', () => {
    const root = tempRoot()
    const source = join(root, 'SKILL.md')
    writeFileSync(source, markdown)
    const imported = importSkill({ home: join(root, 'home'), path: source })
    expect(imported).toMatchObject({ id: 'review-flow', name: 'Review Flow', source: 'user' })
    expect(readFileSync(join(root, 'home', 'skills', imported.id, 'SKILL.md'), 'utf8')).toContain('先读文件')
  })

  it('导入单个技能文件夹的 zip，保留附加文件', () => {
    const root = tempRoot()
    const source = join(root, 'review.zip')
    writeFileSync(source, Buffer.from(zipSync({
      'review/SKILL.md': strToU8(markdown),
      'review/notes.txt': strToU8('附加说明'),
    })))
    const imported = importSkill({ home: join(root, 'home'), path: source })
    expect(imported.id).toBe('review-flow')
    expect(readFileSync(join(root, 'home', 'skills', imported.id, 'notes.txt'), 'utf8')).toBe('附加说明')
  })

  it('拒绝路径穿越、多个 SKILL.md 与不支持的扩展名', () => {
    const root = tempRoot()
    const traversal = join(root, 'bad.zip')
    writeFileSync(traversal, Buffer.from(zipSync({ '../evil/SKILL.md': strToU8(markdown) })))
    expect(() => importSkill({ home: join(root, 'home'), path: traversal })).toThrow('不安全的路径')

    const multiple = join(root, 'multiple.zip')
    writeFileSync(multiple, Buffer.from(zipSync({
      'a/SKILL.md': strToU8(markdown),
      'b/SKILL.md': strToU8(markdown),
    })))
    expect(() => importSkill({ home: join(root, 'home'), path: multiple })).toThrow('只能包含一个技能')

    const other = join(root, 'skill.txt')
    writeFileSync(other, 'x')
    expect(() => importSkill({ home: join(root, 'home'), path: other })).toThrow('只支持导入')
  })

  it('内置技能只在用户目录缺失时补入，不覆盖用户修改', () => {
    const root = tempRoot()
    const builtin = join(root, 'builtin')
    const home = join(root, 'home')
    const source = join(builtin, 'skill-creator', 'SKILL.md')
    mkdirSync(join(builtin, 'skill-creator'), { recursive: true })
    writeFileSync(source, markdown)

    seedBuiltinSkills({ home, sourceDir: builtin })
    const seeded = join(home, 'skills', 'skill-creator', 'SKILL.md')
    expect(readFileSync(seeded, 'utf8')).toBe(markdown)

    writeFileSync(seeded, '用户改过的内容')
    seedBuiltinSkills({ home, sourceDir: builtin })
    expect(readFileSync(seeded, 'utf8')).toBe('用户改过的内容')
  })

  it('同名导入自动加后缀，删除只允许用户技能目录', () => {
    const root = tempRoot()
    const source = join(root, 'SKILL.md')
    writeFileSync(source, markdown)
    const first = importSkill({ home: join(root, 'home'), path: source })
    const second = importSkill({ home: join(root, 'home'), path: source })
    expect(second.id).toBe(`${first.id}-2`)

    removeUserSkill({ home: join(root, 'home'), id: first.id })
    expect(existsSync(join(root, 'home', 'skills', first.id))).toBe(false)
    expect(() => removeUserSkill({ home: join(root, 'home'), id: '../outside' })).toThrow('技能 id 非法')
  })
})
