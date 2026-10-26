import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalNetworkAudit } from './network-audit.ts'

let home = ''
afterEach(() => {
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

const entry = (domain: string, decision: 'allowed' | 'denied' = 'allowed') => ({
  sessionId: 's1',
  workspace: 'C:/repo/a',
  tool: 'web_fetch',
  domain,
  decision,
  url: `https://${domain}/`,
})

describe('LocalNetworkAudit', () => {
  it('按时间倒序读取，支持条数上限', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-net-audit-'))
    const service = createLocalNetworkAudit({ home })
    service.append({ ...entry('a.example.com'), at: 1 })
    service.append({ ...entry('b.example.com'), at: 2 })
    service.append({ ...entry('c.example.com'), at: 3 })
    expect(service.list().map((item) => item.domain)).toEqual(['c.example.com', 'b.example.com', 'a.example.com'])
    expect(service.list(2).map((item) => item.domain)).toEqual(['c.example.com', 'b.example.com'])
  })

  it('损坏行被跳过，清空后为空', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-net-audit-'))
    const service = createLocalNetworkAudit({ home })
    service.append({ ...entry('ok.example.com'), at: 1 })
    appendFileSync(join(home, 'network-audit.jsonl'), '{坏\n', 'utf8')
    expect(service.list().map((item) => item.domain)).toEqual(['ok.example.com'])
    service.clear()
    expect(service.list()).toEqual([])
  })

  it('超过大小上限时轮转，旧记录留在 .1', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-net-audit-'))
    const service = createLocalNetworkAudit({ home, maxBytes: 1 })
    service.append({ ...entry('old.example.com'), at: 1 })
    service.append({ ...entry('new.example.com'), at: 2 })
    expect(service.list().map((item) => item.domain)).toEqual(['new.example.com'])
    expect(service.list().length).toBe(1)
  })

  it('文件为空/不存在时返回空数组', () => {
    home = mkdtempSync(join(tmpdir(), 'lcode-net-audit-'))
    writeFileSync(join(home, 'network-audit.jsonl'), '', 'utf8')
    expect(createLocalNetworkAudit({ home }).list()).toEqual([])
  })
})
