import { describe, expect, it } from 'vitest'
import {
  absFromHome,
  fnv1a64Hex,
  indexDbPath,
  LCODE_HOME_ENV,
  LOG_EXT,
  normalizePath,
  relativeToHome,
  resolveLcodeHome,
  sessionLogRelPath,
  sessionsRoot,
  WORKSPACE_BUCKET_UNKNOWN,
  workspaceBucket,
} from './lcode-home.ts'

describe('normalizePath（22 §7.3）', () => {
  it('把反斜杠统一为斜杠', () => {
    expect(normalizePath('C:\\Users\\kui\\repo')).toBe('C:/Users/kui/repo')
  })

  it('折叠重复斜杠并去掉末尾斜杠', () => {
    expect(normalizePath('/repo//web//')).toBe('/repo/web')
    expect(normalizePath('C:\\repo\\\\web\\')).toBe('C:/repo/web')
  })

  it('保留 POSIX 根与盘根', () => {
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('C:\\')).toBe('C:/')
    // 'C:' 是驱动器相对路径、不是绝对路径 → 不臆造补斜杠
    expect(normalizePath('C:')).toBe('C:')
  })

  it('保留 UNC 前导双斜杠', () => {
    expect(normalizePath('\\\\server\\share\\dir')).toBe('//server/share/dir')
  })

  it('不对大小写做统一（Linux 敏感）', () => {
    expect(normalizePath('/Repo/Web')).toBe('/Repo/Web')
    expect(normalizePath('C:/Users/KUI')).toBe('C:/Users/KUI')
  })

  it('空串保持不变', () => {
    expect(normalizePath('')).toBe('')
  })
})

describe('resolveLcodeHome（22 §2.2）', () => {
  it('LCODE_HOME 覆盖优先', () => {
    expect(resolveLcodeHome({ [LCODE_HOME_ENV]: 'D:\\tmp\\lcode-home', HOME: '/home/x' })).toBe('D:/tmp/lcode-home')
  })

  it('空白 LCODE_HOME 视为未设置', () => {
    expect(resolveLcodeHome({ [LCODE_HOME_ENV]: '   ', HOME: '/home/x' })).toBe('/home/x/.lcode')
  })

  it('POSIX 回落 HOME', () => {
    expect(resolveLcodeHome({ HOME: '/home/x' })).toBe('/home/x/.lcode')
  })

  it('Windows 回落 USERPROFILE', () => {
    expect(resolveLcodeHome({ USERPROFILE: 'C:\\Users\\JIAh' })).toBe('C:/Users/JIAh/.lcode')
  })

  it('都取不到时显式报错（不猜）', () => {
    expect(() => resolveLcodeHome({})).toThrow(/LCODE_HOME/)
  })
})

describe('workspaceBucket（22 §2.1）', () => {
  it('无 cwd 落到 _unknown', () => {
    expect(workspaceBucket(null)).toBe(WORKSPACE_BUCKET_UNKNOWN)
    expect(workspaceBucket(undefined)).toBe(WORKSPACE_BUCKET_UNKNOWN)
    expect(workspaceBucket('')).toBe(WORKSPACE_BUCKET_UNKNOWN)
  })

  it('是 16 位十六进制', () => {
    expect(workspaceBucket('/repo/web')).toMatch(/^[0-9a-f]{16}$/)
    expect(fnv1a64Hex('')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('同一路径的不同写法得到同一桶（分隔符与末尾斜杠无关）', () => {
    const a = workspaceBucket('C:\\repo\\web')
    const b = workspaceBucket('C:/repo/web')
    const c = workspaceBucket('C:/repo/web/')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('不同路径得到不同桶', () => {
    expect(workspaceBucket('/repo/web')).not.toBe(workspaceBucket('/repo/api'))
  })

  it('大小写不同视为不同路径（不在哈希前统一大小写）', () => {
    expect(workspaceBucket('/Repo/Web')).not.toBe(workspaceBucket('/repo/web'))
  })
})

describe('路径助手', () => {
  it('会话日志相对路径形如 sessions/<bucket>/<id>.jsonl', () => {
    const rel = sessionLogRelPath('/repo/web', 'S1')
    expect(rel).toBe(`sessions/${workspaceBucket('/repo/web')}/S1${LOG_EXT}`)
  })

  it('无 cwd 会话落在 _unknown 桶', () => {
    expect(sessionLogRelPath(null, 'S1')).toBe('sessions/_unknown/S1.jsonl')
  })

  it('sessionsRoot / indexDbPath 基于 home', () => {
    expect(sessionsRoot('D:/home/.lcode')).toBe('D:/home/.lcode/sessions')
    expect(indexDbPath('D:/home/.lcode')).toBe('D:/home/.lcode/index.db')
  })

  it('absFromHome 与 relativeToHome 互逆', () => {
    const home = 'D:/home/.lcode'
    const rel = sessionLogRelPath('/repo/web', 'S1')
    const abs = absFromHome(home, rel)
    expect(abs.startsWith(home + '/')).toBe(true)
    expect(relativeToHome(home, abs)).toBe(rel)
  })

  it('relativeToHome 对 Home 之外的路径返回 null', () => {
    expect(relativeToHome('D:/home/.lcode', 'D:/other/x.jsonl')).toBeNull()
    expect(relativeToHome('D:/home/.lcode', 'D:/home/.lcode')).toBe('')
  })
})
