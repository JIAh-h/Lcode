import { describe, expect, it } from 'vitest'
import { isInsideWorkspace, normalizePath } from './fs.ts'

/**
 * 工作区边界判定（M-SEC-02 / 12 §4.7）。
 *
 * 这是**安全关键**的那一个函数：它错了，"写工作区外"就不会触发审批。
 * 所以这里把各种绕过的写法都钉住。
 */

describe('normalizePath', () => {
  it('反斜杠归一成正斜杠（Windows 路径）', () => {
    expect(normalizePath('C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts')
  })

  it('折叠重复斜杠', () => {
    expect(normalizePath('/repo//src///a.ts')).toBe('/repo/src/a.ts')
  })

  it('去掉末尾斜杠（根目录除外）', () => {
    expect(normalizePath('/repo/src/')).toBe('/repo/src')
    expect(normalizePath('/')).toBe('/')
  })
})

describe('isInsideWorkspace', () => {
  const root = '/repo/web'

  it('工作区内的文件与子目录为 true', () => {
    expect(isInsideWorkspace(root, '/repo/web/a.ts')).toBe(true)
    expect(isInsideWorkspace(root, '/repo/web/src/deep/a.ts')).toBe(true)
  })

  it('工作区根自身为 true', () => {
    expect(isInsideWorkspace(root, '/repo/web')).toBe(true)
  })

  it('**前缀相同但不是子路径 → false**（最容易写错的一处）', () => {
    // 朴素实现会写成 `target.startsWith(root)`，于是 `/repo/web-evil` 被误判为"在里面"，
    // 越界写就不触发审批了。必须带上分隔符。
    expect(isInsideWorkspace(root, '/repo/web-evil/a.ts')).toBe(false)
    expect(isInsideWorkspace(root, '/repo/web2')).toBe(false)
  })

  it('工作区外的绝对路径为 false', () => {
    expect(isInsideWorkspace(root, '/etc/passwd')).toBe(false)
    expect(isInsideWorkspace(root, '/repo/other/a.ts')).toBe(false)
  })

  it('父目录为 false', () => {
    expect(isInsideWorkspace(root, '/repo')).toBe(false)
    expect(isInsideWorkspace(root, '/')).toBe(false)
  })

  it('大小写敏感（Linux/macOS 上必须敏感；Windows 上传入前须已统一大小写）', () => {
    expect(isInsideWorkspace(root, '/REPO/WEB/a.ts')).toBe(false)
  })

  it('反斜杠与重复斜杠的混入写法仍能正确判定', () => {
    expect(isInsideWorkspace(root, '/repo//web\\\\a.ts')).toBe(true)
    expect(isInsideWorkspace(root, '/repo//web-evil\\\\a.ts')).toBe(false)
  })
})
