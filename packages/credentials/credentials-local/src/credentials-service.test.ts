import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAllIndexDbs, createEmptyIndexDb } from '@lcode/session-persistence-sqlite'
import { LocalCredentialsService, maskedHintOf, parseEnvFile } from './credentials-service.ts'

let home = ''
let cwd = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lcode-cred-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'lcode-cred-cwd-'))
  createEmptyIndexDb(home)
})

afterEach(() => {
  closeAllIndexDbs()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

afterAll(() => {
  closeAllIndexDbs()
})

/** 递归收集对象里所有字符串值（I7 泄露检测用） */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
  return out
}

const SECRET = 'sk-real-secret-value-9f2c'

describe('凭据层序（12 §7.1）', () => {
  it('①凭据记录优先于一切层（write 后 resolve 走记录而非 env）', async () => {
    const svc = new LocalCredentialsService({ home })
    await svc.write('DEEPSEEK_API_KEY', SECRET)
    // 环境里也塞一个同名变量，验证记录层优先
    const saved = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-should-lose'
    try {
      const resolved = await svc.resolve('DEEPSEEK_API_KEY')
      expect(resolved?.value).toBe(SECRET)
      expect(resolved?.source).toBe('keychain') // 冻结取值域：记录层报 'keychain'
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = saved
    }
  })

  it('②项目 .env 先于 ③Home .env', async () => {
    const svc = new LocalCredentialsService({ home })
    writeFileSync(join(home, '.env'), 'MY_TOKEN=from-home\n')
    writeFileSync(join(cwd, '.env'), 'MY_TOKEN=from-project\n')
    const withCwd = await svc.resolve('MY_TOKEN', { cwd })
    expect(withCwd).toEqual({ refName: 'MY_TOKEN', value: 'from-project', source: 'project-env' })
    // 不带 cwd：直接跳到 Home 层
    const noCwd = await svc.resolve('MY_TOKEN')
    expect(noCwd).toEqual({ refName: 'MY_TOKEN', value: 'from-home', source: 'lcode-home-env' })
  })

  it('④进程环境变量受白名单约束（白名单外直接不解析）', async () => {
    process.env.ALLOWED_TOKEN = 'sk-ok'
    process.env.DENIED_TOKEN = 'sk-no'
    try {
      const allowed = new LocalCredentialsService({ home, envAllowlist: ['ALLOWED_TOKEN'] })
      expect((await allowed.resolve('ALLOWED_TOKEN'))?.source).toBe('env')
      expect(await allowed.resolve('DENIED_TOKEN')).toBeUndefined()
      // 无白名单：默认全放行
      const open = new LocalCredentialsService({ home })
      expect((await open.resolve('DENIED_TOKEN'))?.source).toBe('env')
    } finally {
      delete process.env.ALLOWED_TOKEN
      delete process.env.DENIED_TOKEN
    }
  })

  it('全部未命中返回 undefined；require 抛 EL-CREDENTIAL_MISSING', async () => {
    const svc = new LocalCredentialsService({ home })
    expect(await svc.resolve('NOPE_TOKEN')).toBeUndefined()
    await expect(svc.require('NOPE_TOKEN')).rejects.toMatchObject({ code: 'EL-CREDENTIAL_MISSING' })
  })
})

describe('I7：凭据值永不进可序列化对象', () => {
  it('listRefs / describeSource 的返回里没有值', async () => {
    const svc = new LocalCredentialsService({ home })
    await svc.write('LEAK_CHECK_KEY', SECRET)
    const refs = await svc.listRefs()
    expect(refs).toHaveLength(1)
    const strings = collectStrings(refs)
    expect(strings).not.toContain(SECRET)
    // maskedHint 只是遮蔽形态，不是原值
    expect(refs[0]?.maskedHint).toBe(maskedHintOf(SECRET))
    expect(refs[0]?.maskedHint).not.toBe(SECRET)
    // describeSource 只回来源
    expect(await svc.describeSource('LEAK_CHECK_KEY')).toBe('keychain')
  })

  it('describeSource 不算"使用过"（last_used_at 不变）', async () => {
    let tick = 1000
    const svc = new LocalCredentialsService({ home, now: () => tick })
    await svc.write('TOK', SECRET)
    const before = (await svc.listRefs())[0]?.lastUsedAt
    tick = 5000
    await svc.describeSource('TOK')
    const after = (await svc.listRefs())[0]?.lastUsedAt
    expect(after).toBe(before)
    // 而 resolve 要更新
    await svc.resolve('TOK')
    expect((await svc.listRefs())[0]?.lastUsedAt).toBe(5000)
  })
})

describe('每次操作重新解析（D22 / 12 §7.2）', () => {
  it('层内容变化后，下一次 resolve 立即反映（无缓存）', async () => {
    const svc = new LocalCredentialsService({ home })
    expect(await svc.resolve('ROTATING_KEY')).toBeUndefined()
    writeFileSync(join(cwd, '.env'), 'ROTATING_KEY=v1\n')
    expect((await svc.resolve('ROTATING_KEY', { cwd }))?.value).toBe('v1')
    writeFileSync(join(cwd, '.env'), 'ROTATING_KEY=v2\n')
    expect((await svc.resolve('ROTATING_KEY', { cwd }))?.value).toBe('v2')
  })
})

describe('记录管理', () => {
  it('write 后值只落 0600 文件；credentials_refs 行里没有值', async () => {
    const svc = new LocalCredentialsService({ home })
    const { keyId } = await svc.write('LLM_KEY', SECRET)
    expect(keyId).toMatch(/^[0-9a-f]{16}$/)
    // 文件里有值
    const dir = join(home, 'credentials')
    const files = ((): string[] => {
      const out: string[] = []
      const walk = (d: string): void => {
        for (const f of require('node:fs').readdirSync(d)) {
          const fp = join(d, f)
          if (require('node:fs').statSync(fp).isDirectory()) walk(fp)
          else out.push(fp)
        }
      }
      walk(dir)
      return out
    })()
    expect(files).toHaveLength(1)
    expect(readFileSync(files[0]!, 'utf8')).toContain(SECRET)
    // DB 行里没有值
    const refs = await svc.listRefs()
    expect(collectStrings(refs)).not.toContain(SECRET)
  })

  it('keychainAvailable() 如实上报 false；backend 记 file-0600', async () => {
    const svc = new LocalCredentialsService({ home })
    expect(svc.keychainAvailable()).toBe(false)
    const info = (await svc.write('BK_KEY', SECRET)).info
    expect(info.source).toBe('file-0600')
  })

  it('delete 同时删值文件与行；未存在时报 deleted:false', async () => {
    const svc = new LocalCredentialsService({ home })
    await svc.write('GONE_KEY', SECRET)
    expect((await svc.delete('GONE_KEY')).deleted).toBe(true)
    expect(await svc.resolve('GONE_KEY')).toBeUndefined()
    expect(await svc.listRefs()).toEqual([])
    expect((await svc.delete('GONE_KEY')).deleted).toBe(false)
  })

  it('registerEnvRef 只登记引用不落值；listRefs 的 present 跟随环境', async () => {
    const svc = new LocalCredentialsService({ home })
    await svc.registerEnvRef('ENV_ONLY_KEY')
    const refs = await svc.listRefs()
    expect(refs).toHaveLength(1)
    expect(refs[0]?.present).toBe(false) // 环境里还没有
    process.env.ENV_ONLY_KEY = 'sk-now-present'
    try {
      expect((await svc.listRefs())[0]?.present).toBe(true)
    } finally {
      delete process.env.ENV_ONLY_KEY
    }
  })

  it('write 校验引用名形态（非法名拒绝）', async () => {
    const svc = new LocalCredentialsService({ home })
    await expect(svc.write('bad-name', SECRET)).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(svc.write('', SECRET)).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
    await expect(svc.write('OK_NAME', '')).rejects.toMatchObject({ code: 'EC-INVALID_PARAMS' })
  })
})

describe('parseEnvFile（.env 解析）', () => {
  it('键值、引号、注释、export 前缀、坏行跳过', () => {
    expect(
      parseEnvFile([
        '# 注释行',
        '',
        'A=1',
        'B = spaced value ',
        'C="quoted"',
        "D='single'",
        'export E=with-export',
        'no-equals-line',
        '=empty-name',
        'F=', // 空值跳过
      ].join('\n')),
    ).toEqual({ A: '1', B: 'spaced value', C: 'quoted', D: 'single', E: 'with-export' })
  })
})
