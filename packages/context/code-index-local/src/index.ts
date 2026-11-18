import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDatabase } from '@lcode/session-persistence-sqlite'
import type { ToolDefinition } from '@lcode/tools'
import { blobToVector, cosineSimilarity, embedTexts, vectorToBlob, type EmbeddingConfig } from './embeddings.ts'
import { chunkFile, listRepositoryFiles } from './chunk.ts'

const DDL = `
CREATE TABLE IF NOT EXISTS code_index_meta (
  workspace TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS code_index_files (
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (workspace, path)
);
CREATE TABLE IF NOT EXISTS code_index_chunks (
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (workspace, path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace ON code_index_chunks(workspace);
`

// DashScope text-embedding-v4 不同接入点给的批量上限不一致（实测 20 与 10 都出现过）；
// 取 10 兼容最严格的一侧。
const EMBED_BATCH = 10

export interface CodeSearchInput {
  readonly workspace: string
  readonly query: string
  readonly limit: number
  readonly signal?: AbortSignal | undefined
}

export interface CodeSearchHit {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly chunkIndex: number
  readonly score: number
  readonly snippet: string
}

export interface CodeSearchResult {
  readonly query: string
  readonly model: string
  readonly results: readonly CodeSearchHit[]
  /** 空结果时的可执行提示（区分"索引未建"与"没命中"） */
  readonly hint?: string | undefined
}

export interface RebuildReport {
  readonly workspace: string
  readonly model: string
  readonly files: number
  readonly chunks: number
  readonly embeddedFiles: number
  readonly deletedFiles: number
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  readonly truncated: boolean
}

export interface CodeIndexWorkspaceStatus {
  readonly workspace: string
  readonly model: string
  readonly dim: number
  readonly files: number
  readonly chunks: number
  readonly updatedAt: number
}

export interface CodeIndexStatus {
  readonly configured: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly workspaces: readonly CodeIndexWorkspaceStatus[]
  readonly totalFiles: number
  readonly totalChunks: number
}

export interface CodeIndexService {
  rebuild(workspace: string, options?: { readonly signal?: AbortSignal | undefined }): Promise<RebuildReport>
  search(input: CodeSearchInput): Promise<CodeSearchResult>
  status(): Promise<CodeIndexStatus>
  clear(workspace?: string): number
  close(): void
}

export interface CodeIndexOptions {
  /** Lcode Home：数据库固定放在 `<home>/code-index.db` */
  readonly home: string
  /** 每次调用现取：设置页改完模型立刻生效；返回 undefined 表示未配置 */
  readonly resolveEmbedding: () => Promise<{ readonly config: EmbeddingConfig; readonly provider: string } | undefined>
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly batchSize?: number | undefined
}

type Db = ReturnType<typeof openDatabase>

interface MetaRow {
  readonly model: string
  readonly dim: number
  readonly updated_at: number
}

interface FileRow {
  readonly path: string
  readonly mtime_ms: number
  readonly size: number
}

interface ChunkRow {
  readonly path: string
  readonly chunk_index: number
  readonly start_line: number
  readonly end_line: number
  readonly content: string
  readonly vector: Uint8Array
}

