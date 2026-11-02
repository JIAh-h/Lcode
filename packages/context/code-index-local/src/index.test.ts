import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodeIndex, createCodeSearchTool, workspaceKey, type CodeIndexService } from './index.ts'

const WORDS = ['login', 'database', 'style', 'render', 'cache']
let home = ''
let workspace = ''
let service: CodeIndexService | null = null

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase()
  return WORDS.map((word) => (lower.includes(word) ? 1 : 0))
}

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { input?: unknown } : {}
  const inputs = Array.isArray(body.input) ? body.input.filter((item): item is string => typeof item === 'string') : []
  expect(String(input)).toContain('/embeddings')
  return Promise.resolve(new Response(JSON.stringify({
    data: inputs.map((text, index) => ({ index, embedding: fakeVector(text) })),
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

function setup(): CodeIndexService {
  home = mkdtempSync(join(tmpdir(), 'lcode-code-index-'))
  workspace = join(home, 'repo')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'auth.ts'), 'export function login(user: string) {\n  return database.find(user)\n}\n')
  writeFileSync(join(workspace, 'src', 'styles.css'), '.button { color: red; }\n.user-login { font-weight: 600; }\n')
  writeFileSync(join(workspace, 'README.md'), '# Demo\n\nA tiny project.\n')
  service = createCodeIndex({
    home,
    resolveEmbedding: async () => ({ provider: 'fake', config: { baseUrl: 'http://fake/v1', model: 'embed-v1' } }),
    fetch: fakeFetch as typeof globalThis.fetch,
  })
  return service
}

afterEach(() => {
  service?.close()
  service = null
  if (home !== '') rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('code-index-local', () => {
  it('建立索引并按余弦相似度返回代码片段', async () => {
    const index = setup()
    const report = await index.rebuild(workspace)
    expect(report.files).toBe(3)
    expect(report.chunks).toBeGreaterThan(0)
    expect(report.model).toBe('embed-v1')

    const result = await index.search({ workspace, query: 'login database code', limit: 3 })
    expect(result.results[0]?.path).toBe('src/auth.ts')
    expect(result.results[0]?.snippet).toContain('login')

    const status = await index.status()
    expect(status.configured).toBe(true)
    expect(status.workspaces[0]).toMatchObject({ workspace: workspaceKey(workspace), files: 3, model: 'embed-v1' })
  })

  it('按 mtime 增量：只重嵌变化的文件，并删除已消失文件', async () => {
    const index = setup()
    await index.rebuild(workspace)
    const first = await index.search({ workspace, query: 'login', limit: 5 })
    expect(first.results.some((hit) => hit.path === 'src/auth.ts')).toBe(true)

    writeFileSync(join(workspace, 'src', 'auth.ts'), 'export function login(user: string) {\n  return database.find(user)\n}\nexport const changed = true\n')
    rmSync(join(workspace, 'src', 'styles.css'))
    writeFileSync(join(workspace, 'src', 'new.ts'), 'export function cache() { return 1 }\n')

    const report = await index.rebuild(workspace)
    expect(report.deletedFiles).toBe(1)
    expect(report.embeddedFiles).toBe(2) // 修改的 auth.ts + 新增的 new.ts

    const hits = await index.search({ workspace, query: 'cache', limit: 5 })
    expect(hits.results[0]?.path).toBe('src/new.ts')
    const auth = await index.search({ workspace, query: 'login', limit: 5 })
    expect(auth.results.some((hit) => hit.path === 'src/styles.css')).toBe(false)
  })

  it('换 embedding 模型会整库重建，模型不一致时拒绝搜索', async () => {
    const index = setup()
    await index.rebuild(workspace)
    const switched = createCodeIndex({
      home,
      resolveEmbedding: async () => ({ provider: 'fake', config: { baseUrl: 'http://fake/v1', model: 'embed-v2' } }),
      fetch: fakeFetch as typeof globalThis.fetch,
    })
    service = switched
    index.close()
    // 直接改模型后不重建：搜索应明确要求重建
    await expect(switched.search({ workspace, query: 'login', limit: 3 })).rejects.toThrow('重新建立索引')
    const report = await switched.rebuild(workspace)
    expect(report.embeddedFiles).toBe(report.files)
    expect((await switched.status()).model).toBe('embed-v2')
  })

  it('大文件跨多个 embedding 批次也不会重复主键', async () => {
    const index = createCodeIndex({
      home: mkdtempSync(join(tmpdir(), 'lcode-code-index-batch-')),
      resolveEmbedding: async () => ({ provider: 'fake', config: { baseUrl: 'http://fake/v1', model: 'embed-v1' } }),
      fetch: fakeFetch as typeof globalThis.fetch,
      batchSize: 2,
    })
    service = index
    const big = join(tmpdir(), `lcode-big-${Date.now()}`)
    mkdirSync(big, { recursive: true })
    const lines = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}`)
    writeFileSync(join(big, 'big.ts'), lines.join('\n'))
    const report = await index.rebuild(big)
    expect(report.chunks).toBeGreaterThan(2)
    const hits = await index.search({ workspace: big, query: 'value 200', limit: 3 })
    expect(hits.results.length).toBeGreaterThan(0)
    rmSync(big, { recursive: true, force: true })
  })

  it('code_search 工具按会话工作区检索并限制返回条数', async () => {
    const calls: { workspace: string; query: string; limit: number }[] = []
    const tool = createCodeSearchTool({
      search: async (input) => {
        calls.push({ workspace: input.workspace, query: input.query, limit: input.limit })
        return { query: input.query, model: 'embed-v1', results: [] }
      },
      workspaceOf: (sessionId) => (sessionId === 's1' ? '/repo/web' : undefined),
      fallbackWorkspace: '/repo/fallback',
    })
    const result = await tool.execute(
      { callId: 'c1', name: 'code_search', arguments: '{"query":"login","limit":99}', parsed: { query: 'login', limit: 99 } },
      { signal: new AbortController().signal, scope: { sessionId: 's1' } },
    )
    expect(calls[0]).toEqual({ workspace: '/repo/web', query: 'login', limit: 20 })
    expect(result.results).toEqual([])
  })

  it('未配置时给出可操作错误；清除索引后搜索不可用', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'lcode-code-index-empty-'))
    const emptyRoot = join(emptyHome, 'repo')
    mkdirSync(emptyRoot, { recursive: true })
    const unconfigured = createCodeIndex({
      home: emptyHome,
      resolveEmbedding: async () => undefined,
    })
    await expect(unconfigured.rebuild(emptyRoot)).rejects.toThrow('还没有配置代码索引')
    unconfigured.close()
    rmSync(emptyHome, { recursive: true, force: true })

    const index = setup()
    await index.rebuild(workspace)
    expect(index.clear()).toBe(1)
    await expect(index.search({ workspace, query: 'login', limit: 3 })).rejects.toThrow('还没有语义索引')
  })
})
