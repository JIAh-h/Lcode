import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalMemoryStore, MEMORY_MAX_CHARS, MEMORY_MAX_LINES, USER_MEMORY_FILE } from './index.ts'

let home = ''
let workspace = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-memory-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'lcode-memory-ws-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

describe('memory-local', () => {
  it('没有任何记忆时注入为空，且不报错', () => {
    const store = createLocalMemoryStore()
    const snapshot = store.read({ home, workspaceRoot: workspace })
    expect(snapshot.user).toBeNull()
    expect(snapshot.project).toHaveLength(0)
    expect(snapshot.injected).toBe('')
    expect(snapshot.injectedChars).toBe(0)
  })

  it('用户记忆写入后可读回，且排在项目记忆之前（个人偏好优先）', () => {
    const store = createLocalMemoryStore()
    store.writeUser({ home, text: '# 偏好\n- 用中文回答' })
    writeFileSync(join(workspace, 'AGENTS.md'), '# 项目约定\n- 用 pnpm', 'utf8')

    const snapshot = store.read({ home, workspaceRoot: workspace })
    expect(snapshot.user).not.toBeNull()
    expect(snapshot.user?.name).toBe(USER_MEMORY_FILE)
    expect(snapshot.project).toHaveLength(1)
    expect(snapshot.project[0]?.name).toBe('AGENTS.md')
    // 用户记忆在前
    expect(snapshot.injected.indexOf('User memory')).toBeLessThan(snapshot.injected.indexOf('Project memory'))
    expect(snapshot.injected).toContain('用中文回答')
    expect(snapshot.injected).toContain('用 pnpm')
  })

  it('三个项目记忆文件按固定顺序收集，空文件跳过', () => {
    const store = createLocalMemoryStore()
    writeFileSync(join(workspace, 'AGENTS.md'), 'A', 'utf8')
    writeFileSync(join(workspace, 'CLAUDE.md'), 'C', 'utf8')
    mkdirSync(join(workspace, '.lcode'), { recursive: true })
    writeFileSync(join(workspace, '.lcode', 'instructions.md'), '   ', 'utf8')

    const snapshot = store.read({ home, workspaceRoot: workspace })
    expect(snapshot.project.map((item) => item.name)).toEqual(['AGENTS.md', 'CLAUDE.md'])
  })

  it('超过行数上限时截断，并如实标注 truncated', () => {
    const store = createLocalMemoryStore()
    const many = Array.from({ length: MEMORY_MAX_LINES + 50 }, (_, index) => `line ${index}`).join('\n')
    store.writeUser({ home, text: many })

    const snapshot = store.read({ home, workspaceRoot: workspace })
    expect(snapshot.user).not.toBeNull()
    // 注入文本被裁剪（含截断说明），不会把整个超长文件塞进前缀
    expect(snapshot.injected).toContain('memory truncated')
    expect(snapshot.injected.length).toBeLessThan(many.length)
  })

  it('超过字符上限时同样截断', () => {
    const store = createLocalMemoryStore()
    // 一行很长：行数没超但字符数超
    store.writeUser({ home, text: 'x'.repeat(MEMORY_MAX_CHARS + 100) })

    const snapshot = store.read({ home, workspaceRoot: workspace })
    expect(snapshot.injected).toContain('memory truncated')
    expect(snapshot.injected.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS + 120)
  })

  it('readUser 在文件不存在时返回空串（编辑页首次打开）', () => {
    const store = createLocalMemoryStore()
    expect(store.readUser({ home })).toBe('')
  })

  it('写入时末尾自动补换行，避免下次追加黏在最后一行', () => {
    const store = createLocalMemoryStore()
    store.writeUser({ home, text: 'no trailing newline' })
    expect(store.readUser({ home }).endsWith('\n')).toBe(true)
  })

  it('没有工作区时只读用户记忆，不报错', () => {
    const store = createLocalMemoryStore()
    store.writeUser({ home, text: 'user only' })
    const snapshot = store.read({ home })
    expect(snapshot.user).not.toBeNull()
    expect(snapshot.project).toHaveLength(0)
    expect(snapshot.injected).toContain('user only')
  })
})