/** 工作区键统一成小写盘符 + 正斜杠，避免 Windows 上同一目录出现两条索引。 */
export function workspaceKey(workspace: string): string {
  const absolute = resolve(workspace).replace(/\\/g, '/')
  return process.platform === 'win32' ? absolute.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`) : absolute
}

export function createCodeIndex(options: CodeIndexOptions): CodeIndexService {
  let db: Db | undefined
  const rebuilds = new Map<string, Promise<RebuildReport>>()

  const database = (): Db => {
    if (db !== undefined) return db
    mkdirSync(options.home, { recursive: true })
    const opened = openDatabase(join(options.home, 'code-index.db'))
    opened.pragma('journal_mode = WAL')
    opened.pragma('synchronous = NORMAL')
    opened.exec(DDL)
    db = opened
    return opened
  }

  const requireEmbedding = async (): Promise<{ config: EmbeddingConfig; provider: string }> => {
    const resolved = await options.resolveEmbedding()
    if (resolved === undefined) {
      throw new Error('还没有配置代码索引的 embedding 模型：到「设置 → 模型 → Embedding 模型」选择服务商或自定义接口，并填写模型名')
    }
    return resolved
  }

  const metaOf = (workspace: string): MetaRow | undefined => {
    return database()
      .prepare('SELECT model, dim, updated_at FROM code_index_meta WHERE workspace = ?')
      .get(workspace) as MetaRow | undefined
  }

  const clearWorkspace = (connection: Db, workspace: string): void => {
    connection.prepare('DELETE FROM code_index_chunks WHERE workspace = ?').run(workspace)
    connection.prepare('DELETE FROM code_index_files WHERE workspace = ?').run(workspace)
    connection.prepare('DELETE FROM code_index_meta WHERE workspace = ?').run(workspace)
  }

  const rebuild = async (workspace: string, rebuildOptions: { readonly signal?: AbortSignal | undefined } = {}): Promise<RebuildReport> => {
    const key = workspaceKey(workspace)
    const running = rebuilds.get(key)
    if (running !== undefined) return running
    const run = (async (): Promise<RebuildReport> => {
      const { config } = await requireEmbedding()
      const root = resolve(workspace)
      const connection = database()
      const listed = listRepositoryFiles(root)
      const meta = metaOf(key)
      // 换 embedding 模型后向量不可混用：整个工作区重建
      if (meta !== undefined && meta.model !== config.model) clearWorkspace(connection, key)

      const existing = connection
        .prepare('SELECT path, mtime_ms, size FROM code_index_files WHERE workspace = ?')
        .all(key) as FileRow[]
      const existingByPath = new Map(existing.map((row) => [row.path, row]))
      const current = new Set(listed.files.map((file) => file.path))
      const deleted = existing.filter((row) => !current.has(row.path)).map((row) => row.path)
      const changed = listed.files.filter((file) => {
        const row = existingByPath.get(file.path)
        return row === undefined || row.mtime_ms !== file.mtimeMs || row.size !== file.size
      })
      /*
       * 崩溃/中断可能留下“有 chunks 但没有 file row”的文件（chunks 按批写入，file row 最后写）。
       * 先清掉这些孤儿，否则下次重建插入同一 chunk_index 会撞主键。
       */
      connection.prepare(
        'DELETE FROM code_index_chunks WHERE workspace = ? AND path NOT IN (SELECT path FROM code_index_files WHERE workspace = ?)',
      ).run(key, key)

      const removeFile = connection.prepare('DELETE FROM code_index_chunks WHERE workspace = ? AND path = ?')
      const removeFileRow = connection.prepare('DELETE FROM code_index_files WHERE workspace = ? AND path = ?')
      const deleteOne = connection.transaction((path: string) => {
        removeFile.run(key, path)
        removeFileRow.run(key, path)
      })
      for (const path of deleted) deleteOne(path)

      const insertChunk = connection.prepare(
        'INSERT INTO code_index_chunks (workspace, path, chunk_index, start_line, end_line, content, vector) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      const upsertFile = connection.prepare(
        'INSERT INTO code_index_files (workspace, path, mtime_ms, size) VALUES (?, ?, ?, ?) ON CONFLICT(workspace, path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size',
      )
      const skipped: { path: string; reason: string }[] = []
      let embeddedFiles = 0
      let firstDim = 0
      const batchSize = options.batchSize ?? EMBED_BATCH

      for (const file of changed) {
        if (rebuildOptions.signal?.aborted === true) throw new Error('索引重建已取消')
        // 先清掉这个文件可能残留的旧 chunks（含上次中断的半成品），再写入新向量
        removeFile.run(key, file.path)
        let content: string
        try {
          content = readFileSync(join(root, file.path), 'utf8')
        } catch {
          skipped.push({ path: file.path, reason: '读取失败' })
          continue
        }
        if (content.includes('\0')) {
          upsertFile.run(key, file.path, file.mtimeMs, file.size)
          skipped.push({ path: file.path, reason: '二进制文件' })
          continue
        }
        const chunks = chunkFile(content)
        if (chunks.length === 0) {
          upsertFile.run(key, file.path, file.mtimeMs, file.size)
          continue
        }
        const write = connection.transaction((vectors: readonly number[][], offset: number) => {
          for (let index = 0; index < vectors.length; index += 1) {
            const chunk = chunks[offset + index]
            const vector = vectors[index]
            if (chunk === undefined || vector === undefined) continue
            if (firstDim === 0) firstDim = vector.length
            if (vector.length !== firstDim) throw new Error('Embedding 批次之间的向量维度不一致')
            insertChunk.run(key, file.path, chunk.index, chunk.startLine, chunk.endLine, chunk.content, vectorToBlob(vector))
          }
        })
        for (let offset = 0; offset < chunks.length; offset += batchSize) {
          const batch = chunks.slice(offset, offset + batchSize)
          const vectors = await embedTexts(
            config,
            batch.map((chunk) => `// ${file.path}\n${chunk.content}`),
            rebuildOptions.signal ?? new AbortController().signal,
            options.fetch === undefined ? {} : { fetch: options.fetch },
          )
          write(vectors, offset)
        }
        // 只有整份文件的所有批次都成功后才更新 mtime：中途失败时下次重建会重新嵌入，
        // 不会被当成“已索引”而跳过。
        upsertFile.run(key, file.path, file.mtimeMs, file.size)
        embeddedFiles += 1
      }

      if (firstDim > 0) {
        connection.prepare(
          'INSERT INTO code_index_meta (workspace, model, dim, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace) DO UPDATE SET model = excluded.model, dim = excluded.dim, updated_at = excluded.updated_at',
        ).run(key, config.model, firstDim, Date.now())
      }
      const stored = connection.prepare('SELECT COUNT(*) AS n FROM code_index_chunks WHERE workspace = ?').get(key) as { n: number }
      return {
        workspace: key,
        model: config.model,
        files: listed.files.length,
        chunks: stored.n,
        embeddedFiles,
        deletedFiles: deleted.length,
        skipped,
        truncated: listed.truncated,
      }
    })()
    rebuilds.set(key, run)
    try {
      return await run
    } finally {
      rebuilds.delete(key)
    }
  }

  return {
    rebuild,
    async search(input) {
      const query = input.query.trim()
      if (query === '') throw new Error('query 不能为空')
      const { config } = await requireEmbedding()
      const key = workspaceKey(input.workspace)
      const meta = metaOf(key)
      if (meta === undefined) {
        throw new Error('这个工作区还没有语义索引：到「设置 → 模型 → Embedding 模型」点击「重建索引」')
      }
      if (meta.model !== config.model) {
        throw new Error(`索引使用的 embedding 模型是 ${meta.model}，当前配置是 ${config.model}；请重新建立索引`)
      }
      const signal = input.signal ?? new AbortController().signal
      const [queryVector] = await embedTexts(config, [query], signal, options.fetch === undefined ? {} : { fetch: options.fetch })
      if (queryVector === undefined) throw new Error('Embedding 没有返回查询向量')
      const queryFloat = Float32Array.from(queryVector)
      const rows = database()
        .prepare('SELECT path, chunk_index, start_line, end_line, content, vector FROM code_index_chunks WHERE workspace = ?')
        .all(key) as ChunkRow[]
      const limit = Math.min(50, Math.max(1, Math.trunc(Number.isFinite(input.limit) ? input.limit : 8)))
      const hits = rows
        .map((row) => ({
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          chunkIndex: row.chunk_index,
          score: cosineSimilarity(queryFloat, blobToVector(row.vector)),
          snippet: row.content.length > 2_000 ? `${row.content.slice(0, 2_000)}…` : row.content,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      return { query, model: config.model, results: hits }
    },
    async status() {
      let provider: string | null = null
      let model: string | null = null
      let configured = false
      try {
        const resolved = await options.resolveEmbedding()
        if (resolved !== undefined) {
          configured = true
          provider = resolved.provider
          model = resolved.config.model
        }
      } catch {
        // 凭据缺失等配置问题：状态页只显示未配置，不阻断设置页
      }
      const rows = database()
        .prepare(
          `SELECT m.workspace AS workspace, m.model AS model, m.dim AS dim, m.updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM code_index_files f WHERE f.workspace = m.workspace) AS files,
                  (SELECT COUNT(*) FROM code_index_chunks c WHERE c.workspace = m.workspace) AS chunks
             FROM code_index_meta m ORDER BY m.updated_at DESC`,
        )
        .all() as CodeIndexWorkspaceStatus[]
      const workspaces = rows.map((row) => ({ ...row, workspace: row.workspace }))
      return {
        configured,
        provider,
        model,
        workspaces,
        totalFiles: workspaces.reduce((sum, row) => sum + row.files, 0),
        totalChunks: workspaces.reduce((sum, row) => sum + row.chunks, 0),
      }
    },
    clear(workspace) {
      const connection = database()
      if (workspace !== undefined) {
        clearWorkspace(connection, workspaceKey(workspace))
        return 1
      }
      const rows = connection.prepare('SELECT workspace FROM code_index_meta').all() as { workspace: string }[]
      const clearAll = connection.transaction(() => {
        connection.prepare('DELETE FROM code_index_chunks').run()
        connection.prepare('DELETE FROM code_index_files').run()
        connection.prepare('DELETE FROM code_index_meta').run()
      })
      clearAll()
      return rows.length
    },
    close() {
      if (db !== undefined && db.open) db.close()
      db = undefined
    },
  }
}

export interface CodeSearchToolDeps {
  readonly search: (input: CodeSearchInput) => Promise<CodeSearchResult>
  readonly workspaceOf: (sessionId: string) => string | undefined
  readonly fallbackWorkspace: string
}

interface CodeSearchToolInput {
  readonly query: string
  readonly limit?: number | undefined
}

/** 模型可见的 `code_search`：语义召回，不替代精确的 grep/read。 */
export function createCodeSearchTool(deps: CodeSearchToolDeps): ToolDefinition<CodeSearchToolInput, CodeSearchResult> {
  return {
    name: 'code_search',
    description:
      '按语义搜索仓库代码，直接返回相关代码片段与位置。\n' +
      '**优先用它定位**："哪里实现了登录/限流/重试"、"某功能在哪个文件"、"这个常量定义在哪"。\n' +
      '比盲目 grep 快得多：一次拿到相关片段，不必反复试关键词。\n' +
      '拿到位置后再用 read 精读那几行；确定要精确匹配某个标识符时才用 grep。\n' +
      '需要先在设置里建立索引；返回按相关度排序的片段。',
    card: 'search',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言或代码语义描述' },
        limit: { type: 'number', description: '返回片段数，1-20，默认 8' },
      },
      required: ['query'],
    },
    execute: async (call, opts) => {
      const sessionId = sessionIdOf(opts.scope)
      const workspace = sessionId === undefined ? undefined : deps.workspaceOf(sessionId)
      const root = workspace ?? deps.fallbackWorkspace
      const limit = call.parsed.limit === undefined ? 8 : Math.min(20, Math.max(1, Math.trunc(call.parsed.limit)))
      const result = await deps.search({ workspace: root, query: call.parsed.query, limit, signal: opts.signal })
      /*
       * 空结果要区分两种情况，否则模型会误判成"代码里没有"：
       * - 索引没建 / 索引里没有这个工作区 → 它该去做别的事（grep/glob），并在回答里说明
       * - 索引有但没命中 → 换个说法再搜
       * 这两种后续动作完全不同，混成一个空数组会白耗好几步。
       */
      if (result.results.length === 0) {
        return {
          ...result,
          hint:
            '没有命中。若这个工作区还没建立索引（设置 → 代码索引），本条检索不会返回任何结果，' +
            '此时应改用 grep（已知标识符）或 glob（找文件）继续，并在最终答复里说明索引未建。' +
            '若索引已建，换个更具体的说法或改用 grep 精确匹配。',
        }
      }
      return result
    },
  }
}

function sessionIdOf(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const id = (scope as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}
